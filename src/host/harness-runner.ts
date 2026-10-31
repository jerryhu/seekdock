import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import {
	sameModelSelection,
	type ModelSelection,
} from '../shared/model-selection.ts';
import type { PermissionCatalog } from '../shared/rpc.ts';
import { isRecord } from '../shared/value-validation.ts';
import {
	isWorkspaceChangesSummary,
	isWorkspaceFileDiff,
	type WorkspaceChangeSet,
	type WorkspaceChangesSummary,
	type WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import {
	HarnessEventTranslator,
	type HarnessActivityEvent,
} from './harness-events.ts';

interface HarnessRunnerOptions {
	cwd: string;
	dshHome: string;
	homePath: string;
	patchPath: string;
	/** Generated patch containing enabled MCP client rows. */
	mcpPatchPath: string;
	/** Secret-valued environment entries referenced by the MCP patch. */
	mcpEnv: Readonly<Record<string, string>>;
	systemPromptPath: string;
	runtimeLauncherPath: string;
	runtimePath: string;
	/** Socket the runtime's approval bridge connects to. */
	approvalSocketPath: string;
	/** Socket the runtime's plan-review bridge connects to. */
	planReviewSocketPath: string;
	/** Current composer model route, read whenever a runtime is created. */
	modelSelection: () => ModelSelection;
}

interface AskOptions {
	/** Restore a persisted session before prompting it. */
	resume?: boolean;
}

interface BridgeRequest<T> {
	socketPath: string;
	payload: Record<string, unknown>;
	label: string;
	parse: (value: unknown) => T | undefined;
	invalidResponseMessage: string;
	timeoutMs?: number;
}

export interface AskResult {
	/** Final visible text committed by DSH for this turn. */
	answer: string;
	/** Whether the turn ended because the user stopped it. */
	interrupted: boolean;
}

/** One user-invocable skill reported by the DSH registry. */
export interface RuntimeSkillSummary {
	name: string;
	description: string;
	source: string;
	modelInvocable: boolean;
	path?: string;
}

/** A selected skill with its current instruction file body. */
export interface RuntimeSkillDefinition extends RuntimeSkillSummary {
	content: string;
}

/**
 * Owns one DSH runtime subprocess and runs answer turns on named sessions.
 */
export class HarnessRunner {
	private activeSessionId: string | undefined;
	private activeApiKey: string | undefined;
	private activeModelSelection: ModelSelection | undefined;
	private cancelInFlight: Promise<boolean> | undefined;
	private cancelRequested = false;
	private harness: DeepSeekHarness | undefined;
	private readonly liveSessions = new Set<string>();
	private readonly cancelSocketPath = createRuntimeSocketPath('cancel');
	private readonly permissionSocketPath = createRuntimeSocketPath('permission');
	private readonly skillSocketPath = createRuntimeSocketPath('skill');
	private readonly sessionTitleSocketPath = createRuntimeSocketPath('session-title');
	private readonly planSocketPath = createRuntimeSocketPath('plan');
	private readonly workspaceChangesSocketPath = createRuntimeSocketPath('workspace-changes');
	private running = false;

	constructor(private readonly options: HarnessRunnerOptions) { }

	get busy(): boolean {
		return this.running;
	}

	/**
	 * Answer one prompt on a DSH session. Reusing the id resumes its persisted
	 * history inside DSH rather than reconstructing conversation state here.
	 *
	 * @param sessionId - DSH session to create or resume.
	 * @param prompt - User question.
	 * @param apiKey - DeepSeek API key read from VS Code SecretStorage.
	 * @param onEvent - Observer for text, tool, and approval activity.
	 * @param options - Resume behavior for a persisted session.
	 * @returns the final assistant response and whether the user stopped it.
	 */
	async ask(
		sessionId: string,
		prompt: string,
		apiKey: string,
		onEvent: (event: HarnessActivityEvent) => void = () => { },
		options: AskOptions = {},
	): Promise<AskResult> {
		if (this.running) {
			throw new Error('SeekDock is still waiting for the previous answer.');
		}
		this.running = true;
		this.activeSessionId = sessionId;
		this.cancelInFlight = undefined;
		this.cancelRequested = false;
		try {
			const harness = await this.ensureHarness(apiKey);
			await this.makeSessionLive(harness, sessionId, options.resume === true);
			const translator = new HarnessEventTranslator(sessionId);
			let turnError: string | undefined;
			let receivedVisibleContent = false;
			let interrupted = false;
			const result = await harness.run(prompt, {
				sessionId,
				onNotification: (notification) => {
					if (this.cancelRequested && this.cancelInFlight === undefined) {
						this.cancelInFlight = requestCancellation(this.cancelSocketPath, sessionId, 5_000)
							.then((result) => {
								interrupted ||= result.interrupted;
								if (result.interrupted) {
									this.cancelRequested = false;
								}
								return result.interrupted;
							})
							.catch((error) => {
								console.error('SeekDock: pending stop request failed', error);
								return false;
							})
							.finally(() => {
								this.cancelInFlight = undefined;
							});
					}
					for (const event of translator.translate(notification)) {
						if (event.type === 'turnError') {
							turnError = event.message;
						} else {
							if (event.type === 'assistantMessage' && event.interrupted === true) {
								interrupted = true;
							}
							if (event.type === 'assistantStreamDelta') {
								receivedVisibleContent ||= event.delta.text.trim().length > 0;
							} else if (event.type === 'assistantMessage') {
								receivedVisibleContent ||= event.blocks.some(
									block => block.text.trim().length > 0,
								);
							}
							onEvent(event);
						}
					}
				},
			});
			const answer = result.finalResponse.trim();
			if (answer.length === 0 && !receivedVisibleContent && !interrupted) {
				throw new Error(turnError ?? 'DeepSeek returned no text answer.');
			}
			this.liveSessions.add(sessionId);
			return { answer, interrupted };
		} catch (error) {
			try {
				await this.reset();
			} catch (cleanupError) {
				console.error('SeekDock: failed to clean up the DeepSeek Harness runtime', cleanupError);
			}
			throw error;
		} finally {
			this.running = false;
			this.activeSessionId = undefined;
			this.cancelInFlight = undefined;
			this.cancelRequested = false;
		}
	}

	/**
	 * Request that DSH stop the active root-agent turn. The request waits only
	 * for cancellation admission; the existing run settles through DSH's
	 * normal aborted-turn persistence path.
	 *
	 * @returns whether the stop was accepted immediately or queued until the
	 * prompt reaches the live Agent.
	 */
	async cancel(): Promise<boolean> {
		const sessionId = this.activeSessionId;
		const harness = this.harness;
		if (!this.running || sessionId === undefined) {
			return false;
		}
		if (harness === undefined) {
			this.cancelRequested = true;
			return true;
		}
		const result = await requestCancellation(this.cancelSocketPath, sessionId, 5_000);
		if (!result.accepted || !result.interrupted) {
			// The prompt may not have reached the Agent yet. Re-issue the stop on
			// the first notification instead of letting this click become an idle no-op.
			this.cancelRequested = true;
		}
		return true;
	}

	/**
	 * Start the runtime and complete its initialization handshake without
	 * creating a session or sending a model request.
	 *
	 * @param apiKey - DeepSeek API key used by the runtime process.
	 * @returns after the runtime profile and model route are ready.
	 */
	async warmUp(apiKey: string): Promise<void> {
		if (this.running) {
			throw new Error('SeekDock is still waiting for the previous answer.');
		}
		try {
			const harness = await this.ensureHarness(apiKey);
			await harness.start();
		} catch (error) {
			try {
				await this.reset();
			} catch (cleanupError) {
				console.error('SeekDock: failed to clean up the DeepSeek Harness runtime', cleanupError);
			}
			throw error;
		}
	}

	/** Close the current runtime so the next turn uses a changed API key. */
	async invalidate(): Promise<void> {
		if (this.running) {
			throw new Error('The API key cannot be changed while SeekDock is answering.');
		}
		await this.reset();
	}

	/** Reap the runtime subprocess. */
	async dispose(): Promise<void> {
		await this.reset();
	}

	/** @returns whether a runtime process is currently attached. */
	isRuntimeReady(): boolean {
		return this.harness !== undefined;
	}

	/** @returns whether DSH currently holds this session open. */
	isSessionLive(sessionId: string): boolean {
		return this.liveSessions.has(sessionId);
	}

	/**
	 * Make one session live without sending a prompt. Permission presets can
	 * only be read and switched on a live DSH session, so the composer prepares
	 * a session before its first message.
	 *
	 * @param sessionId - session to create or resume.
	 * @param options - whether the id refers to persisted history.
	 */
	async prepareSession(sessionId: string, options: AskOptions = {}): Promise<void> {
		const harness = this.harness;
		if (harness === undefined) {
			throw new Error('DeepSeek Harness runtime is not ready.');
		}
		await this.makeSessionLive(harness, sessionId, options.resume === true);
	}

	/**
	 * Rename one live session through DSH's log-backed title service.
	 *
	 * @param sessionId - live session to rename.
	 * @param title - raw user title; DSH normalizes and persists it.
	 * @returns the accepted title after its durability barrier.
	 */
	async renameSession(sessionId: string, title: string): Promise<string> {
		const response = await this.sessionTitleRequest({ sessionId, title });
		if (!response.ok || response.title === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness rejected the session rename.');
		}
		return response.title;
	}

	/**
	 * Wait for an automatic title provider request already in flight, then
	 * drain its persistence barrier so the next history projection sees it.
	 *
	 * @param sessionId - live session whose automatic title may still be settling.
	 * @returns the accepted title, or undefined when the session has none.
	 */
	async waitForSessionTitle(sessionId: string): Promise<string | undefined> {
		const response = await this.sessionTitleRequest(
			{ action: 'wait', sessionId },
			70_000,
		);
		if (!response.ok) {
			throw new Error(response.message ?? 'DeepSeek Harness failed to wait for the session title.');
		}
		return response.title;
	}

	/** @returns DSH's process-level permission catalog. */
	async permissionCatalog(): Promise<PermissionCatalog> {
		const response = await this.permissionRequest({ action: 'catalog' });
		if (!response.ok || response.catalog === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness returned no permission catalog.');
		}
		return response.catalog;
	}

	/**
	 * Read one live session's permission selection.
	 *
	 * @param sessionId - live session to read.
	 * @returns the catalog and the current preset when DSH has the session open.
	 */
	async permissionState(
		sessionId: string,
	): Promise<{ catalog: PermissionCatalog; current?: string }> {
		const response = await this.permissionRequest({ action: 'state', sessionId });
		if (response.catalog === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness returned no permission catalog.');
		}
		if (!response.ok) {
			// A session that is not live yet still has a usable catalog; the
			// caller shows the configured default until the session exists.
			return { catalog: response.catalog };
		}
		return {
			catalog: response.catalog,
			...(response.current === undefined ? {} : { current: response.current }),
		};
	}

	/**
	 * Switch one live session's permission preset through DSH's service.
	 *
	 * @param sessionId - live session to change.
	 * @param preset - preset value from the catalog.
	 * @returns the confirmed current preset.
	 */
	async setPermission(sessionId: string, preset: string): Promise<string> {
		const response = await this.permissionRequest({ action: 'set', sessionId, preset });
		if (!response.ok || response.current === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness rejected the permission change.');
		}
		return response.current;
	}

	/**
	 * Read plan mode through DSH's process-local plan service.
	 *
	 * @param sessionId - live session to read.
	 * @returns the logged state and an optional pending selection.
	 */
	async planModeState(
		sessionId: string,
	): Promise<{ active: boolean; pending?: boolean }> {
		const response = await this.planModeRequest({ action: 'state', sessionId });
		if (!response.ok || response.active === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness returned no plan-mode state.');
		}
		return {
			active: response.active,
			...(response.pending === undefined ? {} : { pending: response.pending }),
		};
	}

	/**
	 * Select plan mode through DSH's plan service.
	 *
	 * @param sessionId - live session to change.
	 * @param active - whether plan mode should be active.
	 * @returns the state confirmed by DSH after the selection.
	 */
	async setPlanMode(
		sessionId: string,
		active: boolean,
	): Promise<{ active: boolean; pending?: boolean }> {
		const response = await this.planModeRequest({ action: 'set', sessionId, active });
		if (!response.ok || response.active === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness rejected the plan-mode change.');
		}
		return {
			active: response.active,
			...(response.pending === undefined ? {} : { pending: response.pending }),
		};
	}

	/**
	 * Read the live changed-file summary announced by one workspace event.
	 *
	 * @param sessionId - session that appended the event.
	 * @param seq - workspace/changes event sequence.
	 * @returns the validated summary, or undefined once DSH no longer serves it.
	 */
	async workspaceChanges(
		sessionId: string,
		seq: number,
	): Promise<WorkspaceChangeSet | undefined> {
		const response = await this.workspaceChangesRequest({ action: 'summary', sessionId, seq });
		if (!response.ok || response.summary === undefined) {
			return undefined;
		}
		return {
			sessionId,
			seq,
			...response.summary,
		};
	}

	/**
	 * Read one changed file's live turn-start/turn-end comparison.
	 *
	 * @param sessionId - session that appended the event.
	 * @param seq - workspace/changes event sequence.
	 * @param index - file index in the announced summary.
	 * @returns the comparison, or undefined once DSH no longer serves it.
	 */
	async workspaceFileDiff(
		sessionId: string,
		seq: number,
		index: number,
	): Promise<WorkspaceFileDiff | undefined> {
		const response = await this.workspaceChangesRequest({
			action: 'diff',
			sessionId,
			seq,
			index,
		});
		return response.ok ? response.diff : undefined;
	}

	/**
	 * Read the user-invocable skill catalog from DSH's registry.
	 *
	 * @returns skill metadata without loading instruction bodies.
	 */
	async skillCatalog(): Promise<RuntimeSkillSummary[]> {
		const response = await this.skillRequest({ action: 'list', cwd: this.options.cwd });
		if (!response.ok || response.skills === undefined) {
			throw new Error(response.message ?? 'DeepSeek Harness returned no skill catalog.');
		}
		return response.skills;
	}

	/**
	 * Resolve one skill to its current instruction file and content.
	 *
	 * @param name - exact DSH skill name.
	 * @returns the selected skill definition.
	 */
	async skillDefinition(name: string): Promise<RuntimeSkillDefinition> {
		const response = await this.skillRequest({ action: 'get', name, cwd: this.options.cwd });
		if (!response.ok || response.skill === undefined) {
			throw new Error(response.message ?? `Skill not found: ${name}`);
		}
		return response.skill;
	}

	private async permissionRequest(
		payload: Record<string, unknown>,
	): Promise<PermissionBridgeResponse> {
		return this.requestBridge({
			socketPath: this.permissionSocketPath,
			payload,
			label: 'permission',
			parse: parsePermissionResponse,
			invalidResponseMessage: 'DeepSeek Harness returned an invalid permission response.',
		});
	}

	private async planModeRequest(
		payload: Record<string, unknown>,
	): Promise<PlanModeBridgeResponse> {
		return this.requestBridge({
			socketPath: this.planSocketPath,
			payload,
			label: 'plan-mode',
			parse: parsePlanModeResponse,
			invalidResponseMessage: 'DeepSeek Harness returned an invalid plan-mode response.',
		});
	}

	private async skillRequest(
		payload: Record<string, unknown>,
	): Promise<SkillBridgeResponse> {
		return this.requestBridge({
			socketPath: this.skillSocketPath,
			payload,
			label: 'skill',
			parse: parseSkillResponse,
			invalidResponseMessage: 'DeepSeek Harness returned an invalid skill response.',
		});
	}

	private async sessionTitleRequest(
		payload: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<SessionTitleBridgeResponse> {
		return this.requestBridge({
			socketPath: this.sessionTitleSocketPath,
			payload,
			label: 'session-title',
			parse: parseSessionTitleResponse,
			invalidResponseMessage: 'DeepSeek Harness returned an invalid session-title response.',
			timeoutMs,
		});
	}

	private async workspaceChangesRequest(
		payload: Record<string, unknown>,
	): Promise<WorkspaceChangesBridgeResponse> {
		return this.requestBridge({
			socketPath: this.workspaceChangesSocketPath,
			payload,
			label: 'workspace-changes',
			parse: parseWorkspaceChangesResponse,
			invalidResponseMessage: 'DeepSeek Harness returned an invalid workspace-changes response.',
			timeoutMs: 15_000,
		});
	}

	private async requestBridge<T>(request: BridgeRequest<T>): Promise<T> {
		// A bridge response is untrusted at this boundary. Parse it before any
		// caller reads fields that TypeScript cannot verify at runtime.
		const response = await requestControl(
			request.socketPath,
			request.payload,
			request.timeoutMs ?? 5_000,
			request.label,
		);
		const parsed = request.parse(response);
		if (parsed === undefined) {
			throw new Error(request.invalidResponseMessage);
		}
		return parsed;
	}

	private async ensureHarness(apiKey: string): Promise<DeepSeekHarness> {
		const selection = this.options.modelSelection();
		if (this.harness !== undefined
			&& this.activeApiKey === apiKey
			&& this.activeModelSelection !== undefined
			&& sameModelSelection(this.activeModelSelection, selection)) {
			return this.harness;
		}
		await this.reset();
		await mkdir(this.options.dshHome, { recursive: true });
		await mkdir(this.options.homePath, { recursive: true });
		const agentsHome = join(homedir(), '.agents');
		this.harness = new DeepSeekHarness({
			cwd: this.options.cwd,
			dshBin: this.options.runtimeLauncherPath,
			dshHome: this.options.dshHome,
			env: {
				...process.env,
				DEEPSEEK_API_KEY: apiKey,
				DSH_AGENTS_HOME: agentsHome,
				HOME: this.options.homePath,
				SEEKDOCK_CANCEL_SOCKET: this.cancelSocketPath,
				SEEKDOCK_APPROVAL_SOCKET: this.options.approvalSocketPath,
				SEEKDOCK_PLAN_REVIEW_SOCKET: this.options.planReviewSocketPath,
				SEEKDOCK_DSH_RUNTIME: this.options.runtimePath,
				SEEKDOCK_PERMISSION_SOCKET: this.permissionSocketPath,
				SEEKDOCK_PLAN_SOCKET: this.planSocketPath,
				SEEKDOCK_SKILL_SOCKET: this.skillSocketPath,
				SEEKDOCK_SESSION_TITLE_SOCKET: this.sessionTitleSocketPath,
				SEEKDOCK_WORKSPACE_CHANGES_SOCKET: this.workspaceChangesSocketPath,
				SEEKDOCK_SYSTEM_PROMPT_PATH: this.options.systemPromptPath,
				SEEKDOCK_USER_SKILL_DIR: join(agentsHome, 'skills'),
				SEEKDOCK_WORKSPACE_SKILL_DIR: join(resolve(this.options.cwd), '.agents', 'skills'),
				...this.options.mcpEnv,
				USERPROFILE: this.options.homePath,
			},
			initializeTimeoutMs: 30_000,
			patches: [this.options.patchPath, this.options.mcpPatchPath],
			profile: 'sdk',
			provider: 'deepseek-official',
			model: selection.model,
			reasoningEffort: ReasoningEffortId(selection.reasoningEffort),
			shutdownTimeoutMs: 3_000,
		});
		this.activeApiKey = apiKey;
		this.activeModelSelection = selection;
		return this.harness;
	}

	private async makeSessionLive(
		harness: DeepSeekHarness,
		sessionId: string,
		resume: boolean,
	): Promise<void> {
		if (this.liveSessions.has(sessionId)) {
			return;
		}
		await harness.start();
		if (!resume) {
			// Working-directory access creates an unknown session without
			// starting a model turn, which lets the picker switch its preset
			// before the first prompt.
			await harness.session(sessionId).getWorkingDirectory();
		} else {
			try {
				await harness.resumeSession(sessionId);
			} catch (error) {
				if (isMissingSessionError(error)) {
					await harness.session(sessionId).getWorkingDirectory();
				} else if (!isAlreadyOpenError(error)) {
					throw error;
				}
			}
		}
		this.liveSessions.add(sessionId);
	}

	private async reset(): Promise<void> {
		const harness = this.harness;
		this.harness = undefined;
		this.activeApiKey = undefined;
		this.activeModelSelection = undefined;
		this.liveSessions.clear();
		if (harness !== undefined) {
			await harness.close();
		}
	}
}

/** Create the id used for a new SeekDock conversation. */
export function createSessionId(): string {
	return `seekdock-${randomUUID()}`;
}

function isAlreadyOpenError(error: unknown): boolean {
	return readErrorMessage(error).includes('already open');
}

function isMissingSessionError(error: unknown): boolean {
	return readErrorMessage(error).includes('not found');
}

function readErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface PermissionBridgeResponse {
	ok: boolean;
	catalog?: PermissionCatalog;
	current?: string;
	code?: string;
	message?: string;
}

interface PlanModeBridgeResponse {
	ok: boolean;
	active?: boolean;
	pending?: boolean;
	code?: string;
	message?: string;
}

interface SkillBridgeResponse {
	ok: boolean;
	skills?: RuntimeSkillSummary[];
	skill?: RuntimeSkillDefinition;
	code?: string;
	message?: string;
}

interface SessionTitleBridgeResponse {
	ok: boolean;
	title?: string;
	code?: string;
	message?: string;
}

interface WorkspaceChangesBridgeResponse {
	ok: boolean;
	summary?: WorkspaceChangesSummary;
	diff?: WorkspaceFileDiff;
	code?: string;
	message?: string;
}

function parsePermissionResponse(value: unknown): PermissionBridgeResponse | undefined {
	if (!isRecord(value) || typeof value.ok !== 'boolean') {
		return undefined;
	}
	const catalog = value.catalog;
	if (catalog !== undefined && !isPermissionCatalog(catalog)) {
		return undefined;
	}
	return {
		ok: value.ok,
		...(catalog === undefined ? {} : { catalog }),
		...(typeof value.current === 'string' ? { current: value.current } : {}),
		...(typeof value.code === 'string' ? { code: value.code } : {}),
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	};
}

function parsePlanModeResponse(value: unknown): PlanModeBridgeResponse | undefined {
	if (!isRecord(value) || typeof value.ok !== 'boolean') {
		return undefined;
	}
	if (value.active !== undefined && typeof value.active !== 'boolean') {
		return undefined;
	}
	if (value.pending !== undefined && typeof value.pending !== 'boolean') {
		return undefined;
	}
	return {
		ok: value.ok,
		...(typeof value.active === 'boolean' ? { active: value.active } : {}),
		...(typeof value.pending === 'boolean' ? { pending: value.pending } : {}),
		...(typeof value.code === 'string' ? { code: value.code } : {}),
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	};
}

function parseSkillResponse(value: unknown): SkillBridgeResponse | undefined {
	if (!isRecord(value) || typeof value.ok !== 'boolean') {
		return undefined;
	}
	if (value.skills !== undefined) {
		if (!Array.isArray(value.skills) || !value.skills.every(isRuntimeSkillSummary)) {
			return undefined;
		}
		return {
			ok: value.ok,
			skills: value.skills,
			...(typeof value.code === 'string' ? { code: value.code } : {}),
			...(typeof value.message === 'string' ? { message: value.message } : {}),
		};
	}
	if (value.skill !== undefined) {
		if (!isRuntimeSkillDefinition(value.skill)) {
			return undefined;
		}
		return {
			ok: value.ok,
			skill: value.skill,
			...(typeof value.code === 'string' ? { code: value.code } : {}),
			...(typeof value.message === 'string' ? { message: value.message } : {}),
		};
	}
	return {
		ok: value.ok,
		...(typeof value.code === 'string' ? { code: value.code } : {}),
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	};
}

function parseSessionTitleResponse(value: unknown): SessionTitleBridgeResponse | undefined {
	if (!isRecord(value) || typeof value.ok !== 'boolean') {
		return undefined;
	}
	if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length === 0)) {
		return undefined;
	}
	return {
		ok: value.ok,
		...(typeof value.title === 'string' ? { title: value.title } : {}),
		...(typeof value.code === 'string' ? { code: value.code } : {}),
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	};
}

