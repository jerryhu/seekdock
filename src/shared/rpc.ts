import {
	isModelSelection,
	type ModelSelection,
} from './model-selection.ts';
import type { ComposerSkill } from './composer-skills.ts';
import { isLanguage, type Language } from './i18n/index.ts';
import {
	isNonEmptyString,
	isNonNegativeInteger,
	isPositiveInteger,
	isRecord,
} from './value-validation.ts';
import {
	isWorkspaceChangeSet,
	isWorkspaceFileDiff,
	type WorkspaceChangeSet,
	type WorkspaceFileDiff,
} from './workspace-changes.ts';

/** Lifecycle of one tool invocation shown in the chat timeline. */
export type ToolCallStatus = 'running' | 'completed' | 'error' | 'awaiting-approval';

/** A tool failure that can be resolved by re-observing the target file. */
export type RecoverableToolError = 'file-not-read' | 'file-changed';

/** Serialized tool invocation shared by the extension host and Webview. */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
	status: ToolCallStatus;
	result?: string;
	error?: string;
	/** Known recoverable failure category used for retry-aware presentation. */
	recoverableError?: RecoverableToolError;
}

/** Assistant content persisted by DSH and rendered in the chat transcript. */
export type AssistantContentBlock =
	| { kind: 'text'; text: string }
	| { kind: 'reasoning'; text: string };

/** One process-local assistant delta forwarded from the DSH runtime. */
export interface AssistantStreamDelta {
	attemptId: string;
	turn: number;
	step: number;
	blockIndex: number;
	kind: 'text' | 'reasoning' | 'tool';
	text: string;
}

/** Closed outcome of an approval question, mirroring DSH's vocabulary. */
export type ApprovalDecision = 'allowed' | 'rejected' | 'cancelled' | 'unavailable';

/** The two answers SeekDock can send for a pending approval. */
export type ApprovalAnswer = 'allow' | 'deny';

/** An approval requested by DSH for a specific tool call. */
export interface Approval {
	id: string;
	toolCallId?: string;
	toolName: string;
	reason?: string;
	/** Localized presentation text supplied by DSH for this question. */
	displayReason?: string;
	/** Set once the question has a closed outcome. */
	decision?: ApprovalDecision;
}

/** Closed outcome of a plan review card shared with the UI. */
export type PlanReviewDecision = 'approved' | 'keep-planning' | 'cancelled' | 'unavailable';

/** The two answers SeekDock offers for a plan under review. */
export type PlanReviewAnswer = 'approve' | 'keep-planning';

/** One plan that DSH's exit_plan_mode tool submitted for review. */
export interface PlanReview {
	id: string;
	/** Plan markdown under review. */
	plan: string;
	/** Set once the review has a closed outcome. */
	decision?: PlanReviewDecision;
}

/** One selectable permission preset. */
export interface PermissionOption {
	value: string;
	name: string;
	description?: string;
}

/** Process-level permission catalog published by DSH. */
export interface PermissionCatalog {
	options: readonly PermissionOption[];
	defaultOptions: readonly PermissionOption[];
	defaultPreset: string;
}

/** One file selected from the VS Code file picker for the composer. */
export interface ComposerFile {
	/** Stable identity derived from the host path. */
	id: string;
	/** Final path segment shown on the composer chip. */
	name: string;
	/** Workspace-relative or absolute host path. */
	path: string;
	/** Ready-to-send `@path` or `@"path with spaces"` reference. */
	mention: string;
}

/** One persisted DSH session shown in the history list. */
export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

/** Lifecycle of the DSH runtime shown by the chat view. */
export type RuntimeStatus = 'idle' | 'initializing' | 'ready' | 'error';

/** One replayed entry in a historical assistant turn. */
export type TranscriptEntry =
	| { kind: 'text'; id: string; text: string }
	| { kind: 'reasoning'; id: string; text: string }
	| { kind: 'tool'; id: string; call: ToolCall };

/** One replayed chat message loaded from a DSH session log. */
export type TranscriptMessage =
	| { kind: 'user'; id: string; text: string; createdAt: number }
	| {
		kind: 'assistant';
		id: string;
		entries: readonly TranscriptEntry[];
		createdAt: number;
		durationMs?: number;
		/** Changed-file card persisted by SeekDock for this turn. */
		changes?: WorkspaceChangeSet;
	};

