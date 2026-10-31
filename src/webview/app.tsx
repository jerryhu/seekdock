import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	ArrowLeft,
	CircleAlert,
	History,
	LoaderCircle,
	RefreshCw,
	Settings as SettingsIcon,
	SquarePen,
} from 'lucide-preact';
import {
	isHostToWebviewMessage,
	type Approval,
	type ApprovalAnswer,
	type ComposerFile,
	type HostToWebviewMessage,
	type PermissionCatalog,
	type PlanReview,
	type PlanReviewAnswer,
	type RuntimeStatus,
	type SessionSummary,
} from '../shared/rpc.ts';
import type {
	WorkspaceChangeSet,
	WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import {
	DEFAULT_MODEL_SELECTION,
	type ModelSelection,
} from '../shared/model-selection.ts';
import type { ComposerSkill } from '../shared/composer-skills.ts';
import {
	createTranslator,
	type Language,
} from '../shared/i18n/index.ts';
import { Composer } from './composer.tsx';
import {
	detectInitialLanguage,
	I18nProvider,
	useI18n,
} from './i18n-context.tsx';
import { MessageList } from './messages.tsx';
import { PlaceholderIcon } from './placeholder-icon.tsx';
import {
	RenameSessionDialog,
	SessionTitleMenu,
} from './session-actions.tsx';
import {
	RecentSessions,
	SessionHistoryPage,
} from './session-history.tsx';
import { Setup } from './setup.tsx';
import { ConversationStore } from './store.ts';
import type { VsCodeApi } from './vscode-api.ts';

interface AppProps {
	store: ConversationStore;
	vscode: VsCodeApi;
}

type SessionReturnTarget = 'home' | 'history';

interface UiState {
	ready: boolean;
	configured: boolean;
	busy: boolean;
	cancelling: boolean;
	runtimeStatus: RuntimeStatus;
	runtimeError?: string;
	savingKey: boolean;
	keyError?: string;
	systemPrompt: string;
	systemPromptIsDefault: boolean;
	permissionCatalog: PermissionCatalog | null;
	permissionCurrent?: string;
	permissionPending?: string;
	permissionError?: string;
	settingPermission: boolean;
	composerFiles: readonly ComposerFile[];
	pickingFiles: boolean;
	fileSelectionError?: string;
	skills: readonly ComposerSkill[];
	skillsLoading: boolean;
	skillError?: string;
	planModeActive: boolean;
	planModePending?: boolean;
	planModeError?: string;
	settingPlanMode: boolean;
	modelSelection: ModelSelection;
	modelSelectionError?: string;
	settingModelSelection: boolean;
	language: Language;
}

/** Root chat Webview that coordinates host state, history, and the composer. */
export function App({ store, vscode }: AppProps): JSX.Element {
	const [view, setView] = useState<'chat' | 'history'>('chat');
	const [sessionReturnTarget, setSessionReturnTarget] = useState<SessionReturnTarget>('home');
	const [conversationOpen, setConversationOpen] = useState(false);
	const [history, setHistory] = useState<{
		sessions: readonly SessionSummary[];
		total: number;
		activeSessionId?: string;
		loading: boolean;
		error?: string;
	}>({
		sessions: [],
		total: 0,
		loading: true,
	});
	const [loadingSessionId, setLoadingSessionId] = useState<string>();
	const [deletingSessionId, setDeletingSessionId] = useState<string>();
	// Deleting the active session recycles DSH to release its write lease. Keep
	// the normal runtime gate hidden until that expected restart reaches `ready`.
	const [runtimeRestartAfterDelete, setRuntimeRestartAfterDelete] = useState(false);
	const [renamingSessionId, setRenamingSessionId] = useState<string>();
	const [renameDialog, setRenameDialog] = useState<{
		sessionId: string;
		title: string;
	}>();
	const [renameError, setRenameError] = useState<string>();
	const [ui, setUi] = useState<UiState>({
		ready: false,
		configured: false,
		busy: false,
		cancelling: false,
		runtimeStatus: 'idle',
		savingKey: false,
		systemPrompt: '',
		systemPromptIsDefault: true,
		permissionCatalog: null,
		settingPermission: false,
		composerFiles: vscode.getState()?.files ?? [],
		pickingFiles: false,
		skills: [],
		skillsLoading: false,
		planModeActive: false,
		settingPlanMode: false,
		modelSelection: { ...DEFAULT_MODEL_SELECTION },
		settingModelSelection: false,
		language: detectInitialLanguage(),
	});
	const [focusToken, setFocusToken] = useState(0);
	const [resetToken, setResetToken] = useState(0);
	const [activeRequestId, setActiveRequestId] = useState<string>();
	const pendingWorkspaceDiffs = useRef(new Map<string, {
		timer: number;
		resolve: (diff: WorkspaceFileDiff | null) => void;
		reject: (error: Error) => void;
	}>());
	const configured = useRef(ui.configured);
	configured.current = ui.configured;
	const initialDraft = vscode.getState()?.draft ?? '';
	const t = createTranslator(ui.language);

	useEffect(() => {
		const state = vscode.getState();
		vscode.setState({
			...(state?.draft === undefined ? {} : { draft: state.draft }),
			files: ui.composerFiles,
		});
	}, [ui.composerFiles, vscode]);

	useEffect(() => {
		const listener = (event: MessageEvent<unknown>): void => {
			if (!isHostToWebviewMessage(event.data)) {
				return;
			}
			handleHostMessage(event.data);
		};
		window.addEventListener('message', listener);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', listener);
	}, [store, vscode]);

	useEffect(() => () => {
		for (const pending of pendingWorkspaceDiffs.current.values()) {
			window.clearTimeout(pending.timer);
		}
		pendingWorkspaceDiffs.current.clear();
	}, []);

	const handleHostMessage = (message: HostToWebviewMessage): void => {
		store.handleHostMessage(message);
		switch (message.type) {
			case 'state':
				if (message.runtimeStatus !== 'initializing') {
					setRuntimeRestartAfterDelete(false);
				}
				setUi(current => ({
					...current,
					ready: true,
					configured: message.hasApiKey,
					busy: message.busy,
					cancelling: false,
					runtimeStatus: message.runtimeStatus,
					runtimeError: message.runtimeError,
					savingKey: false,
					keyError: undefined,
					systemPrompt: message.systemPrompt,
					systemPromptIsDefault: message.systemPromptIsDefault,
					modelSelection: message.modelSelection,
					language: message.language,
				}));
				setHistory(current => ({
					...current,
					activeSessionId: message.activeSessionId,
				}));
				if (message.activeSessionId !== undefined) {
					setConversationOpen(true);
				}
				break;
			case 'busy':
				setUi(current => ({
					...current,
					busy: message.busy,
					...(message.busy ? {} : { cancelling: false }),
				}));
				if (!message.busy) {
					setActiveRequestId(undefined);
				}
				break;
			case 'apiKeyError':
				setUi(current => ({ ...current, savingKey: false, keyError: message.message }));
				break;
			case 'systemPromptSaved':
			case 'systemPromptError':
				break;
			case 'sessionHistory':
				setHistory({
					sessions: message.sessions,
					total: message.total,
					activeSessionId: message.activeSessionId,
					loading: false,
				});
				break;
			case 'sessionHistoryError':
				setHistory(current => ({
					...current,
					loading: false,
					error: message.message,
				}));
				break;
			case 'sessionLoaded':
				store.loadTranscript(message.messages);
				setHistory(current => ({
					...current,
					activeSessionId: message.sessionId,
					loading: false,
					error: undefined,
				}));
				setConversationOpen(true);
				setLoadingSessionId(undefined);
				setView('chat');
				setFocusToken(value => value + 1);
				break;
			case 'sessionLoadError':
				setLoadingSessionId(undefined);
				setHistory(current => ({
					...current,
					loading: false,
					error: message.message,
				}));
				break;
			case 'sessionRenamed':
				setHistory(current => ({
					...current,
					sessions: current.sessions.map(session => session.id === message.sessionId
						? { ...session, title: message.title }
						: session),
					error: undefined,
				}));
				setRenamingSessionId(undefined);
				setRenameDialog(undefined);
				setRenameError(undefined);
				break;
			case 'sessionRenameError':
				setRenamingSessionId(undefined);
				setRenameError(message.message);
				break;
			case 'sessionDeleted':
				if (message.wasActive) {
					store.reset();
					setResetToken(value => value + 1);
					setSessionReturnTarget('home');
					setConversationOpen(false);
					setView('chat');
					setRuntimeRestartAfterDelete(true);
					setUi(current => ({
						...current,
						permissionPending: undefined,
						permissionCurrent: current.permissionCatalog?.defaultPreset,
						permissionError: undefined,
						composerFiles: [],
						pickingFiles: false,
						fileSelectionError: undefined,
						planModeActive: false,
						planModePending: undefined,
						planModeError: undefined,
						settingPlanMode: false,
					}));
					vscode.setState({ draft: '', files: [] });
				}
				setRenameDialog(undefined);
				setRenameError(undefined);
				setDeletingSessionId(undefined);
				setHistory(current => {
					const sessions = current.sessions.filter(
						session => session.id !== message.sessionId,
					);
					return {
						sessions,
						total: sessions.length,
						activeSessionId: message.activeSessionId,
						loading: false,
						error: undefined,
					};
				});
				break;
			case 'sessionDeleteError':
				setDeletingSessionId(undefined);
				setHistory(current => ({
					...current,
					loading: false,
					error: message.message,
				}));
				break;
			case 'permissionState':
				setUi(current => ({
					...current,
					permissionCatalog: message.catalog,
					permissionCurrent: message.current,
					permissionPending: message.pending,
					permissionError: message.error,
					settingPermission: false,
				}));
				break;
			case 'planModeState':
				setUi(current => ({
					...current,
					planModeActive: message.active,
					planModePending: message.pending,
					planModeError: message.error,
					settingPlanMode: false,
				}));
				break;
			case 'filesSelected':
				setUi(current => {
					const files = new Map(current.composerFiles.map(file => [file.id, file]));
					for (const file of message.files) {
						files.set(file.id, file);
					}
					return {
						...current,
						composerFiles: [...files.values()],
						pickingFiles: false,
						fileSelectionError: undefined,
					};
				});
				break;
			case 'filesSelectionError':
				setUi(current => ({
					...current,
					pickingFiles: false,
					fileSelectionError: message.message,
				}));
				break;
			case 'skillCatalog':
				setUi(current => ({
					...current,
					skills: message.skills,
					skillsLoading: false,
					skillError: undefined,
				}));
				break;
			case 'skillCatalogError':
				setUi(current => ({
					...current,
					skillsLoading: false,
					skillError: message.message,
				}));
				break;
			case 'skillOpenError':
				setUi(current => ({
					...current,
					skillError: message.message,
				}));
				break;
			case 'modelSelectionState':
				setUi(current => ({
					...current,
					modelSelection: message.current,
					modelSelectionError: message.error,
					settingModelSelection: false,
				}));
				break;
			case 'workspaceFileDiff': {
				const pending = pendingWorkspaceDiffs.current.get(message.requestId);
				if (pending !== undefined) {
					window.clearTimeout(pending.timer);
					pendingWorkspaceDiffs.current.delete(message.requestId);
					pending.resolve(message.diff);
				}
				break;
			}
			case 'workspaceFileDiffError': {
				const pending = pendingWorkspaceDiffs.current.get(message.requestId);
				if (pending !== undefined) {
					window.clearTimeout(pending.timer);
					pendingWorkspaceDiffs.current.delete(message.requestId);
					pending.reject(new Error(message.message));
				}
				break;
			}
			case 'responseStart':
				setUi(current => ({ ...current, busy: true }));
				break;
			case 'responseEnd':
				setUi(current => ({ ...current, busy: false, cancelling: false }));
				setActiveRequestId(undefined);
				setFocusToken(value => value + 1);
				break;
			case 'cancelResult':
				if (!message.accepted) {
					setUi(current => ({ ...current, cancelling: false }));
				}
				break;
			case 'error':
				setUi(current => ({ ...current, busy: false, cancelling: false }));
				setActiveRequestId(undefined);
				if (configured.current) {
					setFocusToken(value => value + 1);
				}
				break;
			case 'newChat':
				store.reset();
				setActiveRequestId(undefined);
				setSessionReturnTarget('home');
				setConversationOpen(false);
				setRenameDialog(undefined);
				setRenameError(undefined);
				setRenamingSessionId(undefined);
				setHistory(current => ({
					...current,
					activeSessionId: undefined,
					error: undefined,
				}));
				setUi(current => ({
					...current,
					permissionPending: undefined,
					permissionCurrent: current.permissionCatalog?.defaultPreset,
					permissionError: undefined,
					composerFiles: [],
					pickingFiles: false,
					fileSelectionError: undefined,
					planModeActive: false,
					planModePending: undefined,
					planModeError: undefined,
					settingPlanMode: false,
					settingPermission: false,
				}));
				vscode.setState({ draft: '', files: [] });
				setView('chat');
				setResetToken(value => value + 1);
				setFocusToken(value => value + 1);
				break;
			case 'focus':
				setFocusToken(value => value + 1);
				break;
			default:
				break;
		}
	};

	const send = (text: string): void => {
		if (ui.runtimeStatus !== 'ready') {
			return;
		}
		if (history.activeSessionId === undefined) {
			setSessionReturnTarget('home');
		}
		const requestId = crypto.randomUUID();
		if (!store.beginRequest(requestId, text)) {
			return;
		}
		setUi(current => ({
			...current,
			busy: true,
			composerFiles: [],
			fileSelectionError: undefined,
		}));
		setActiveRequestId(requestId);
		setConversationOpen(true);
		vscode.postMessage({ type: 'chat', requestId, text });
	};

	const selectPermission = (preset: string): void => {
		setUi(current => ({
			...current,
			settingPermission: true,
			permissionError: undefined,
		}));
		vscode.postMessage({
			type: 'setPermission',
			requestId: crypto.randomUUID(),
			preset,
		});
	};

	const selectPlanMode = (active: boolean): void => {
		setUi(current => ({
			...current,
			settingPlanMode: true,
			planModeError: undefined,
		}));
		vscode.postMessage({
			type: 'setPlanMode',
			requestId: crypto.randomUUID(),
			active,
		});
	};

	const pickFiles = (): void => {
		if (ui.pickingFiles) {
			return;
		}
		setUi(current => ({
			...current,
			pickingFiles: true,
			fileSelectionError: undefined,
		}));
		vscode.postMessage({ type: 'pickFiles', requestId: crypto.randomUUID() });
	};

	const removeComposerFile = (id: string): void => {
		setUi(current => ({
			...current,
			composerFiles: current.composerFiles.filter(file => file.id !== id),
		}));
	};

	const requestSkills = (): void => {
		if (ui.skillsLoading) {
			return;
		}
		setUi(current => ({
			...current,
			skillsLoading: true,
			skillError: undefined,
		}));
		vscode.postMessage({ type: 'requestSkills', requestId: crypto.randomUUID() });
	};

	const openSkill = (name: string): void => {
		setUi(current => ({ ...current, skillError: undefined }));
		vscode.postMessage({ type: 'openSkill', requestId: crypto.randomUUID(), name });
	};

	const selectModelSelection = (selection: ModelSelection): void => {
		setUi(current => ({
			...current,
			modelSelection: selection,
			modelSelectionError: undefined,
			settingModelSelection: true,
		}));
		vscode.postMessage({
			type: 'setModelSelection',
			requestId: crypto.randomUUID(),
			model: selection.model,
			reasoningEffort: selection.reasoningEffort,
		});
	};

	const answerApproval = (approval: Approval, decision: ApprovalAnswer): void => {
		vscode.postMessage({
			type: 'approvalResponse',
			requestId: crypto.randomUUID(),
			approvalId: approval.id,
			...(approval.toolCallId === undefined ? {} : { toolCallId: approval.toolCallId }),
			decision,
		});
	};

	const answerPlanReview = (
		review: PlanReview,
		decision: PlanReviewAnswer,
		feedback: string,
	): void => {
		vscode.postMessage({
			type: 'planReviewResponse',
			requestId: crypto.randomUUID(),
			reviewId: review.id,
			decision,
			...(feedback.length === 0 ? {} : { feedback }),
		});
	};

	const requestWorkspaceDiff = (
		changes: WorkspaceChangeSet,
		index: number,
	): Promise<WorkspaceFileDiff | null> => {
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				pendingWorkspaceDiffs.current.delete(requestId);
				reject(new Error(t('workspaceDiffUnavailable')));
			}, 15_000);
			pendingWorkspaceDiffs.current.set(requestId, { timer, resolve, reject });
			vscode.postMessage({
				type: 'requestWorkspaceFileDiff',
				requestId,
				sessionId: changes.sessionId,
				seq: changes.seq,
				index,
			});
		});
	};

	const openWorkspaceDiff = (changes: WorkspaceChangeSet, index: number): void => {
		vscode.postMessage({
			type: 'openWorkspaceFileDiff',
			requestId: crypto.randomUUID(),
			sessionId: changes.sessionId,
			seq: changes.seq,
			index,
		});
	};

	const stop = (): void => {
		if (!ui.busy || activeRequestId === undefined || ui.cancelling) {
			return;
		}
		setUi(current => ({ ...current, cancelling: true }));
		vscode.postMessage({
			type: 'cancel',
			requestId: crypto.randomUUID(),
			targetRequestId: activeRequestId,
		});
	};

	const saveApiKey = (apiKey: string): void => {
		setUi(current => ({ ...current, savingKey: true, keyError: undefined }));
		vscode.postMessage({ type: 'saveApiKey', requestId: crypto.randomUUID(), apiKey });
	};

	const openLink = (url: string): void => {
		vscode.postMessage({ type: 'openExternal', requestId: crypto.randomUUID(), url });
	};

	const refreshHistory = (): void => {
		setHistory(current => ({ ...current, loading: true, error: undefined }));
		vscode.postMessage({ type: 'requestSessionHistory', requestId: crypto.randomUUID() });
	};

	const selectSession = (sessionId: string, returnTarget: SessionReturnTarget): void => {
		if (ui.busy || loadingSessionId !== undefined || deletingSessionId !== undefined) {
			return;
		}
		setSessionReturnTarget(returnTarget);
		setLoadingSessionId(sessionId);
		setHistory(current => ({ ...current, error: undefined }));
		vscode.postMessage({
			type: 'loadSession',
			requestId: crypto.randomUUID(),
			sessionId,
		});
	};

	const deleteSession = (sessionId: string): void => {
		if (ui.busy || loadingSessionId !== undefined || deletingSessionId !== undefined) {
			return;
		}
		setDeletingSessionId(sessionId);
		setHistory(current => ({ ...current, error: undefined }));
		vscode.postMessage({
			type: 'deleteSession',
			requestId: crypto.randomUUID(),
			sessionId,
		});
	};

	const requestRenameSession = (session: SessionSummary): void => {
		if (ui.busy || loadingSessionId !== undefined || deletingSessionId !== undefined) {
			return;
		}
		setRenameDialog({ sessionId: session.id, title: session.title });
		setRenameError(undefined);
	};

	const renameSession = (title: string): void => {
		if (renameDialog === undefined
			|| ui.busy
			|| renamingSessionId !== undefined
			|| title.trim().length === 0) {
			return;
		}
		setRenamingSessionId(renameDialog.sessionId);
		setRenameError(undefined);
		vscode.postMessage({
			type: 'renameSession',
			requestId: crypto.randomUUID(),
			sessionId: renameDialog.sessionId,
			title,
		});
	};

	const startNewChat = (): void => {
		if (ui.busy) {
			return;
		}
		vscode.postMessage({ type: 'newChat', requestId: crypto.randomUUID() });
	};

	// Leaving the history page is Webview-local on purpose: while a turn runs the
	// Host rejects every session request, and a navigation must never wait for it.
	const backToChat = (): void => {
		setView('chat');
	};

	const returnFromSession = (): void => {
		if (sessionReturnTarget === 'history') {
			refreshHistory();
			setView('history');
			return;
		}
		startNewChat();
	};

	const retryRuntime = (): void => {
		setUi(current => ({
			...current,
			runtimeStatus: 'initializing',
			runtimeError: undefined,
		}));
		vscode.postMessage({ type: 'retryRuntime', requestId: crypto.randomUUID() });
	};

	const openSettings = (): void => {
		vscode.postMessage({ type: 'openSettings', requestId: crypto.randomUUID() });
	};

	const openHistoryPage = (): void => {
		refreshHistory();
		setView('history');
	};

	if (!ui.ready) {
		return (
			<I18nProvider language={ui.language}>
				<InitializingView />
			</I18nProvider>
		);
	}

	if (view === 'history') {
		return (
			<I18nProvider language={ui.language}>
			<SessionHistoryPage
				sessions={history.sessions}
				activeSessionId={history.activeSessionId}
				loading={history.loading}
				error={history.error}
				busy={ui.busy}
				onBack={backToChat}
				onDelete={deleteSession}
				onRefresh={refreshHistory}
				onSelect={(sessionId) => selectSession(sessionId, 'history')}
				deletingSessionId={deletingSessionId}
			/>
			</I18nProvider>
		);
	}

	if (!ui.configured) {
		return (
			<I18nProvider language={ui.language}>
			<Setup
				error={ui.keyError}
				focusToken={focusToken}
				saving={ui.savingKey}
				onSubmit={saveApiKey}
			/>
			</I18nProvider>
		);
	}

	const reconfiguringModel = ui.settingModelSelection && ui.runtimeStatus === 'initializing';
	const restartingRuntimeAfterDelete = runtimeRestartAfterDelete
		&& ui.runtimeStatus === 'initializing';
	if (ui.runtimeStatus !== 'ready' && !reconfiguringModel && !restartingRuntimeAfterDelete) {
		return (
			<I18nProvider language={ui.language}>
			<RuntimeGate
					error={ui.runtimeStatus === 'error'
						? ui.runtimeError ?? t('harnessInitFailed')
						: undefined}
				onOpenSettings={openSettings}
				onRetry={retryRuntime}
			/>
			</I18nProvider>
		);
	}

	const activeSession = history.sessions.find(
		session => session.id === history.activeSessionId,
	);

	return (
		<I18nProvider language={ui.language}>
		<div className="app-shell">
			<header className="app-header">
				<div className="app-heading">
					{history.activeSessionId !== undefined
						? (
							<button
								type="button"
								className="icon-button session-back-button"
								aria-label={t('back')}
								data-tooltip-placement="bottom"
								data-tooltip-align="start"
								disabled={ui.busy || deletingSessionId !== undefined}
								onClick={returnFromSession}
							>
								<ArrowLeft size={16} />
							</button>
						)
						: null}
					<div className="session-title-group">
						<span className="app-title">{activeSession?.title ?? t('session')}</span>
					</div>
				</div>
				<div className="app-actions">
					{activeSession !== undefined
						? (
							<SessionTitleMenu
								title={activeSession.title}
								disabled={ui.busy
									|| loadingSessionId !== undefined
									|| deletingSessionId !== undefined}
								deleting={deletingSessionId === activeSession.id}
								onRename={() => requestRenameSession(activeSession)}
								onDelete={() => deleteSession(activeSession.id)}
							/>
						)
						: null}
					<button
						type="button"
						className="icon-button"
						aria-label={t('history')}
						data-tooltip={t('history')}
						data-tooltip-placement="bottom"
						data-tooltip-align="end"
						onClick={openHistoryPage}
					>
						<History size={15} />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t('settings')}
						data-tooltip={t('settings')}
						data-tooltip-placement="bottom"
						data-tooltip-align="end"
						onClick={() => {
							openSettings();
						}}
					>
						<SettingsIcon size={15} />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t('newChat')}
						data-tooltip={t('newChat')}
						data-tooltip-placement="bottom"
						data-tooltip-align="end"
						disabled={ui.busy}
						onClick={startNewChat}
					>
						<SquarePen size={15} />
					</button>
				</div>
			</header>
			{loadingSessionId !== undefined
				? (
					<div className="session-loading-banner" role="status">
						<LoaderCircle size={13} className="spin" />
						<span>{t('loadingSessions')}</span>
					</div>
				)
				: null}
			{conversationOpen
				? (
					<MessageList
						store={store}
						onOpenLink={openLink}
						onApprovalAnswer={answerApproval}
						onPlanReviewAnswer={answerPlanReview}
						onRequestWorkspaceDiff={requestWorkspaceDiff}
						onOpenWorkspaceDiff={openWorkspaceDiff}
					/>
				)
				: (
					<div className="home-page">
						<div className="home-content">
							<RecentSessions
								sessions={history.sessions}
								total={history.total}
								loading={history.loading}
								error={history.error}
								onSelect={(sessionId) => selectSession(sessionId, 'home')}
								onViewAll={openHistoryPage}
							/>
								<div className="home-placeholder">
									<PlaceholderIcon className="home-placeholder-icon" />
								</div>
						</div>
					</div>
				)}
			<Composer
				busy={ui.busy}
				cancelling={ui.cancelling}
				configured={ui.configured}
				runtimeReady={ui.runtimeStatus === 'ready'}
				focusToken={focusToken}
				resetToken={resetToken}
				initialDraft={initialDraft}
				files={ui.composerFiles}
				pickingFiles={ui.pickingFiles}
				{...(ui.fileSelectionError === undefined
					? {}
					: { fileSelectionError: ui.fileSelectionError })}
				skills={ui.skills}
				skillsLoading={ui.skillsLoading}
				{...(ui.skillError === undefined ? {} : { skillError: ui.skillError })}
				onRequestSkills={requestSkills}
				onOpenSkill={openSkill}
				planModeActive={ui.planModeActive}
				{...(ui.planModePending === undefined
					? {}
					: { planModePending: ui.planModePending })}
				{...(ui.planModeError === undefined ? {} : { planModeError: ui.planModeError })}
				settingPlanMode={ui.settingPlanMode}
				onPickFiles={pickFiles}
				onRemoveFile={removeComposerFile}
				onSetPlanMode={selectPlanMode}
				permissionCatalog={ui.permissionCatalog}
				{...(ui.permissionCurrent === undefined ? {} : { permissionCurrent: ui.permissionCurrent })}
				{...(ui.permissionPending === undefined ? {} : { permissionPending: ui.permissionPending })}
				{...(ui.permissionError === undefined ? {} : { permissionError: ui.permissionError })}
				settingPermission={ui.settingPermission}
				onSelectPermission={selectPermission}
				modelSelection={ui.modelSelection}
				{...(ui.modelSelectionError === undefined
					? {}
					: { modelSelectionError: ui.modelSelectionError })}
				settingModelSelection={ui.settingModelSelection}
				onSelectModelSelection={selectModelSelection}
				onSend={send}
				onStop={stop}
				vscode={vscode}
			/>
			{renameDialog !== undefined
				? (
					<RenameSessionDialog
						title={renameDialog.title}
						submitting={renamingSessionId === renameDialog.sessionId}
						error={renameError}
						onCancel={() => {
							if (renamingSessionId === undefined) {
								setRenameDialog(undefined);
								setRenameError(undefined);
							}
						}}
						onSubmit={renameSession}
					/>
				)
				: null}
		</div>
		</I18nProvider>
	);
}