function parseWorkspaceChangesResponse(
	value: unknown,
): WorkspaceChangesBridgeResponse | undefined {
	if (!isRecord(value) || typeof value.ok !== 'boolean') {
		return undefined;
	}
	if (value.summary !== undefined && !isWorkspaceChangesSummary(value.summary)) {
		return undefined;
	}
	if (value.diff !== undefined && !isWorkspaceFileDiff(value.diff)) {
		return undefined;
	}
	return {
		ok: value.ok,
		...(value.summary === undefined ? {} : { summary: value.summary }),
		...(value.diff === undefined ? {} : { diff: value.diff }),
		...(typeof value.code === 'string' ? { code: value.code } : {}),
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	};
}

function isRuntimeSkillSummary(value: unknown): value is RuntimeSkillSummary {
	return isRecord(value)
		&& typeof value.name === 'string'
		&& value.name.length > 0
		&& typeof value.description === 'string'
		&& typeof value.source === 'string'
		&& typeof value.modelInvocable === 'boolean'
		&& (value.path === undefined || typeof value.path === 'string');
}

function isRuntimeSkillDefinition(value: unknown): value is RuntimeSkillDefinition {
	return isRecord(value)
		&& typeof value.content === 'string'
		&& isRuntimeSkillSummary(value);
}