/** Messages posted by the chat Webview to the extension host. */
export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'chat'; requestId: string; text: string }
	| { type: 'cancel'; requestId: string; targetRequestId: string }
	| { type: 'newChat'; requestId: string }
	| { type: 'requestSkills'; requestId: string }
	| { type: 'openSkill'; requestId: string; name: string }
	| { type: 'requestSessionHistory'; requestId: string }
	| { type: 'loadSession'; requestId: string; sessionId: string }
	| { type: 'renameSession'; requestId: string; sessionId: string; title: string }
	| { type: 'deleteSession'; requestId: string; sessionId: string }
	| { type: 'saveApiKey'; requestId: string; apiKey: string }
	| { type: 'saveSystemPrompt'; requestId: string; prompt: string }
	| { type: 'resetSystemPrompt'; requestId: string }
	| { type: 'openSettings'; requestId: string }
	| { type: 'retryRuntime'; requestId: string }
	| { type: 'setPermission'; requestId: string; preset: string }
	| { type: 'setPlanMode'; requestId: string; active: boolean }
	| { type: 'pickFiles'; requestId: string }
	| {
		type: 'setModelSelection';
		requestId: string;
		model: string;
		reasoningEffort: string;
	}
	| {
		type: 'approvalResponse';
		requestId: string;
		approvalId: string;
		toolCallId?: string;
		decision: ApprovalAnswer;
	}
	| {
		type: 'planReviewResponse';
		requestId: string;
		reviewId: string;
		decision: PlanReviewAnswer;
		feedback?: string;
	}
	| {
		type: 'requestWorkspaceFileDiff';
		requestId: string;
		sessionId: string;
		seq: number;
		index: number;
	}
	| {
		type: 'openWorkspaceFileDiff';
		requestId: string;
		sessionId: string;
		seq: number;
		index: number;
	}
	| { type: 'openExternal'; requestId: string; url: string };

/** Messages posted by the extension host to the chat Webview. */
export type HostToWebviewMessage =
	| {
		type: 'state';
		hasApiKey: boolean;
		busy: boolean;
		systemPrompt: string;
		systemPromptIsDefault: boolean;
		runtimeStatus: RuntimeStatus;
		runtimeError?: string;
		activeSessionId?: string;
		modelSelection: ModelSelection;
		language: Language;
	}
	| { type: 'busy'; busy: boolean }
	| { type: 'apiKeyError'; message: string }
	| { type: 'systemPromptSaved'; requestId: string; isDefault: boolean }
	| { type: 'systemPromptError'; requestId: string; message: string }
	| {
		type: 'sessionHistory';
		sessions: readonly SessionSummary[];
		total: number;
		activeSessionId?: string;
	}
	| { type: 'sessionHistoryError'; requestId: string; message: string }
	| {
		type: 'sessionLoaded';
		requestId: string;
		sessionId: string;
		title: string;
		messages: readonly TranscriptMessage[];
	}
	| { type: 'sessionLoadError'; requestId: string; message: string }
	| {
		type: 'sessionRenamed';
		requestId: string;
		sessionId: string;
		title: string;
	}
	| { type: 'sessionRenameError'; requestId: string; message: string }
	| {
		type: 'sessionDeleted';
		requestId: string;
		sessionId: string;
		wasActive: boolean;
		activeSessionId?: string;
	}
	| { type: 'sessionDeleteError'; requestId: string; message: string }
	| { type: 'responseStart'; requestId: string }
	| {
		type: 'assistantStreamStart';
		requestId: string;
		attemptId: string;
		turn: number;
		step: number;
	}
	| {
		type: 'assistantStreamDelta';
		requestId: string;
		deltas: readonly AssistantStreamDelta[];
	}
	| { type: 'assistantStreamEnd'; requestId: string; attemptId: string }
	| {
		type: 'assistantMessage';
		requestId: string;
		turn: number;
		step: number;
		blocks: readonly AssistantContentBlock[];
		interrupted?: boolean;
	}
	| { type: 'toolCallStart'; requestId: string; call: ToolCall }
	| { type: 'toolCallUpdate'; requestId: string; call: ToolCall }
	| { type: 'approvalRequest'; requestId: string; approval: Approval }
	| {
		type: 'approvalResolved';
		approvalId: string;
		toolCallId?: string;
		decision: ApprovalDecision;
	}
	| { type: 'planReviewRequest'; requestId: string; review: PlanReview }
	| { type: 'planReviewResolved'; reviewId: string; decision: PlanReviewDecision }
	| {
		type: 'permissionState';
		catalog: PermissionCatalog | null;
		current?: string;
		pending?: string;
		error?: string;
	}
	| {
		type: 'planModeState';
		active: boolean;
		pending?: boolean;
		error?: string;
	}
	| {
		type: 'filesSelected';
		requestId: string;
		files: readonly ComposerFile[];
	}
	| { type: 'filesSelectionError'; requestId: string; message: string }
	| {
		type: 'skillCatalog';
		requestId: string;
		skills: readonly ComposerSkill[];
	}
	| { type: 'skillCatalogError'; requestId: string; message: string }
	| { type: 'skillOpenError'; requestId: string; message: string }
	| {
		type: 'modelSelectionState';
		current: ModelSelection;
		error?: string;
	}
	| {
		type: 'workspaceChanges';
		requestId: string;
		changes: WorkspaceChangeSet;
	}
	| {
		type: 'workspaceFileDiff';
		requestId: string;
		diff: WorkspaceFileDiff | null;
	}
	| { type: 'workspaceFileDiffError'; requestId: string; message: string }
	| { type: 'responseEnd'; requestId: string; interrupted?: boolean }
	| {
		type: 'cancelResult';
		requestId: string;
		accepted: boolean;
		message?: string;
	}
	| { type: 'error'; requestId: string; message: string }
	| { type: 'newChat' }
	| { type: 'focus' };

