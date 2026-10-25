import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import {
	ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalQuestion,
} from './host/approval-broker.ts';
import { resolveDshRuntime } from './host/dsh-runtime.ts';
import { formatErrorMessage as formatError } from './host/error-format.ts';
import type { HarnessActivityEvent } from './host/harness-events.ts';
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
	isWebviewToHostMessage,
	type ComposerFile,
	type HostToWebviewMessage,
	type PermissionCatalog,
	type RuntimeStatus,
	type WebviewToHostMessage,
} from './shared/rpc.ts';

/** package.json 中 contributes.views 声明的视图 ID。 */
const VIEW_ID = 'seekdock.chatView';

/** 视图容器的打开命令，由 VS Code 依据 contributes.viewsContainers 自动注册。 */
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
 * 右侧栏（辅助侧边栏 / Secondary Side Bar）聊天视图的 Webview 提供者。
 *
 * 视图本身由 package.json 声明在 secondarySidebar 容器中，因此无需运行时
 * 手动搬移；这里只负责填充 Webview 内容并与之通信。
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
	private approvalBroker: ApprovalBroker | undefined;
	private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
	private readonly earlyApprovalDecisions = new Map<
		string,
		{ outcome: ApprovalOutcome; expiresAt: number }
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
	}

	/** Webview 是否已被 VS Code 创建，用于判断视图是否真正打开过。 */
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
			// 只允许加载插件自身目录下的资源，避免 Webview 读取任意本地文件。
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
			this.cancelPendingApprovals('cancelled');
		});

		// Webview 可能是按需创建的，补发在此之前排队的「新建会话」请求。
		if (this.pendingNewChat) {
			this.pendingNewChat = false;
			void webviewView.webview.postMessage({ type: 'newChat' });
		}
	}

	/**
	 * 清空会话。视图已就绪时立即生效，否则先记下待办，
	 * 待 Webview 创建后补发。返回是否已直接生效。
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
		void this.shutdown();
	}

	/** Stop the runtime and wait for it to exit. */
	shutdown(): Promise<void> {
		this.shutdownPromise ??= (async () => {
			this.cancelPendingApprovals('cancelled');
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
		this.cancelPendingApprovals('cancelled');
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
			const loaded = await this.getHistoryStore().load(message.sessionId);
			this.cancelPendingApprovals('cancelled');
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
			this.cancelPendingApprovals('cancelled');
			await this.postMessage({ type: 'busy', busy: false });
			await this.postSettingsState();
			await this.postSessionHistory();
		}
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

	/** Resolve every pending question with a closed outcome. */
	private cancelPendingApprovals(outcome: ApprovalOutcome): void {
		for (const [key, resolve] of this.pendingApprovals) {
			this.pendingApprovals.delete(key);
			resolve(outcome);
		}
		this.earlyApprovalDecisions.clear();
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

	private async createRunner(): Promise<HarnessRunner> {
		await this.promptStore.syncRuntimePrompt();
		const runtime = resolveDshRuntime(this.extensionUri.fsPath);
		this.approvalBroker ??= new ApprovalBroker({
			onQuestion: question => this.requestApproval(question),
		});
		await this.approvalBroker.start();
		const runner = new HarnessRunner({
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
			dshHome: vscode.Uri.joinPath(this.storageUri, 'dsh-home').fsPath,
			homePath: vscode.Uri.joinPath(this.storageUri, 'runtime-home').fsPath,
			patchPath: vscode.Uri.joinPath(
				this.extensionUri,
				'resources',
				'dsh',
				'seekdock-chat.cordis.patch.yml',
			).fsPath,
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

/** 兜底路径：聚焦视图失败时改为打开视图容器本身。 */
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
export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "seekdock" is now active!');

	const provider = new ChatViewProvider(
		context.extensionUri,
		context.secrets,
		context.globalStorageUri,
		context.globalState,
	);
	activeProvider = provider;
	let openPath: 'none' | 'focusView' | 'containerFallback' = 'none';

	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: {
					// 聊天 DOM 包含流式内容与滚动位置，切回时应原样恢复而非重建。
				retainContextWhenHidden: true,
			},
		})
	);

	// 打开右侧栏：聚焦视图即可，VS Code 会自动展开当前隐藏的辅助侧边栏。
	context.subscriptions.push(vscode.commands.registerCommand('seekdock.openSidebar', async () => {
		try {
			await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
			provider.focusInput();
			openPath = 'focusView';
		} catch (error) {
			console.error('SeekDock: 聚焦聊天视图失败，改用容器命令兜底', error);
			await openContainerFallback();
			openPath = 'containerFallback';
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('seekdock.newChat', async () => {
		if (provider.requestNewChat()) {
			return;
		}
		// 视图还没创建，先打开再补发清空指令。
		await vscode.commands.executeCommand('seekdock.openSidebar');
	}));

	const openSettings = (): void => provider.openSettings();
	context.subscriptions.push(
		vscode.commands.registerCommand('seekdock.openSettings', openSettings),
		// Compatibility alias for command palettes and keybindings created before the settings panel.
		vscode.commands.registerCommand('seekdock.setApiKey', openSettings),
	);

	// 未在 package.json 中声明，仅供集成测试断言视图是否真正打开过。
	context.subscriptions.push(vscode.commands.registerCommand(
		'seekdock._diagnostics',
		() => ({
			chatViewResolved: provider.resolved,
			settingsPanelResolved: provider.settingsResolved,
			openPath,
		})
	));
}

// This method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
	await activeProvider?.shutdown();
	activeProvider = undefined;
}
