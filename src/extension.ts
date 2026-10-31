import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import {
	ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalQuestion,
} from './host/approval-broker.ts';
import {
	PlanReviewBroker,
	type PlanReviewQuestion,
	type PlanReviewVerdict,
} from './host/plan-review-broker.ts';
import { DATA_ROOT_ENV, resolveDataRoot } from './host/data-root.ts';
import { resolveDshRuntime } from './host/dsh-runtime.ts';
import { formatErrorMessage as formatError } from './host/error-format.ts';
import type { HarnessActivityEvent } from './host/harness-events.ts';
import {
	McpServerStore,
	McpServerStoreError,
	mcpSecretStorageKey,
} from './host/mcp/mcp-server-store.ts';
import {
	createSessionId,
	HarnessRunner,
	type RuntimeSkillSummary,
} from './host/harness-runner.ts';
import { SessionHistoryStore } from './host/session-history.ts';
import {
	SettingsWebviewPanel,
	type SettingsHost,
} from './host/settings-webview-panel.ts';
import { StreamDeltaBatcher } from './host/stream-delta-batcher.ts';
import { SystemPromptStore } from './host/system-prompt-store.ts';
import { createWebviewDocument } from './host/webview-document.ts';
import { WorkspaceChangeStore } from './host/workspace-change-store.ts';
import { WorkspaceDiffDocuments } from './host/workspace-diff-documents.ts';
import {
	detectLanguage,
	isLanguage,
	LocalizedError,
	translate,
	type Language,
} from './shared/i18n/index.ts';
import {
	DEFAULT_MODEL_SELECTION,
	isModelSelection,
	sameModelSelection,
	type ModelSelection,
} from './shared/model-selection.ts';
import { formatComposerFileMention } from './shared/composer-files.ts';
import {
	filterEnabledComposerSkills,
	normalizeSkillSource,
	updateDisabledSkillNames,
	type ComposerSkill,
} from './shared/composer-skills.ts';
import {
	type SettingsSkillCatalog,
	type SettingsState,
} from './shared/settings-rpc.ts';
import {
	collectMcpSecretNames,
	validateMcpServer,
	type McpImportResult,
	type McpImportSource,
	type McpImportSourceId,
	type McpServer,
	type McpValidationIssue,
} from './shared/mcp-servers.ts';
import {
	isWebviewToHostMessage,
	type ComposerFile,
	type HostToWebviewMessage,
	type PermissionCatalog,
	type PlanReview,
	type RuntimeStatus,
	type WebviewToHostMessage,
} from './shared/rpc.ts';
import type { WorkspaceFileDiff } from './shared/workspace-changes.ts';

/** View id declared under contributes.views in package.json. */
const VIEW_ID = 'seekdock.chatView';

/** Command opening the view container; VS Code registers it from contributes.viewsContainers. */
const CONTAINER_COMMAND_ID = 'workbench.view.extension.seekdockChat';

/** SecretStorage key used for the DeepSeek credential. */
const API_KEY_SECRET = 'seekdock.deepseekApiKey';

/** Global-state key containing the composer's model route preference. */
const MODEL_SELECTION_STATE_KEY = 'seekdock.modelSelection';

/** Global-state key containing skill names hidden from the slash menu. */
const DISABLED_SKILLS_STATE_KEY = 'seekdock.disabledSkills';

/** Global-state key containing the user's interface language. */
const LANGUAGE_STATE_KEY = 'seekdock.language';

/** One preset switch emits several durable events; read the final state once. */
const STATE_REFRESH_DEBOUNCE_MS = 75;

/**
 * Webview provider for the chat view in the Secondary Side Bar.
 *
 * The view is declared under the secondarySidebar container in package.json, so
 * nothing has to be moved at runtime; this class only fills the Webview and
 * talks to it.
 */