/** @returns whether a Webview message matches the host-side RPC contract. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'ready':
			return true;
		case 'chat':
			return isNonEmptyString(value.requestId) && typeof value.text === 'string';
		case 'cancel':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.targetRequestId);
		case 'newChat':
		case 'requestSessionHistory':
			return isNonEmptyString(value.requestId);
		case 'requestSkills':
			return isNonEmptyString(value.requestId);
		case 'openSkill':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.name);
		case 'loadSession':
		case 'deleteSession':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.sessionId);
		case 'renameSession':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.sessionId)
				&& typeof value.title === 'string';
		case 'saveApiKey':
			return isNonEmptyString(value.requestId) && typeof value.apiKey === 'string';
		case 'saveSystemPrompt':
			return isNonEmptyString(value.requestId) && typeof value.prompt === 'string';
		case 'resetSystemPrompt':
		case 'openSettings':
		case 'retryRuntime':
			return isNonEmptyString(value.requestId);
		case 'setPermission':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.preset);
		case 'setPlanMode':
			return isNonEmptyString(value.requestId) && typeof value.active === 'boolean';
		case 'pickFiles':
			return isNonEmptyString(value.requestId);
		case 'setModelSelection':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.model)
				&& isNonEmptyString(value.reasoningEffort);
		case 'approvalResponse':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.approvalId)
				&& (value.toolCallId === undefined || isNonEmptyString(value.toolCallId))
				&& (value.decision === 'allow' || value.decision === 'deny');
		case 'planReviewResponse':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.reviewId)
				&& (value.decision === 'approve' || value.decision === 'keep-planning')
				&& (value.feedback === undefined || typeof value.feedback === 'string');
		case 'requestWorkspaceFileDiff':
		case 'openWorkspaceFileDiff':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.sessionId)
				&& isNonNegativeInteger(value.seq)
				&& isNonNegativeInteger(value.index);
		case 'openExternal':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.url);
		default:
			return false;
	}
}

/** @returns whether a host message matches the Webview-side RPC contract. */
export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'state':
			return typeof value.hasApiKey === 'boolean'
				&& typeof value.busy === 'boolean'
				&& typeof value.systemPrompt === 'string'
				&& typeof value.systemPromptIsDefault === 'boolean'
				&& isRuntimeStatus(value.runtimeStatus)
				&& (value.runtimeError === undefined || typeof value.runtimeError === 'string')
				&& (value.activeSessionId === undefined || isNonEmptyString(value.activeSessionId))
				&& isModelSelection(value.modelSelection)
				&& isLanguage(value.language);
		case 'busy':
			return typeof value.busy === 'boolean';
		case 'apiKeyError':
			return typeof value.message === 'string';
		case 'systemPromptSaved':
			return isNonEmptyString(value.requestId) && typeof value.isDefault === 'boolean';
		case 'systemPromptError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'sessionHistory':
			return Array.isArray(value.sessions)
				&& value.sessions.every(isSessionSummary)
				&& isNonNegativeInteger(value.total)
				&& (value.activeSessionId === undefined || isNonEmptyString(value.activeSessionId));
		case 'sessionHistoryError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'sessionLoaded':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.sessionId)
				&& typeof value.title === 'string'
				&& Array.isArray(value.messages)
				&& value.messages.every(isTranscriptMessage);
		case 'sessionLoadError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'sessionRenamed':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.sessionId)
				&& isNonEmptyString(value.title);
		case 'sessionRenameError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'sessionDeleted':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.sessionId)
				&& typeof value.wasActive === 'boolean'
				&& (value.activeSessionId === undefined || isNonEmptyString(value.activeSessionId));
		case 'sessionDeleteError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'responseStart':
			return isNonEmptyString(value.requestId);
		case 'responseEnd':
			return isNonEmptyString(value.requestId)
				&& (value.interrupted === undefined || value.interrupted === true);
		case 'cancelResult':
			return isNonEmptyString(value.requestId)
				&& typeof value.accepted === 'boolean'
				&& (value.message === undefined || typeof value.message === 'string');
		case 'assistantStreamStart':
			return isNonEmptyString(value.requestId)
				&& isNonEmptyString(value.attemptId)
				&& isPositiveInteger(value.turn)
				&& isPositiveInteger(value.step);
		case 'assistantStreamDelta':
			return isNonEmptyString(value.requestId)
				&& Array.isArray(value.deltas)
				&& value.deltas.length > 0
				&& value.deltas.every(isAssistantStreamDelta);
		case 'assistantStreamEnd':
			return isNonEmptyString(value.requestId) && isNonEmptyString(value.attemptId);
		case 'assistantMessage':
			return isNonEmptyString(value.requestId)
				&& isPositiveInteger(value.turn)
				&& isPositiveInteger(value.step)
				&& Array.isArray(value.blocks)
				&& value.blocks.every(isAssistantContentBlock)
				&& (value.interrupted === undefined || value.interrupted === true);
		case 'toolCallStart':
		case 'toolCallUpdate':
			return isNonEmptyString(value.requestId) && isToolCall(value.call);
		case 'approvalRequest':
			return isNonEmptyString(value.requestId) && isApproval(value.approval);
		case 'approvalResolved':
			return isNonEmptyString(value.approvalId)
				&& (value.toolCallId === undefined || isNonEmptyString(value.toolCallId))
				&& isApprovalDecision(value.decision);
		case 'planReviewRequest':
			return isNonEmptyString(value.requestId) && isPlanReview(value.review);
		case 'planReviewResolved':
			return isNonEmptyString(value.reviewId) && isPlanReviewDecision(value.decision);
		case 'permissionState':
			return (value.catalog === null || isPermissionCatalog(value.catalog))
				&& (value.current === undefined || isNonEmptyString(value.current))
				&& (value.pending === undefined || isNonEmptyString(value.pending))
				&& (value.error === undefined || typeof value.error === 'string');
		case 'planModeState':
			return typeof value.active === 'boolean'
				&& (value.pending === undefined || typeof value.pending === 'boolean')
				&& (value.error === undefined || typeof value.error === 'string');
		case 'filesSelected':
			return isNonEmptyString(value.requestId)
				&& Array.isArray(value.files)
				&& value.files.every(isComposerFile);
		case 'filesSelectionError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'skillCatalog':
			return isNonEmptyString(value.requestId)
				&& Array.isArray(value.skills)
				&& value.skills.every(isComposerSkill);
		case 'skillCatalogError':
		case 'skillOpenError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'modelSelectionState':
			return isModelSelection(value.current)
				&& (value.error === undefined || typeof value.error === 'string');
		case 'workspaceChanges':
			return isNonEmptyString(value.requestId)
				&& isWorkspaceChangeSet(value.changes);
		case 'workspaceFileDiff':
			return isNonEmptyString(value.requestId)
				&& (value.diff === null || isWorkspaceFileDiff(value.diff));
		case 'workspaceFileDiffError':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'error':
			return isNonEmptyString(value.requestId) && typeof value.message === 'string';
		case 'newChat':
		case 'focus':
			return true;
		default:
			return false;
	}
}