interface RuntimeGateProps {
	error: string | undefined;
	onOpenSettings: () => void;
	onRetry: () => void;
}

function RuntimeGate({
	error,
	onOpenSettings,
	onRetry,
}: RuntimeGateProps): JSX.Element {
	const { t } = useI18n();
	if (error !== undefined) {
		return (
			<div className="runtime-gate" role="alert">
				<CircleAlert size={24} className="runtime-gate-error-icon" />
				<p className="runtime-gate-title">{t('runtimeInitFailedTitle')}</p>
				<p className="runtime-gate-detail">{error}</p>
				<div className="runtime-gate-actions">
					<button type="button" className="primary-button" onClick={onRetry}>
						<RefreshCw size={14} />
						<span>{t('retry')}</span>
					</button>
					<button type="button" className="secondary-button" onClick={onOpenSettings}>
						<SettingsIcon size={14} />
						<span>{t('settings')}</span>
					</button>
				</div>
			</div>
		);
	}

	return (
		<InitializingView />
	);
}

function InitializingView(): JSX.Element {
	const { t } = useI18n();
	return (
		<div
			className="runtime-initializing"
			role="status"
			aria-live="polite"
			aria-label={t('initializingHarnessAria')}
		>
			<p className="runtime-initializing-status">{t('initializingHarness')}</p>
			<div className="runtime-initializing-dots" aria-hidden="true">
				<span></span>
				<span></span>
				<span></span>
				<span></span>
				<span></span>
			</div>
		</div>
	);
}