function isPermissionCatalog(value: unknown): value is PermissionCatalog {
	if (!isRecord(value)
		|| !Array.isArray(value.options)
		|| !Array.isArray(value.defaultOptions)
		|| typeof value.defaultPreset !== 'string') {
		return false;
	}
	const isOption = (option: unknown): boolean => isRecord(option)
		&& typeof option.value === 'string'
		&& option.value.length > 0
		&& typeof option.name === 'string'
		&& (option.description === undefined || typeof option.description === 'string');
	return value.options.every(isOption)
		&& value.defaultOptions.every(isOption)
		&& value.defaultPreset.length > 0;
}

/** Send one JSON line to a private runtime socket and read one JSON line back. */
function requestControl(
	socketPath: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
	label: string,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) {
				reject(error);
				return;
			}
			try {
				resolve(JSON.parse(response));
			} catch (parseError) {
				reject(new Error(`DeepSeek Harness returned an invalid ${label} response.`, {
					cause: parseError,
				}));
			}
		};
		const timer = setTimeout(() => {
			finish(new Error(`DeepSeek Harness did not answer the ${label} request in time.`));
		}, timeoutMs);
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.end(`${JSON.stringify(payload)}\n`);
		});
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', error => finish(error));
		socket.once('end', () => finish());
	});
}

function requestCancellation(
	socketPath: string,
	sessionId: string,
	timeoutMs: number,
): Promise<{ accepted: boolean; interrupted: boolean }> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) {
				reject(error);
				return;
			}
			try {
				const result: unknown = JSON.parse(response);
				if (!isRecord(result) || typeof result.accepted !== 'boolean') {
					reject(new Error('DeepSeek Harness returned an invalid stop response.'));
					return;
				}
				resolve({
					accepted: result.accepted,
					interrupted: result.interrupted === true,
				});
			} catch (parseError) {
				reject(new Error('DeepSeek Harness returned an invalid stop response.', {
					cause: parseError,
				}));
			}
		};
		const timer = setTimeout(() => {
			finish(new Error('DeepSeek Harness did not answer the stop request in time.'));
		}, timeoutMs);
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.end(`${JSON.stringify({ sessionId })}\n`);
		});
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', error => finish(error));
		socket.once('end', () => finish());
	});
}

/** Create one private control socket per runtime capability. */
function createRuntimeSocketPath(name: string): string {
	const unique = randomUUID();
	return process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-${name}-${process.pid}-${unique}`
		: join(tmpdir(), `seekdock-${name}-${process.pid}-${unique.slice(0, 12)}.sock`);
}