function isAssistantStreamDelta(value: unknown): value is AssistantStreamDelta {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.attemptId)
		&& isPositiveInteger(value.turn)
		&& isPositiveInteger(value.step)
		&& isNonNegativeInteger(value.blockIndex)
		&& (value.kind === 'text' || value.kind === 'reasoning' || value.kind === 'tool')
		&& typeof value.text === 'string';
}

/** @returns whether `value` is a runtime lifecycle state known to SeekDock. */
export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
	return value === 'idle'
		|| value === 'initializing'
		|| value === 'ready'
		|| value === 'error';
}

function isAssistantContentBlock(value: unknown): value is AssistantContentBlock {
	if (!isRecord(value)) {
		return false;
	}
	return (value.kind === 'text' || value.kind === 'reasoning')
		&& typeof value.text === 'string';
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.id)
		&& typeof value.title === 'string'
		&& isNonNegativeInteger(value.createdAt)
		&& isNonNegativeInteger(value.updatedAt)
		&& isNonNegativeInteger(value.messageCount);
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
	if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonNegativeInteger(value.createdAt)) {
		return false;
	}
	if (value.kind === 'user') {
		return typeof value.text === 'string';
	}
	return value.kind === 'assistant'
		&& Array.isArray(value.entries)
		&& value.entries.every(isTranscriptEntry)
		&& (value.durationMs === undefined || isNonNegativeInteger(value.durationMs))
		&& (value.changes === undefined || isWorkspaceChangeSet(value.changes));
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (!isRecord(value) || !isNonEmptyString(value.id)) {
		return false;
	}
	switch (value.kind) {
		case 'text':
		case 'reasoning':
			return typeof value.text === 'string';
		case 'tool':
			return isToolCall(value.call);
		default:
			return false;
	}
}