class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, SettingsHost {
	private view: vscode.WebviewView | undefined;
	private webviewHandshakeComplete = false;
	private pendingNewChat = false;
	private settingsPanel: SettingsWebviewPanel | undefined;
	private runner: HarnessRunner | undefined;
	private runnerInitialization: Promise<HarnessRunner> | undefined;
	private historyStore: SessionHistoryStore | undefined;
	private activeSessionId: string | undefined;
	private activeAnswerRequestId: string | undefined;
	private pendingCancelRequestId: string | undefined;
	private resumeActiveSession = false;
	private shutdownPromise: Promise<void> | undefined;
	private runtimeTask: Promise<void> | undefined;
	private runtimeGeneration = 0;
	private runtimeStatus: RuntimeStatus = 'idle';
	private runtimeError: string | undefined;
	private postChain: Promise<void> = Promise.resolve();
	private readonly promptStore: SystemPromptStore;
	private readonly mcpStore: McpServerStore;
	private readonly workspaceDiffs = new WorkspaceDiffDocuments();
	private readonly workspaceChanges: WorkspaceChangeStore;
	private approvalBroker: ApprovalBroker | undefined;
	private planReviewBroker: PlanReviewBroker | undefined;
	private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
	private readonly earlyApprovalDecisions = new Map<
		string,
		{ outcome: ApprovalOutcome; expiresAt: number }
	>();
	private readonly pendingPlanReviews = new Map<
		string,
		(answer: PlanReviewVerdict | undefined) => void
	>();
	private permissionCatalog: PermissionCatalog | null = null;
	private permissionCurrent: string | undefined;
	private permissionPending: string | undefined;
	private permissionError: string | undefined;
	private permissionRefreshTimer: NodeJS.Timeout | undefined;
	private planModeActive = false;
	private planModePending: boolean | undefined;
	private planModeError: string | undefined;
	private planModeRefreshTimer: NodeJS.Timeout | undefined;
	private modelSelection: ModelSelection;
	private modelSelectionError: string | undefined;
	private language: Language;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly secrets: vscode.SecretStorage,
		private readonly storageUri: vscode.Uri,
		private readonly globalState: vscode.Memento,
	) {
		const storedModelSelection = globalState.get<unknown>(MODEL_SELECTION_STATE_KEY);
		this.modelSelection = isModelSelection(storedModelSelection)
			? { ...storedModelSelection }
			: { ...DEFAULT_MODEL_SELECTION };
		const storedLanguage = globalState.get<unknown>(LANGUAGE_STATE_KEY);
		this.language = isLanguage(storedLanguage)
			? storedLanguage
			: detectLanguage(vscode.env.language);
		this.promptStore = new SystemPromptStore(
			vscode.Uri.joinPath(extensionUri, 'resources', 'default-system-prompt.md').fsPath,
			vscode.Uri.joinPath(storageUri, 'active-system-prompt.md').fsPath,
			globalState,
		);
		this.mcpStore = new McpServerStore(
			storageUri.fsPath,
			() => this.workspaceRoot(),
		);
		this.workspaceChanges = new WorkspaceChangeStore(
			vscode.Uri.joinPath(storageUri, 'workspace-change-history').fsPath,
		);
	}

	/** Whether VS Code has created the Webview, i.e. the view has actually been opened. */
	get resolved(): boolean {
		return this.view !== undefined;
	}

	/** Whether the standalone settings panel currently exists. */
	get settingsResolved(): boolean {
		return this.settingsPanel !== undefined;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.webviewHandshakeComplete = false;

		webviewView.webview.options = {
			enableScripts: true,
			// Restrict loads to the extension's own directory so the Webview cannot read arbitrary local files.
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.onDidReceiveMessage((message: unknown) => {
			if (!isWebviewToHostMessage(message)) {
				return;
			}
			void this.handleMessage(message);
		});

		webviewView.webview.html = this.getHtml(webviewView.webview);
		void this.prewarmRuntimeFromStorage();

		webviewView.onDidChangeVisibility(() => {
			if (this.view === webviewView && webviewView.visible && this.webviewHandshakeComplete) {
				void this.syncWebviewState();
			}
		});

		webviewView.onDidDispose(() => {
			if (this.view !== webviewView) {
				return;
			}
			this.view = undefined;
			this.webviewHandshakeComplete = false;
			this.cancelPendingInteractions();
		});

		// The Webview may be created on demand, so replay a new-chat request that arrived earlier.
		if (this.pendingNewChat) {
			this.pendingNewChat = false;
			void webviewView.webview.postMessage({ type: 'newChat' });
		}
	}

	/**
	 * Clears the active session. Dispatches immediately when the webview is ready;
	 * otherwise queues the request until the webview is created.
	 * @returns Whether the request was handled immediately.
	 */
	requestNewChat(): boolean {
		if (this.runner?.busy) {
			void vscode.window.showWarningMessage(translate(this.language, 'hostBusyNewChat'));
			return true;
		}
		this.resetActiveSessionState();
		void this.postSessionHistory();
		void this.postPermissionState();
		void this.postPlanModeState();
		if (!this.view) {
			this.pendingNewChat = true;
			return false;
		}
		void this.view.webview.postMessage({ type: 'newChat' });
		return true;
	}

	/** Open the standalone settings panel and reuse it when already visible. */
	openSettings(): void {
		this.settingsPanel ??= new SettingsWebviewPanel(this.extensionUri, this, () => {
			this.settingsPanel = undefined;
		});
		this.settingsPanel.reveal();
		void this.prewarmRuntimeFromStorage();
	}

	focusInput(): void {
		if (this.view) {
			void this.view.webview.postMessage({ type: 'focus' });
		}
	}

	/** Replace the stored API key and close any runtime using the previous key. */
	async setApiKey(apiKey: string): Promise<void> {
		await this.stopRuntimeForReconfiguration();
		this.resumeActiveSession ||= this.activeSessionId !== undefined;
		await this.secrets.store(API_KEY_SECRET, apiKey);

		void this.beginRuntimeInitialization(apiKey);
		await this.postState();		
	}

	/** Persist the interface language and refresh both Webviews immediately. */
	async setLanguage(language: Language): Promise<void> {
		await this.globalState.update(LANGUAGE_STATE_KEY, language);
		this.language = language;
		await this.postState();
	}

	/** @returns the active interface language. */
	getLanguage(): Language {
		return this.language;
	}

	/** Persist a prompt override and restart DSH with the new effective prompt. */
	async saveSystemPrompt(prompt: string): Promise<void> {
		if (this.runner?.busy) {
			throw new LocalizedError('hostBusyPrompt');
		}
		await this.promptStore.save(prompt);
		await this.stopRuntimeForReconfiguration();
		this.resumeActiveSession ||= this.activeSessionId !== undefined;
		await this.restartRuntimeFromStorage();
		await this.postState();
	}

	/** Restore the packaged prompt and apply it to the next DSH runtime. */
	async resetSystemPrompt(): Promise<void> {
		if (this.runner?.busy) {
			throw new LocalizedError('hostBusyPrompt');
		}
		await this.promptStore.reset();
		await this.stopRuntimeForReconfiguration();
		this.resumeActiveSession ||= this.activeSessionId !== undefined;
		await this.restartRuntimeFromStorage();
		await this.postState();
	}

	dispose(): void {
		this.settingsPanel?.dispose();
		this.settingsPanel = undefined;
		this.workspaceDiffs.dispose();
		void this.shutdown();
	}

	/** Stop the runtime and wait for it to exit. */
	shutdown(): Promise<void> {
		this.shutdownPromise ??= (async () => {
			await this.workspaceChanges.dispose();
			this.cancelPendingInteractions();
			if (this.permissionRefreshTimer !== undefined) {
				clearTimeout(this.permissionRefreshTimer);
				this.permissionRefreshTimer = undefined;
			}
			if (this.planModeRefreshTimer !== undefined) {
				clearTimeout(this.planModeRefreshTimer);
				this.planModeRefreshTimer = undefined;
			}
			try {
				await this.runtimeTask?.catch(() => {});
				await this.runner?.dispose();
				await this.approvalBroker?.dispose();
				await this.planReviewBroker?.dispose();
			} catch (error) {
				console.error('SeekDock: failed to stop the DeepSeek Harness runtime', error);
			}
		})();
		return this.shutdownPromise;
	}

	private async handleMessage(message: WebviewToHostMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.webviewHandshakeComplete = true;
				await this.syncWebviewState();
				break;
			case 'newChat':
				await this.startNewChat();
				break;
			case 'requestSessionHistory':
				await this.postSessionHistory(message.requestId);
				break;
			case 'loadSession':
				await this.loadSession(message);
				break;
			case 'renameSession':
				await this.renameSession(message);
				break;
			case 'deleteSession':
				await this.deleteSession(message);
				break;
			case 'saveApiKey':
				await this.saveApiKey(message);
				break;
			case 'saveSystemPrompt':
				await this.saveSystemPromptMessage(message);
				break;
			case 'resetSystemPrompt':
				await this.resetSystemPromptMessage(message);
				break;
			case 'openSettings':
				this.openSettings();
				break;
			case 'retryRuntime':
				await this.retryRuntime();
				break;
			case 'setPermission':
				await this.setPermission(message);
				break;
			case 'setPlanMode':
				await this.setPlanMode(message);
				break;
			case 'pickFiles':
				await this.pickFiles(message);
				break;
			case 'requestSkills':
				await this.requestSkills(message);
				break;
			case 'openSkill':
				await this.openSkillMessage(message);
				break;
			case 'setModelSelection':
				await this.setModelSelection(message);
				break;
			case 'approvalResponse':
				await this.answerApproval(message);
				break;
			case 'planReviewResponse':
				await this.answerPlanReview(message);
				break;
			case 'requestWorkspaceFileDiff':
				await this.requestWorkspaceFileDiff(message);
				break;
			case 'openWorkspaceFileDiff':
				await this.openWorkspaceFileDiff(message);
				break;
			case 'chat':
				await this.answer(message);
				break;
			case 'cancel':
				await this.cancelAnswer(message);
				break;
			case 'openExternal':
				await this.openExternal(message);
				break;
		}
	}

	private async startNewChat(): Promise<void> {
		if (this.runner?.busy) {
			await this.postSessionHistory();
			return;
		}
		this.resetActiveSessionState();
		await this.postMessage({ type: 'newChat' });
		await this.postSessionHistory();
		await this.postPermissionState();
		await this.postPlanModeState();
	}

	private resetActiveSessionState(): void {
		this.cancelPendingInteractions();
		this.activeSessionId = undefined;
		this.resumeActiveSession = false;
		this.permissionPending = undefined;
		this.permissionCurrent = this.permissionCatalog?.defaultPreset;
		this.permissionError = undefined;
		this.planModeActive = false;
		this.planModePending = undefined;
		this.planModeError = undefined;
	}

	private async loadSession(
		message: Extract<WebviewToHostMessage, { type: 'loadSession' }>,
	): Promise<void> {
		try {
			if (this.runner?.busy) {
				throw new LocalizedError('hostBusySwitchSession');
			}
			const changesBySeq = await this.workspaceChanges.readSession(message.sessionId);
			const loaded = await this.getHistoryStore().load(message.sessionId, changesBySeq);
			this.cancelPendingInteractions();
			this.activeSessionId = loaded.sessionId;
			this.resumeActiveSession = true;
			this.permissionPending = undefined;
			this.planModeActive = false;
			this.planModePending = undefined;
			this.planModeError = undefined;
			await this.postMessage({
				type: 'sessionLoaded',
				requestId: message.requestId,
				sessionId: loaded.sessionId,
				title: loaded.title,
				messages: loaded.messages,
			});
			await this.postSessionHistory();
			await this.prepareLoadedSession(loaded.sessionId);
		} catch (error) {
			await this.postMessage({
				type: 'sessionLoadError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async deleteSession(
		message: Extract<WebviewToHostMessage, { type: 'deleteSession' }>,
	): Promise<void> {
		try {
			if (this.runner?.busy) {
				throw new LocalizedError('hostBusyDeleteSession');
			}
			await this.runner?.invalidate();
			const wasActive = this.activeSessionId === message.sessionId;
			if (!wasActive && this.activeSessionId !== undefined) {
				this.resumeActiveSession = true;
			}
			await this.getHistoryStore().delete(message.sessionId);
			try {
				await this.workspaceChanges.removeSession(message.sessionId);
			} catch (error) {
				// The session is gone either way; a stale change record must not block deletion.
				console.warn('SeekDock: failed to remove cached workspace changes', error);
			}
			if (wasActive) {
				this.resetActiveSessionState();
			}
			await this.postMessage({
				type: 'sessionDeleted',
				requestId: message.requestId,
				sessionId: message.sessionId,
				wasActive,
				...(this.activeSessionId === undefined
					? {}
					: { activeSessionId: this.activeSessionId }),
			});
			await this.postSessionHistory();
			await this.restartRuntimeFromStorage();
			await this.postPermissionState();
			await this.postPlanModeState();
		} catch (error) {
			await this.postMessage({
				type: 'sessionDeleteError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async renameSession(
		message: Extract<WebviewToHostMessage, { type: 'renameSession' }>,
	): Promise<void> {
		try {
			if (this.runner?.busy) {
				throw new LocalizedError('hostBusyRenameSession');
			}
			if (!this.runtimeReady()) {
				throw new LocalizedError('hostRuntimeNotReadyRename');
			}
			const runner = await this.getRunner();
			await runner.prepareSession(message.sessionId, { resume: true });
			const title = await runner.renameSession(message.sessionId, message.title);
			await this.postMessage({
				type: 'sessionRenamed',
				requestId: message.requestId,
				sessionId: message.sessionId,
				title,
			});
			await this.postSessionHistory();
		} catch (error) {
			await this.postMessage({
				type: 'sessionRenameError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async saveSystemPromptMessage(
		message: Extract<WebviewToHostMessage, { type: 'saveSystemPrompt' }>,
	): Promise<void> {
		try {
			await this.saveSystemPrompt(message.prompt);
			await this.postMessage({
				type: 'systemPromptSaved',
				requestId: message.requestId,
				isDefault: false,
			});
		} catch (error) {
			await this.postMessage({
				type: 'systemPromptError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async resetSystemPromptMessage(
		message: Extract<WebviewToHostMessage, { type: 'resetSystemPrompt' }>,
	): Promise<void> {
		try {
			await this.resetSystemPrompt();
			await this.postMessage({
				type: 'systemPromptSaved',
				requestId: message.requestId,
				isDefault: true,
			});
		} catch (error) {
			await this.postMessage({
				type: 'systemPromptError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async saveApiKey(message: Extract<WebviewToHostMessage, { type: 'saveApiKey' }>): Promise<void> {
		const apiKey = message.apiKey.trim();
		if (apiKey.length === 0) {
			await this.postMessage({
				type: 'apiKeyError',
				message: translate(this.language, 'hostApiKeyRequired'),
			});
			return;
		}

		try {
			await this.setApiKey(apiKey);
		} catch (error) {
			await this.postMessage({
				type: 'apiKeyError',
				message: formatError(error, apiKey),
			});
		}
	}

	private async answer(message: Extract<WebviewToHostMessage, { type: 'chat' }>): Promise<void> {
		const prompt = message.text.trim();
		if (prompt.length === 0) {
			return;
		}

		let apiKey: string | undefined;
		try {
			apiKey = await this.secrets.get(API_KEY_SECRET);
		} catch (error) {
			await this.postMessage({
				type: 'error',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
			return;
		}
		if (apiKey === undefined || apiKey.length === 0) {
			await this.postMessage({
				type: 'error',
				requestId: message.requestId,
				message: translate(this.language, 'hostApiKeyMissing'),
			});
			await this.postState();
			return;
		}
		if (!this.runtimeReady()) {
			const initialized = await this.beginRuntimeInitialization(apiKey);
			if (!initialized) {
				await this.postMessage({
					type: 'error',
					requestId: message.requestId,
					message: this.runtimeError ?? translate(this.language, 'hostInitFailed'),
				});
				return;
			}
		}

		const batcher = new StreamDeltaBatcher(
			deltas => this.postMessage({
				type: 'assistantStreamDelta',
				requestId: message.requestId,
				deltas,
			}),
			40,
			error => console.error('SeekDock: failed to post an assistant delta', error),
		);
		let eventChain: Promise<void> = Promise.resolve();
		const enqueueEvent = (event: HarnessActivityEvent): void => {
			eventChain = eventChain
				.then(() => this.forwardActivity(message.requestId, event, batcher))
				.catch(error => console.error('SeekDock: failed to forward agent activity', error));
		};

		try {
			const sessionId = this.activeSessionId ?? createSessionId();
			this.activeSessionId = sessionId;
			this.activeAnswerRequestId = message.requestId;
			const runner = await this.getRunner();
			await this.prepareActiveSession(runner, sessionId);
			await this.postMessage({ type: 'busy', busy: true });
			await this.postSettingsState();
			await this.postMessage({ type: 'responseStart', requestId: message.requestId });
			const runTask = runner.ask(sessionId, prompt, apiKey, enqueueEvent);
			if (this.pendingCancelRequestId === message.requestId) {
				this.pendingCancelRequestId = undefined;
				void runner.cancel().catch(error => {
					console.error('SeekDock: failed to apply an early stop request', error);
				});
			}
			const result = await runTask;
			this.resumeActiveSession = false;
			this.refreshHistoryAfterTitle(runner, sessionId);
			await eventChain;
			await batcher.close();
			await this.postMessage({
				type: 'responseEnd',
				requestId: message.requestId,
				...(result.interrupted ? { interrupted: true } : {}),
			});
		} catch (error) {
			this.resumeActiveSession ||= this.activeSessionId !== undefined;
			await eventChain;
			try {
				await batcher.close();
			} catch (flushError) {
				console.error('SeekDock: failed to flush the final assistant delta', flushError);
			}
			if (this.runner !== undefined && !this.runner.isRuntimeReady()) {
				// A failed turn tears down the runtime inside the runner; reflect
				// that so the next prompt (or Retry) starts a fresh process.
				this.runtimeStatus = 'error';
				this.runtimeError = formatError(error, apiKey);
				await this.refreshPermissionState();
				await this.postStateSafely();
			}
			await this.postMessage({
				type: 'error',
				requestId: message.requestId,
				message: formatError(error, apiKey),
			});
		} finally {
			if (this.activeAnswerRequestId === message.requestId) {
				this.activeAnswerRequestId = undefined;
			}
			if (this.pendingCancelRequestId === message.requestId) {
				this.pendingCancelRequestId = undefined;
			}
			this.cancelPendingInteractions();
			await this.postMessage({ type: 'busy', busy: false });
			await this.postSettingsState();
			await this.postSessionHistory();
		}
	}

	private refreshHistoryAfterTitle(runner: HarnessRunner, sessionId: string): void {
		void runner.waitForSessionTitle(sessionId)
			.then(() => this.postSessionHistory())
			.catch(error => console.warn('SeekDock: failed to refresh the generated session title', error));
	}

	/**
	 * Ensure the session exists and carry the composer's pending preset into it.
	 * A persisted session is resumed; a fresh one is created without a model
	 * turn so its permission can be switched before the first prompt.
	 */
	private async prepareActiveSession(runner: HarnessRunner, sessionId: string): Promise<void> {
		await runner.prepareSession(sessionId, { resume: this.resumeActiveSession });
		this.resumeActiveSession = false;
		if (this.permissionPending !== undefined) {
			this.permissionCurrent = await runner.setPermission(sessionId, this.permissionPending);
			this.permissionPending = undefined;
		} else {
			try {
				const state = await runner.permissionState(sessionId);
				this.permissionCatalog = state.catalog;
				this.permissionCurrent = state.current ?? state.catalog.defaultPreset;
			} catch (error) {
				console.error('SeekDock: failed to read the session permission', error);
			}
		}
		this.permissionError = undefined;
		await this.postPermissionState();
		if (this.planModePending !== undefined) {
			try {
				const state = await runner.setPlanMode(sessionId, this.planModePending);
				this.planModeActive = state.active;
				this.planModePending = state.pending;
				this.planModeError = undefined;
			} catch (error) {
				this.planModeError = formatError(error, '');
			}
		} else {
			try {
				const state = await runner.planModeState(sessionId);
				this.planModeActive = state.active;
				this.planModePending = state.pending;
				this.planModeError = undefined;
			} catch (error) {
				console.error('SeekDock: failed to read plan mode', error);
			}
		}
		await this.postPlanModeState();
	}

	private async prepareLoadedSession(sessionId: string): Promise<void> {
		if (!this.runtimeReady()) {
			await this.refreshPermissionState();
			await this.refreshPlanModeState();
			return;
		}
		try {
			const runner = await this.getRunner();
			await runner.prepareSession(sessionId, { resume: true });
			this.resumeActiveSession = false;
		} catch (error) {
			// The transcript stays visible; the next prompt retries the resume.
			console.error('SeekDock: failed to resume the loaded session', error);
		}
		await this.refreshPermissionState();
		await this.refreshPlanModeState();
	}

	/**
	 * Switch the active session, or queue the choice for the next session when
	 * none exists yet. The permission service requires a live DSH session, so a
	 * fresh conversation stores the pick and applies it on its first prompt.
	 */
	private async setPermission(
		message: Extract<WebviewToHostMessage, { type: 'setPermission' }>,
	): Promise<void> {
		const catalog = this.permissionCatalog;
		if (catalog === null || !catalog.options.some(option => option.value === message.preset)) {
			this.permissionError = translate(this.language, 'hostPermissionUnavailable');
			await this.postPermissionState();
			return;
		}
		if (!this.runtimeReady()) {
			this.permissionError = translate(this.language, 'hostRuntimeNotReadyPermission');
			await this.postPermissionState();
			return;
		}
		if (this.activeSessionId === undefined) {
			this.permissionPending = message.preset;
			this.permissionCurrent = message.preset;
			this.permissionError = undefined;
			await this.postPermissionState();
			return;
		}
		try {
			const runner = await this.getRunner();
			await runner.prepareSession(this.activeSessionId, { resume: this.resumeActiveSession });
			this.resumeActiveSession = false;
			this.permissionCurrent = await runner.setPermission(
				this.activeSessionId,
				message.preset,
			);
			this.permissionPending = undefined;
			this.permissionError = undefined;
		} catch (error) {
			this.permissionError = formatError(error, '');
		}
		await this.postPermissionState();
	}

	/**
	 * Select DSH plan mode for the active session, or carry the choice into the
	 * first session created by a new conversation.
	 */
	private async setPlanMode(
		message: Extract<WebviewToHostMessage, { type: 'setPlanMode' }>,
	): Promise<void> {
		if (!this.runtimeReady()) {
			this.planModeError = translate(this.language, 'hostRuntimeNotReadyPlan');
			await this.postPlanModeState();
			return;
		}
		if (this.runner?.busy) {
			this.planModeError = translate(this.language, 'hostBusyPlan');
			await this.postPlanModeState();
			return;
		}
		if (this.activeSessionId === undefined) {
			this.planModePending = message.active;
			this.planModeError = undefined;
			await this.postPlanModeState();
			return;
		}
		try {
			const runner = await this.getRunner();
			await runner.prepareSession(this.activeSessionId, { resume: this.resumeActiveSession });
			this.resumeActiveSession = false;
			const state = await runner.setPlanMode(this.activeSessionId, message.active);
			this.planModeActive = state.active;
			this.planModePending = state.pending;
			this.planModeError = undefined;
		} catch (error) {
			this.planModeError = formatError(error, '');
		}
		await this.postPlanModeState();
	}

	/** Open the native VS Code file picker and return path references to the composer. */
	private async pickFiles(
		message: Extract<WebviewToHostMessage, { type: 'pickFiles' }>,
	): Promise<void> {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const selected = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				openLabel: translate(this.language, 'hostAddFileDialogButton'),
				title: translate(this.language, 'hostAddFileDialogTitle'),
				...(workspaceRoot === undefined
					? {}
					: { defaultUri: vscode.Uri.file(workspaceRoot) }),
			});
			const files: ComposerFile[] = [];
			const seen = new Set<string>();
			for (const uri of selected ?? []) {
				const absolutePath = uri.fsPath;
				let path = workspaceRoot === undefined
					? absolutePath
					: relative(workspaceRoot, absolutePath);
				if (workspaceRoot !== undefined
					&& (path.length === 0
						|| isAbsolute(path)
						|| path === '..'
						|| path.startsWith(`..${sep}`))) {
					path = absolutePath;
				}
				path = path.split(sep).join('/');
				const mention = formatComposerFileMention(path);
				if (mention === undefined || seen.has(mention)) {
					continue;
				}
				seen.add(mention);
				files.push({
					id: mention,
					name: basename(absolutePath),
					path,
					mention,
				});
			}
			await this.postMessage({
				type: 'filesSelected',
				requestId: message.requestId,
				files,
			});
		} catch (error) {
			await this.postMessage({
				type: 'filesSelectionError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	/** Start runtime initialization when a stored credential is available. */
	prewarmRuntime(): void {
		void this.prewarmRuntimeFromStorage();
	}

	/** Return the complete settings catalog, including disabled skills. */
	async getSkillCatalog(): Promise<SettingsSkillCatalog> {
		const runner = await this.getRunner();
		const summaries = await runner.skillCatalog();
		const disabled = new Set(this.readDisabledSkillNames());
		const skills = summaries.flatMap(summary => {
			const skill = toComposerSkill(summary);
			return skill === undefined
				? []
				: [{ ...skill, enabled: !disabled.has(skill.name) }];
		});
		return {
			roots: {
				workspace: join(
					vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
					'.agents',
					'skills',
				),
				user: join(homedir(), '.agents', 'skills'),
			},
			skills,
		};
	}

	/** Persist a skill visibility preference and refresh the chat slash menu. */
	async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
		const next = updateDisabledSkillNames(this.readDisabledSkillNames(), name, enabled);
		await this.globalState.update(DISABLED_SKILLS_STATE_KEY, next);
		if (this.runtimeReady()) {
			try {
				const catalog = await this.getSkillCatalog();
				await this.postComposerSkillCatalog(catalog);
			} catch (error) {
				console.error('SeekDock: failed to refresh the skill catalog', error);
			}
		}
	}

	/** Open one skill's instruction Markdown in the editor. */
	async openSkill(name: string): Promise<void> {
		const runner = await this.getRunner();
		const skill = await runner.skillDefinition(name);
		await this.showSkillDocument(skill);
	}

	/** @returns the persisted MCP declarations and their data-directory file. */
	async getMcpServers(): Promise<{ path: string; servers: readonly McpServer[] }> {
		try {
			return {
				path: this.mcpStore.serversPath,
				servers: await this.mcpStore.list(),
			};
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Validate, persist, and activate one MCP server declaration. */
	async saveMcpServer(
		server: McpServer,
		previousServerName: string | undefined,
		providedSecrets: Readonly<Record<string, string>>,
	): Promise<void> {
		this.assertMcpConfigurationEditable();
		const issues = validateMcpServer(server);
		if (issues.length > 0) {
			throw this.localizeMcpIssue(issues[0]);
		}
		try {
			const current = await this.mcpStore.list();
			if (current.some(item => (
				item.serverName === server.serverName
				&& item.serverName !== previousServerName
			))) {
				throw new LocalizedError('hostMcpDuplicateName', {
					name: server.serverName,
				});
			}
			await this.persistMcpSecrets([server], providedSecrets);
			await this.mcpStore.save(server, previousServerName);
			await this.reloadRuntimeForMcpChange();
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Delete one MCP server and refresh the next Harness composition. */
	async deleteMcpServer(serverName: string): Promise<void> {
		this.assertMcpConfigurationEditable();
		try {
			await this.mcpStore.remove(serverName);
			await this.reloadRuntimeForMcpChange();
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Toggle one MCP server without changing its remaining declaration. */
	async setMcpServerEnabled(serverName: string, enabled: boolean): Promise<void> {
		this.assertMcpConfigurationEditable();
		try {
			if (enabled) {
				const server = (await this.mcpStore.list()).find(
					item => item.serverName === serverName,
				);
				if (server === undefined) {
					throw new LocalizedError('hostMcpNotFound', { name: serverName });
				}
				await this.persistMcpSecrets([server], {});
			}
			await this.mcpStore.setEnabled(serverName, enabled);
			await this.reloadRuntimeForMcpChange();
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Read metadata-only previews from all supported external MCP configuration files. */
	async getMcpImportSources(): Promise<readonly McpImportSource[]> {
		try {
			return await this.mcpStore.importSources();
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Import selected declarations from one read-only external source. */
	async importMcpServers(
		sourceId: McpImportSourceId,
		originalNames: readonly string[],
		providedSecrets: Readonly<Record<string, string>>,
	): Promise<McpImportResult> {
		this.assertMcpConfigurationEditable();
		try {
			const selected = await this.mcpStore.selectForImport(sourceId, originalNames);
			const currentNames = new Set((await this.mcpStore.list()).map(server => server.serverName));
			const importable = selected.filter(server => !currentNames.has(server.serverName));
			await this.persistMcpSecrets(importable, providedSecrets);
			const result = await this.mcpStore.addImported(importable);
			result.skipped += selected.length - importable.length;
			if (result.imported > 0) {
				await this.reloadRuntimeForMcpChange();
			}
			return result;
		} catch (error) {
			throw this.localizeMcpError(error);
		}
	}

	/** Publish the DSH skill catalog used by the composer's slash menu. */
	private async requestSkills(
		message: Extract<WebviewToHostMessage, { type: 'requestSkills' }>,
	): Promise<void> {
		try {
			await this.postComposerSkillCatalog(await this.getSkillCatalog(), message.requestId);
		} catch (error) {
			await this.postMessage({
				type: 'skillCatalogError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async postComposerSkillCatalog(
		catalog: SettingsSkillCatalog,
		requestId: string = randomUUID(),
	): Promise<void> {
		const disabledNames = catalog.skills
			.filter(skill => !skill.enabled)
			.map(skill => skill.name);
		await this.postMessage({
			type: 'skillCatalog',
			requestId,
			skills: filterEnabledComposerSkills(catalog.skills, disabledNames).map(skill => ({
				name: skill.name,
				description: skill.description,
				source: skill.source,
			})),
		});
	}

	private readDisabledSkillNames(): readonly string[] {
		return readDisabledSkillNames(this.globalState);
	}

	/** Open one selected skill from the chat Webview. */
	private async openSkillMessage(
		message: Extract<WebviewToHostMessage, { type: 'openSkill' }>,
	): Promise<void> {
		try {
			await this.openSkill(message.name);
		} catch (error) {
			await this.postMessage({
				type: 'skillOpenError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	private async showSkillDocument(
		skill: Awaited<ReturnType<HarnessRunner['skillDefinition']>>,
	): Promise<void> {
		if (skill.path !== undefined) {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(skill.path));
			await vscode.window.showTextDocument(document, { preview: true });
			return;
		}
		const document = await vscode.workspace.openTextDocument({
			content: skill.content,
			language: 'markdown',
		});
		await vscode.window.showTextDocument(document, { preview: true });
	}

	/**
	 * Persist and apply the composer's model route. DSH fixes model and
	 * reasoning effort at SDK initialization, so a change recycles the runtime
	 * and resumes the active persisted session on the new route.
	 */
	private async setModelSelection(
		message: Extract<WebviewToHostMessage, { type: 'setModelSelection' }>,
	): Promise<void> {
		const next: ModelSelection = {
			model: message.model as ModelSelection['model'],
			reasoningEffort: message.reasoningEffort as ModelSelection['reasoningEffort'],
		};
		if (!isModelSelection(next)) {
			this.modelSelectionError = translate(this.language, 'hostInvalidModel');
			await this.postModelSelectionState();
			return;
		}
		if (this.runner?.busy) {
			this.modelSelectionError = translate(this.language, 'hostBusyModel');
			await this.postModelSelectionState();
			return;
		}
		if (sameModelSelection(this.modelSelection, next)) {
			this.modelSelectionError = undefined;
			await this.postModelSelectionState();
			return;
		}

		this.modelSelectionError = undefined;
		try {
			await this.globalState.update(MODEL_SELECTION_STATE_KEY, next);
		} catch (error) {
			this.modelSelectionError = formatError(error, '');
			await this.postModelSelectionState();
			return;
		}

		this.modelSelection = next;
		this.resumeActiveSession ||= this.activeSessionId !== undefined;
		try {
			await this.stopRuntimeForReconfiguration();
			await this.restartRuntimeFromStorage();
		} catch (error) {
			this.modelSelectionError = formatError(error, '');
		}
		await this.postModelSelectionState();
		await this.postStateSafely();
	}

	/** @returns the pending approval's answer, forwarded to DSH. */
	private async answerApproval(
		message: Extract<WebviewToHostMessage, { type: 'approvalResponse' }>,
	): Promise<void> {
		const outcome: ApprovalOutcome = message.decision === 'allow'
			? 'allowed-once'
			: 'rejected';
		const key = message.toolCallId;
		if (key !== undefined) {
			const pending = this.pendingApprovals.get(key);
			if (pending !== undefined) {
				this.pendingApprovals.delete(key);
				pending(outcome);
			} else {
				// The Webview can answer as soon as the audit card appears, which
				// may precede the runtime's socket question by a few milliseconds.
				this.earlyApprovalDecisions.set(key, {
					outcome,
					expiresAt: Date.now() + 60_000,
				});
			}
		}
		await this.postMessage({
			type: 'approvalResolved',
			approvalId: message.approvalId,
			...(key === undefined ? {} : { toolCallId: key }),
			decision: message.decision === 'allow' ? 'allowed' : 'rejected',
		});
	}

	/** Hand one runtime approval question to the Webview and wait for its answer. */
	private requestApproval(question: ApprovalQuestion): Promise<ApprovalOutcome> {
		if (question.sessionId !== this.activeSessionId || this.view === undefined) {
			return Promise.resolve('unavailable');
		}
		const requestId = this.activeAnswerRequestId;
		if (requestId === undefined || this.pendingApprovals.has(question.toolCallId)) {
			return Promise.resolve('unavailable');
		}
		const early = this.takeEarlyApprovalDecision(question.toolCallId);
		if (early !== undefined) {
			return Promise.resolve(early);
		}
		const approval = {
			id: `bridge:${question.toolCallId}`,
			toolCallId: question.toolCallId,
			toolName: question.toolName,
			...(question.reason === undefined ? {} : { reason: question.reason }),
			...(question.displayReason === undefined ? {} : { displayReason: question.displayReason }),
		};
		void this.postMessage({ type: 'approvalRequest', requestId, approval });
		return new Promise(resolve => {
			this.pendingApprovals.set(question.toolCallId, resolve);
		});
	}

	/** @returns the pending plan review's decision, forwarded to DSH. */
	private async answerPlanReview(
		message: Extract<WebviewToHostMessage, { type: 'planReviewResponse' }>,
	): Promise<void> {
		const pending = this.pendingPlanReviews.get(message.reviewId);
		if (pending !== undefined) {
			this.pendingPlanReviews.delete(message.reviewId);
			pending({
				approved: message.decision === 'approve',
				...(message.feedback === undefined || message.feedback.trim().length === 0
					? {}
					: { feedback: message.feedback }),
			});
		}
		await this.postMessage({
			type: 'planReviewResolved',
			reviewId: message.reviewId,
			decision: message.decision === 'approve' ? 'approved' : 'keep-planning',
		});
	}

	/** Hand one runtime plan review to the Webview and wait for its answer. */
	private requestPlanReview(question: PlanReviewQuestion): Promise<PlanReviewVerdict | undefined> {
		const requestId = this.activeAnswerRequestId;
		if (question.sessionId !== this.activeSessionId
			|| this.view === undefined
			|| requestId === undefined) {
			return Promise.resolve(undefined);
		}
		const review: PlanReview = {
			id: `plan-review:${question.sessionId}:${question.callId ?? question.questionId}`,
			plan: question.plan,
		};
		if (this.pendingPlanReviews.has(review.id)) {
			return Promise.resolve(undefined);
		}
		void this.postMessage({ type: 'planReviewRequest', requestId, review });
		return new Promise(resolve => {
			this.pendingPlanReviews.set(review.id, resolve);
		});
	}

	private takeEarlyApprovalDecision(toolCallId: string): ApprovalOutcome | undefined {
		const now = Date.now();
		for (const [key, entry] of this.earlyApprovalDecisions) {
			if (entry.expiresAt <= now) {
				this.earlyApprovalDecisions.delete(key);
			}
		}
		const entry = this.earlyApprovalDecisions.get(toolCallId);
		if (entry === undefined) {
			return undefined;
		}
		this.earlyApprovalDecisions.delete(toolCallId);
		return entry.outcome;
	}

	/** Fail every pending approval and plan review closed. */
	private cancelPendingInteractions(): void {
		for (const [key, resolve] of this.pendingApprovals) {
			this.pendingApprovals.delete(key);
			resolve('cancelled');
		}
		this.earlyApprovalDecisions.clear();
		// The plan card has no durable event behind it, so close it here; the
		// turn's tool result lands on the tool row instead.
		for (const [key, resolve] of this.pendingPlanReviews) {
			this.pendingPlanReviews.delete(key);
			resolve(undefined);
			void this.postMessage({
				type: 'planReviewResolved',
				reviewId: key,
				decision: 'cancelled',
			});
		}
	}

	/** Re-read the catalog and the active session's current preset. */
	private async refreshPermissionState(): Promise<void> {
		if (!this.runtimeReady()) {
			this.permissionCatalog = null;
			this.permissionCurrent = undefined;
			await this.postPermissionState();
			return;
		}
		try {
			const runner = await this.getRunner();
			const catalog = await runner.permissionCatalog();
			this.permissionCatalog = catalog;
			this.permissionCurrent = this.permissionPending ?? catalog.defaultPreset;
			if (this.activeSessionId !== undefined && runner.isSessionLive(this.activeSessionId)) {
				try {
					const state = await runner.permissionState(this.activeSessionId);
					this.permissionCatalog = state.catalog;
					this.permissionCurrent = state.current
						?? this.permissionPending
						?? state.catalog.defaultPreset;
				} catch (error) {
					console.error('SeekDock: failed to read the session permission', error);
				}
			}
			this.permissionError = undefined;
		} catch (error) {
			this.permissionError = formatError(error, '');
		}
		await this.postPermissionState();
	}

	/** Coalesce the three durable knob events that follow one preset switch. */
	private schedulePermissionRefresh(): void {
		this.permissionRefreshTimer = scheduleRefresh(this.permissionRefreshTimer, () => {
			this.permissionRefreshTimer = undefined;
			void this.refreshPermissionState();
		});
	}

	private async postPermissionState(): Promise<void> {
		await this.postMessage({
			type: 'permissionState',
			catalog: this.permissionCatalog,
			...(this.permissionCurrent === undefined ? {} : { current: this.permissionCurrent }),
			...(this.permissionPending === undefined ? {} : { pending: this.permissionPending }),
			...(this.permissionError === undefined ? {} : { error: this.permissionError }),
		});
	}

	/** Re-read the active session's DSH plan-mode state. */
	private async refreshPlanModeState(): Promise<void> {
		if (!this.runtimeReady()) {
			this.planModeActive = false;
			this.planModePending = undefined;
			await this.postPlanModeState();
			return;
		}
		if (this.activeSessionId === undefined) {
			this.planModeActive = false;
			await this.postPlanModeState();
			return;
		}
		try {
			const runner = await this.getRunner();
			if (!runner.isSessionLive(this.activeSessionId)) {
				await this.postPlanModeState();
				return;
			}
			const state = await runner.planModeState(this.activeSessionId);
			this.planModeActive = state.active;
			this.planModePending = state.pending;
			this.planModeError = undefined;
		} catch (error) {
			this.planModeError = formatError(error, '');
		}
		await this.postPlanModeState();
	}

	/** Coalesce durable plan/mode events into one state read. */
	private schedulePlanModeRefresh(): void {
		this.planModeRefreshTimer = scheduleRefresh(this.planModeRefreshTimer, () => {
			this.planModeRefreshTimer = undefined;
			void this.refreshPlanModeState();
		});
	}

	private async postPlanModeState(): Promise<void> {
		await this.postMessage({
			type: 'planModeState',
			active: this.planModeActive,
			...(this.planModePending === undefined ? {} : { pending: this.planModePending }),
			...(this.planModeError === undefined ? {} : { error: this.planModeError }),
		});
	}

	private async postModelSelectionState(): Promise<void> {
		await this.postMessage({
			type: 'modelSelectionState',
			current: this.modelSelection,
			...(this.modelSelectionError === undefined ? {} : { error: this.modelSelectionError }),
		});
	}

	private async cancelAnswer(
		message: Extract<WebviewToHostMessage, { type: 'cancel' }>,
	): Promise<void> {
		if (this.activeAnswerRequestId !== message.targetRequestId) {
			await this.postMessage({
				type: 'cancelResult',
				requestId: message.requestId,
				accepted: false,
				message: translate(this.language, 'hostNoActiveAnswer'),
			});
			return;
		}
		if (this.runner === undefined || !this.runner.busy) {
			this.pendingCancelRequestId = message.targetRequestId;
			await this.postMessage({
				type: 'cancelResult',
				requestId: message.requestId,
				accepted: true,
			});
			return;
		}
		try {
			const interrupted = await this.runner.cancel();
			await this.postMessage({
				type: 'cancelResult',
				requestId: message.requestId,
				accepted: true,
			});
			if (!interrupted) {
				console.info('SeekDock: stop requested after the active turn had already settled.');
			}
		} catch (error) {
			const messageText = formatError(error, '');
			await this.postMessage({
				type: 'cancelResult',
				requestId: message.requestId,
				accepted: false,
				message: messageText,
			});
			void vscode.window.showWarningMessage(translate(this.language, 'hostStopFailed', {
				message: messageText,
			}));
		}
	}

	private async forwardActivity(
		requestId: string,
		event: HarnessActivityEvent,
		batcher: StreamDeltaBatcher,
	): Promise<void> {
		switch (event.type) {
			case 'assistantStreamStart':
				await batcher.flush();
				await this.postMessage({
					type: 'assistantStreamStart',
					requestId,
					attemptId: event.attemptId,
					turn: event.turn,
					step: event.step,
				});
				break;
			case 'assistantStreamDelta':
				batcher.push(event.delta);
				break;
			case 'assistantStreamEnd':
				await batcher.flush();
				await this.postMessage({
					type: 'assistantStreamEnd',
					requestId,
					attemptId: event.attemptId,
				});
				break;
			case 'assistantMessage':
				await batcher.flush();
				await this.postMessage({
					type: 'assistantMessage',
					requestId,
					turn: event.turn,
					step: event.step,
					blocks: event.blocks,
					...(event.interrupted === true ? { interrupted: true } : {}),
				});
				break;
			case 'toolCallStart':
				await batcher.flush();
				await this.postMessage({ type: 'toolCallStart', requestId, call: event.call });
				break;
			case 'toolCallUpdate':
				await batcher.flush();
				await this.postMessage({ type: 'toolCallUpdate', requestId, call: event.call });
				break;
			case 'approvalRequest':
				await batcher.flush();
				await this.postMessage({ type: 'approvalRequest', requestId, approval: event.approval });
				break;
			case 'approvalResolved':
				await batcher.flush();
				await this.postMessage({
					type: 'approvalResolved',
					approvalId: event.approvalId,
					...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
					decision: event.decision,
				});
				break;
			case 'workspaceChanges':
				if (this.activeSessionId !== undefined && this.runner !== undefined) {
					const sessionId = this.activeSessionId;
					const runner = this.runner;
					try {
						const changes = await runner.workspaceChanges(sessionId, event.seq);
						if (changes !== undefined && changes.files.length > 0) {
							await this.postMessage({
								type: 'workspaceChanges',
								requestId,
								changes,
							});
							// DSH drops the summary with the live Session, so keep the
							// card and its comparisons for the reopened conversation.
							await this.workspaceChanges.record(
								changes,
								index => runner.workspaceFileDiff(sessionId, event.seq, index),
							);
						}
					} catch (error) {
						console.error('SeekDock: failed to read workspace changes', error);
					}
				}
				break;
			case 'permissionChanged':
				this.schedulePermissionRefresh();
				break;
			case 'planModeChanged':
				this.schedulePlanModeRefresh();
				break;
			case 'turnError':
				break;
		}
	}

	/** Serve one changed-file comparison requested by a hovered file row. */
	private async requestWorkspaceFileDiff(
		message: Extract<WebviewToHostMessage, { type: 'requestWorkspaceFileDiff' }>,
	): Promise<void> {
		try {
			const diff = await this.readWorkspaceFileDiff(message);
			await this.postMessage({
				type: 'workspaceFileDiff',
				requestId: message.requestId,
				diff: diff ?? null,
			});
		} catch (error) {
			await this.postMessage({
				type: 'workspaceFileDiffError',
				requestId: message.requestId,
				message: formatError(error, ''),
			});
		}
	}

	/** Open one changed-file comparison in VS Code's native diff editor. */
	private async openWorkspaceFileDiff(
		message: Extract<WebviewToHostMessage, { type: 'openWorkspaceFileDiff' }>,
	): Promise<void> {
		let diff: WorkspaceFileDiff | undefined;
		try {
			diff = await this.readWorkspaceFileDiff(message);
		} catch (error) {
			console.error('SeekDock: failed to open a workspace file diff', error);
		}
		if (diff?.kind !== 'text' || diff.hunks.length === 0) {
			void vscode.window.showWarningMessage(
				translate(this.language, 'hostWorkspaceDiffUnavailable'),
			);
			return;
		}
		try {
			await this.workspaceDiffs.open(
				diff,
				translate(this.language, 'workspaceDiffTitle', { path: diff.display }),
			);
		} catch (error) {
			const detail = formatError(error, '');
			void vscode.window.showErrorMessage(
				translate(this.language, 'hostWorkspaceDiffOpenFailed', { message: detail }),
			);
		}
	}

	private async readWorkspaceFileDiff(
		message: Extract<
			WebviewToHostMessage,
			{ type: 'requestWorkspaceFileDiff' | 'openWorkspaceFileDiff' }
		>,
	): Promise<WorkspaceFileDiff | undefined> {
		if (message.sessionId !== this.activeSessionId) {
			return undefined;
		}
		let liveError: unknown;
		if (this.runner !== undefined) {
			try {
				const diff = await this.runner.workspaceFileDiff(
					message.sessionId,
					message.seq,
					message.index,
				);
				if (diff !== undefined) {
					// A reopened conversation may outlive this Runtime Session, so
					// every comparison the user sees is kept for replay.
					void this.workspaceChanges.saveDiff(
						message.sessionId,
						message.seq,
						message.index,
						diff,
					).catch((error: unknown) => {
						console.warn('SeekDock: failed to cache a workspace file diff', error);
					});
					return diff;
				}
			} catch (error) {
				liveError = error;
			}
		}
		const stored = await this.workspaceChanges.readDiff(
			message.sessionId,
			message.seq,
			message.index,
		);
		if (stored !== undefined) {
			return stored;
		}
		if (liveError !== undefined) {
			throw liveError;
		}
		return undefined;
	}

	private async openExternal(
		message: Extract<WebviewToHostMessage, { type: 'openExternal' }>,
	): Promise<void> {
		let url: URL;
		try {
			url = new URL(message.url);
		} catch {
			return;
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') {
			return;
		}
		try {
			await vscode.env.openExternal(vscode.Uri.parse(url.href));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(translate(this.language, 'hostOpenLinkFailed', {
				message: detail,
			}));
		}
	}

	private async prewarmRuntimeFromStorage(): Promise<void> {
		try {
			const apiKey = await this.secrets.get(API_KEY_SECRET);
			if (apiKey === undefined || apiKey.length === 0) {
				this.runtimeStatus = 'idle';
				this.runtimeError = undefined;
				this.notifyState();
				return;
			}
			await this.beginRuntimeInitialization(apiKey);
		} catch (error) {
			this.runtimeStatus = 'error';
			this.runtimeError = formatError(error, '');
			this.notifyState();
			console.error('SeekDock: failed to prewarm the DeepSeek Harness runtime', error);
		}
	}

	private async retryRuntime(): Promise<void> {
		try {
			const apiKey = await this.secrets.get(API_KEY_SECRET);
			if (apiKey === undefined || apiKey.length === 0) {
				this.runtimeStatus = 'idle';
				this.runtimeError = undefined;
				await this.postStateSafely();
				return;
			}
			await this.beginRuntimeInitialization(apiKey);
		} catch (error) {
			this.runtimeStatus = 'error';
			this.runtimeError = formatError(error, '');
			await this.postStateSafely();
			console.error('SeekDock: failed to retry the DeepSeek Harness runtime', error);
		}
	}

	private async restartRuntimeFromStorage(): Promise<void> {
		const apiKey = await this.secrets.get(API_KEY_SECRET);
		if (apiKey === undefined || apiKey.length === 0) {
			this.runtimeStatus = 'idle';
			this.runtimeError = undefined;
			return;
		}
		await this.beginRuntimeInitialization(apiKey);
	}

	private beginRuntimeInitialization(apiKey: string): Promise<boolean> {
		if (this.runtimeReady()) {
			return Promise.resolve(true);
		}
		if (this.runtimeTask !== undefined) {
			return this.runtimeTask.then(() => this.runtimeStatus === 'ready');
		}

		const generation = ++this.runtimeGeneration;
		this.runtimeStatus = 'initializing';
		this.runtimeError = undefined;
		this.notifyState();

		let task: Promise<void>;
		task = (async () => {
			try {
				const runner = await this.getRunner();
				await runner.warmUp(apiKey);
				if (generation === this.runtimeGeneration) {
					this.runtimeStatus = 'ready';
					this.runtimeError = undefined;
					if (this.activeSessionId !== undefined && this.resumeActiveSession) {
						try {
							await runner.prepareSession(this.activeSessionId, { resume: true });
							this.resumeActiveSession = false;
						} catch (error) {
							console.error('SeekDock: failed to resume the active session', error);
						}
					}
					await this.refreshPermissionState();
					await this.refreshPlanModeState();
					await this.postStateSafely();
				}
			} catch (error) {
				if (generation === this.runtimeGeneration) {
					this.runtimeStatus = 'error';
					this.runtimeError = formatError(error, apiKey);
					await this.refreshPermissionState();
					await this.refreshPlanModeState();
					await this.postStateSafely();
				}
				console.error('SeekDock: failed to initialize the DeepSeek Harness runtime', error);
			}
		})().finally(() => {
			if (this.runtimeTask === task) {
				this.runtimeTask = undefined;
			}
		});
		this.runtimeTask = task;
		return task.then(() => this.runtimeStatus === 'ready');
	}

	private async stopRuntimeForReconfiguration(): Promise<void> {
		this.runtimeGeneration += 1;
		if (this.permissionRefreshTimer !== undefined) {
			clearTimeout(this.permissionRefreshTimer);
			this.permissionRefreshTimer = undefined;
		}
		await this.runtimeTask;
		await this.runner?.invalidate();
		this.runtimeTask = undefined;
		this.runtimeStatus = 'idle';
		this.runtimeError = undefined;
	}

	private runtimeReady(): boolean {
		return this.runtimeStatus === 'ready'
			&& this.runner !== undefined
			&& this.runner.isRuntimeReady();
	}

	private notifyState(): void {
		if (this.view === undefined && this.settingsPanel === undefined) {
			return;
		}
		void this.postStateSafely();
	}

	private async postStateSafely(): Promise<void> {
		try {
			await this.postState();
		} catch (error) {
			console.error('SeekDock: failed to publish runtime state', error);
		}
	}

	private async getRunner(): Promise<HarnessRunner> {
		if (this.runner !== undefined) {
			return this.runner;
		}
		this.runnerInitialization ??= this.createRunner().catch(error => {
			this.runnerInitialization = undefined;
			throw error;
		});
		return this.runnerInitialization;
	}

	private workspaceRoot(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	}

	private assertMcpConfigurationEditable(): void {
		if (this.runner?.busy) {
			throw new LocalizedError('hostBusyMcp');
		}
	}

	private async persistMcpSecrets(
		servers: readonly McpServer[],
		providedSecrets: Readonly<Record<string, string>>,
	): Promise<void> {
		const names = [...new Set(servers.flatMap(collectMcpSecretNames))];
		for (const name of names) {
			const provided = providedSecrets[name];
			if (provided !== undefined && provided.length > 0) {
				await this.secrets.store(mcpSecretStorageKey(name), provided);
				continue;
			}
			const existing = await this.secrets.get(mcpSecretStorageKey(name));
			if (existing === undefined || existing.length === 0) {
				throw new LocalizedError('hostMcpSecretRequired', { name });
			}
		}
	}

	private async reloadRuntimeForMcpChange(): Promise<void> {
		const hadRuntime = this.runner !== undefined || this.runtimeTask !== undefined;
		if (hadRuntime) {
			await this.stopRuntimeForReconfiguration();
			this.resumeActiveSession ||= this.activeSessionId !== undefined;
			await this.restartRuntimeFromStorage();
		}
		await this.postState();
	}

	private localizeMcpError(error: unknown): Error {
		if (error instanceof LocalizedError) {
			return error;
		}
		if (error instanceof McpServerStoreError) {
			switch (error.code) {
				case 'duplicateName':
					return new LocalizedError('hostMcpDuplicateName', {
						name: error.detail ?? '',
					});
				case 'notFound':
					return new LocalizedError('hostMcpNotFound', {
						name: error.detail ?? '',
					});
				case 'missingSecret':
					return new LocalizedError('hostMcpSecretRequired', {
						name: error.detail ?? '',
					});
				case 'invalidServer':
					return error.issues?.[0] === undefined
						? new LocalizedError('hostMcpInvalidConfiguration')
						: this.localizeMcpIssue(error.issues[0]);
				case 'invalidFile':
					return new LocalizedError('hostMcpStorageCorrupt');
			}
		}
		return new LocalizedError('hostMcpImportFailed', undefined, { cause: error });
	}

	private localizeMcpIssue(issue: McpValidationIssue): LocalizedError {
		switch (issue.code) {
			case 'nameRequired':
				return new LocalizedError('hostMcpNameRequired');
			case 'nameInvalid':
				return new LocalizedError('hostMcpNameInvalid');
			case 'commandRequired':
				return new LocalizedError('hostMcpCommandRequired');
			case 'urlRequired':
				return new LocalizedError('hostMcpUrlRequired');
			case 'urlInvalid':
				return new LocalizedError('hostMcpUrlInvalid');
			case 'entryNameRequired':
				return new LocalizedError('hostMcpEntryNameRequired');
			case 'entryNameDuplicate':
				return new LocalizedError('hostMcpEntryNameDuplicate', {
					name: issue.detail ?? '',
				});
			case 'entryNameInvalid':
				return new LocalizedError('hostMcpEntryNameInvalid', {
					name: issue.detail ?? '',
				});
			case 'unsupportedVariable':
				return new LocalizedError('hostMcpInvalidVariable', {
					variable: issue.detail ?? '',
				});
		}
	}

	private async createRunner(): Promise<HarnessRunner> {
		await this.promptStore.syncRuntimePrompt();
		const runtime = resolveDshRuntime(this.extensionUri.fsPath);
		const mcpRuntime = await this.mcpStore.writeRuntimePatch(
			name => this.secrets.get(mcpSecretStorageKey(name)),
		);
		this.approvalBroker ??= new ApprovalBroker({
			onQuestion: question => this.requestApproval(question),
		});
		await this.approvalBroker.start();
		this.planReviewBroker ??= new PlanReviewBroker({
			onQuestion: question => this.requestPlanReview(question),
		});
		await this.planReviewBroker.start();
		const runner = new HarnessRunner({
			cwd: this.workspaceRoot(),
			dshHome: vscode.Uri.joinPath(this.storageUri, 'dsh-home').fsPath,
			homePath: vscode.Uri.joinPath(this.storageUri, 'runtime-home').fsPath,
			patchPath: vscode.Uri.joinPath(
				this.extensionUri,
				'resources',
				'dsh',
				'seekdock-chat.cordis.patch.yml',
			).fsPath,
			mcpPatchPath: mcpRuntime.patchPath,
			mcpEnv: mcpRuntime.env,
			runtimeLauncherPath: vscode.Uri.joinPath(
				this.extensionUri,
				'dist',
				'dsh-runtime-wrapper.js',
			).fsPath,
			systemPromptPath: vscode.Uri.joinPath(
				this.storageUri,
				'active-system-prompt.md',
			).fsPath,
			runtimePath: runtime.executablePath,
			approvalSocketPath: this.approvalBroker.socketPath,
			planReviewSocketPath: this.planReviewBroker.socketPath,
			modelSelection: () => ({ ...this.modelSelection }),
		});
		this.runner = runner;
		return runner;
	}

	private getHistoryStore(): SessionHistoryStore {
		this.historyStore ??= new SessionHistoryStore({
			dshHome: vscode.Uri.joinPath(this.storageUri, 'dsh-home').fsPath,
			sessionsRoot: vscode.Uri.joinPath(
				this.storageUri,
				'dsh-home',
				'sessions',
			).fsPath,
			defaultSessionTitle: () => translate(this.language, 'hostDefaultSessionTitle'),
		});
		return this.historyStore;
	}

	private async postSessionHistory(requestId?: string): Promise<void> {
		try {
			const sessions = await this.getHistoryStore().list();
			await this.postMessage({
				type: 'sessionHistory',
				sessions,
				total: sessions.length,
				...(this.activeSessionId === undefined
					? {}
					: { activeSessionId: this.activeSessionId }),
			});
		} catch (error) {
			console.error('SeekDock: failed to read session history', error);
			if (requestId !== undefined) {
				await this.postMessage({
					type: 'sessionHistoryError',
					requestId,
					message: formatError(error, ''),
				});
			}
		}
	}

	/** Read the settings shared by the chat and standalone settings Webviews. */
	async getSettingsState(): Promise<SettingsState> {
		const [apiKey, promptState] = await Promise.all([
			this.secrets.get(API_KEY_SECRET),
			this.promptStore.getState(),
		]);
		return {
			hasApiKey: apiKey !== undefined && apiKey.length > 0,
			busy: this.runner?.busy ?? false,
			systemPrompt: promptState.systemPrompt,
			systemPromptIsDefault: promptState.isDefault,
			runtimeStatus: this.runtimeStatus,
			...(this.runtimeError === undefined ? {} : { runtimeError: this.runtimeError }),
			language: this.language,
		};
	}

	private async postState(): Promise<void> {
		const settingsState = await this.getSettingsState();
		await this.postMessage({
			type: 'state',
			hasApiKey: settingsState.hasApiKey,
			busy: settingsState.busy,
			systemPrompt: settingsState.systemPrompt,
			systemPromptIsDefault: settingsState.systemPromptIsDefault,
			runtimeStatus: settingsState.runtimeStatus,
			...(settingsState.runtimeError === undefined
				? {}
				: { runtimeError: settingsState.runtimeError }),
			language: settingsState.language,
			...(this.activeSessionId === undefined
				? {}
				: { activeSessionId: this.activeSessionId }),
			modelSelection: this.modelSelection,
		});
		await this.settingsPanel?.postState(settingsState);
	}

	private async postSettingsState(): Promise<void> {
		if (this.settingsPanel !== undefined) {
			await this.settingsPanel.postState(await this.getSettingsState());
		}
	}

	private async syncWebviewState(): Promise<void> {
		await this.postState();
		await this.postSessionHistory();
		if (this.runtimeReady()) {
			await this.refreshPermissionState();
			await this.refreshPlanModeState();
		}
	}

	private async postMessage(message: HostToWebviewMessage): Promise<void> {
		const view = this.view;
		this.postChain = this.postChain
			.then(async () => {
				await view?.webview.postMessage(message);
			})
			.catch(error => {
				console.error('SeekDock: failed to post a Webview message', error);
			});
		await this.postChain;
	}

	private getHtml(webview: vscode.Webview): string {
		return createWebviewDocument({
			extensionUri: this.extensionUri,
			webview,
			language: this.language,
			title: 'SeekDock',
			scriptFileName: 'webview.js',
		});
	}
}

function toComposerSkill(skill: RuntimeSkillSummary): ComposerSkill | undefined {
	const source = normalizeSkillSource(skill.source);
	if (source === undefined) {
		return undefined;
	}
	return {
		name: skill.name,
		description: skill.description,
		source,
	};
}

function readDisabledSkillNames(globalState: vscode.Memento): readonly string[] {
	const stored = globalState.get<unknown>(DISABLED_SKILLS_STATE_KEY);
	return Array.isArray(stored)
		? stored.filter((name): name is string => typeof name === 'string' && name.length > 0)
		: [];
}

/** Fallback path: open the view container itself when focusing the view fails. */
async function openContainerFallback(): Promise<void> {
	try {
		await vscode.commands.executeCommand(CONTAINER_COMMAND_ID);
	} catch {
		await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
	}
}

function scheduleRefresh(
	previousTimer: NodeJS.Timeout | undefined,
	refresh: () => void,
): NodeJS.Timeout {
	if (previousTimer !== undefined) {
		clearTimeout(previousTimer);
	}
	return setTimeout(refresh, STATE_REFRESH_DEBOUNCE_MS);
}

let activeProvider: ChatViewProvider | undefined;

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	console.log('Congratulations, your extension "seekdock" is now active!');

	// Durable data lives outside the extension storage, which VS Code deletes on uninstall.
	const dataRoot = await resolveDataRoot({ overridePath: process.env[DATA_ROOT_ENV] });
	const provider = new ChatViewProvider(
		context.extensionUri,
		context.secrets,
		vscode.Uri.file(dataRoot),
		context.globalState,
	);
	activeProvider = provider;
	let openPath: 'none' | 'focusView' | 'containerFallback' = 'none';

	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: {
					// The chat DOM carries streaming content and scroll position, so restore it instead of rebuilding.
				retainContextWhenHidden: true,
			},
		})
	);

	// Opening the side bar only takes focusing the view; VS Code reveals a hidden auxiliary bar itself.
	context.subscriptions.push(vscode.commands.registerCommand('seekdock.openSidebar', async () => {
		try {
			await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
			provider.focusInput();
			openPath = 'focusView';
		} catch (error) {
			console.error('SeekDock: failed to focus the chat view, falling back to the container command', error);
			await openContainerFallback();
			openPath = 'containerFallback';
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('seekdock.newChat', async () => {
		if (provider.requestNewChat()) {
			return;
		}
		// The view does not exist yet, so open it first and let the queued clear request run.
		await vscode.commands.executeCommand('seekdock.openSidebar');
	}));

	const openSettings = (): void => provider.openSettings();
	context.subscriptions.push(
		vscode.commands.registerCommand('seekdock.openSettings', openSettings),
		// Compatibility alias for command palettes and keybindings created before the settings panel.
		vscode.commands.registerCommand('seekdock.setApiKey', openSettings),
	);

	// Not declared in package.json; integration tests use it to assert that the view really opened.
	context.subscriptions.push(vscode.commands.registerCommand(
		'seekdock._diagnostics',
		() => ({
			chatViewResolved: provider.resolved,
			settingsPanelResolved: provider.settingsResolved,
			openPath,
			dataRoot,
		})
	));
}

// This method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
	await activeProvider?.shutdown();
	activeProvider = undefined;
}