function isToolCall(value: unknown): value is ToolCall {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.id)
		&& isNonEmptyString(value.name)
		&& typeof value.arguments === 'string'
		&& isToolCallStatus(value.status)
		&& (value.result === undefined || typeof value.result === 'string')
		&& (value.error === undefined || typeof value.error === 'string')
		&& (value.recoverableError === undefined || isRecoverableToolError(value.recoverableError));
}

function isApproval(value: unknown): value is Approval {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.id)
		&& isNonEmptyString(value.toolName)
		&& (value.toolCallId === undefined || isNonEmptyString(value.toolCallId))
		&& (value.reason === undefined || typeof value.reason === 'string')
		&& (value.displayReason === undefined || typeof value.displayReason === 'string')
		&& (value.decision === undefined || isApprovalDecision(value.decision));
}

/** @returns whether `value` is a closed approval outcome shared with the UI. */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
	return value === 'allowed'
		|| value === 'rejected'
		|| value === 'cancelled'
		|| value === 'unavailable';
}

function isPlanReview(value: unknown): value is PlanReview {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.id)
		&& typeof value.plan === 'string'
		&& (value.decision === undefined || isPlanReviewDecision(value.decision));
}

function isPlanReviewDecision(value: unknown): value is PlanReviewDecision {
	return value === 'approved'
		|| value === 'keep-planning'
		|| value === 'cancelled'
		|| value === 'unavailable';
}

function isPermissionCatalog(value: unknown): value is PermissionCatalog {
	if (!isRecord(value)) {
		return false;
	}
	return Array.isArray(value.options)
		&& value.options.every(isPermissionOption)
		&& Array.isArray(value.defaultOptions)
		&& value.defaultOptions.every(isPermissionOption)
		&& isNonEmptyString(value.defaultPreset);
}

function isComposerFile(value: unknown): value is ComposerFile {
	return isRecord(value)
		&& isNonEmptyString(value.id)
		&& isNonEmptyString(value.name)
		&& isNonEmptyString(value.path)
		&& isNonEmptyString(value.mention);
}

function isComposerSkill(value: unknown): value is ComposerSkill {
	return isRecord(value)
		&& isNonEmptyString(value.name)
		&& typeof value.description === 'string'
		&& (value.source === 'workspace' || value.source === 'user');
}

function isPermissionOption(value: unknown): value is PermissionOption {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.value)
		&& typeof value.name === 'string'
		&& (value.description === undefined || typeof value.description === 'string');
}

function isToolCallStatus(value: unknown): value is ToolCallStatus {
	return value === 'running'
		|| value === 'completed'
		|| value === 'error'
		|| value === 'awaiting-approval';
}

function isRecoverableToolError(value: unknown): value is RecoverableToolError {
	return value === 'file-not-read' || value === 'file-changed';
}

