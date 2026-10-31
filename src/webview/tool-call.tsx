import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	ChevronDown,
	ChevronUp,
	FilePenLine,
	FileInput,
	FolderSearch,
	Globe,
	Search,
	ShieldAlert,
	Terminal,
	Wrench,
} from 'lucide-preact';
import type { Approval, ApprovalAnswer, ApprovalDecision, ToolCall } from '../shared/rpc.ts';
import type { Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';

/** Collapsible card for one tool invocation and its result. */
export function ToolCallView({ call }: { call: ToolCall }): JSX.Element {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const parsed = parseArguments(call.arguments);
	const kind = normalizedTool(call.name);
	const label = toolLabel(kind, call.name, t);
	const summary = summarize(call, parsed, kind, t);
	const icon = toolIcon(call.name);
	const isRecoverable = call.recoverableError !== undefined;

	return (
		<section className={`tool-call ${call.status}${isRecoverable ? ' recoverable-error' : ''}`}>
			<button
				type="button"
				className="tool-call-header process-row"
				aria-expanded={open}
				aria-label={open ? t('collapseToolDetails') : t('expandToolDetails')}
				data-tooltip={open ? t('collapseDetails') : t('expandDetails')}
				data-tooltip-align="start"
				onClick={() => setOpen(value => !value)}
			>
				<span className="process-leading" aria-hidden="true">
					{open
						? <ChevronUp size={14} />
						: (
							<>
								<span className="process-leading-icon">{icon}</span>
								<ChevronDown size={14} className="process-leading-chevron" />
							</>
						)}
				</span>
				<span className="tool-heading">
					<span className="tool-label">{label}</span>
					{summary.length > 0
						? (
							<>
								<span className="process-separator" aria-hidden="true" />
								<span className={`tool-summary${summaryClass(call)}`}>
									{summary}
								</span>
							</>
						)
						: null}
				</span>
				<span className="visually-hidden">{statusLabel(call, t)}</span>
			</button>
			{open
				? (
					<div className="tool-call-body">
						<ToolCallBody
							call={call}
							parsed={parsed}
							shell={kind === 'bash'}
							t={t}
						/>
					</div>
				)
				: null}
		</section>
	);
}

/** Approval card that keeps DSH's fail-closed outcome visible to the user. */
export function ApprovalView({
	approval,
	onAnswer,
}: {
	approval: Approval;
	onAnswer?: (decision: ApprovalAnswer) => void;
}): JSX.Element {
	const { t } = useI18n();
	const [sent, setSent] = useState(false);
	const decision = approval.decision;
	const reason = approval.displayReason ?? approval.reason;

	const answer = (value: ApprovalAnswer): void => {
		if (sent || decision !== undefined) {
			return;
		}
		setSent(true);
		onAnswer?.(value);
	};

	return (
		<section className={`approval-card${decision === undefined ? '' : ` resolved ${decision}`}`}>
			<ShieldAlert size={16} />
			<div className="approval-body">
				<div className="approval-title">
					{decision === undefined
						? sent ? t('submittingEllipsis') : t('waitingApproval')
						: approvalDecisionLabel(decision, t)}
				</div>
				<div className="approval-tool">{approval.toolName}</div>
				{reason !== undefined ? <p>{reason}</p> : null}
				{decision === undefined && !sent && approval.toolCallId !== undefined && onAnswer !== undefined
					? (
						<div className="approval-actions">
							<button
								type="button"
								className="secondary-button"
								onClick={() => answer('deny')}
							>
								{t('deny')}
							</button>
							<button
								type="button"
								className="primary-button"
								onClick={() => answer('allow')}
							>
								{t('allowOnce')}
							</button>
						</div>
					)
					: null}
				{decision === undefined && approval.toolCallId === undefined
					? <p className="approval-hint">{t('approvalUnlinked')}</p>
					: null}
			</div>
		</section>
	);
}

function approvalDecisionLabel(decision: ApprovalDecision, t: Translator): string {
	switch (decision) {
		case 'allowed':
			return t('allowedOnce');
		case 'rejected':
			return t('rejected');
		case 'cancelled':
			return t('cancelled');
		case 'unavailable':
			return t('unavailable');
	}
}

function ToolCallBody({
	call,
	parsed,
	shell,
	t,
}: {
	call: ToolCall;
	parsed: Record<string, unknown> | undefined;
	shell: boolean;
	t: Translator;
}): JSX.Element {
	if (shell) {
		const command = stringArgument(parsed, 'command')
			?? stringArgument(parsed, 'description')
			?? summarize(call, parsed, 'bash', t);
		const output = call.result ?? call.error;
		return (
			<div className="terminal-call-card">
				<div className="terminal-command">
					<span className="terminal-prompt" aria-hidden="true">$</span>
					<code>{command}</code>
				</div>
				{output !== undefined && output.length > 0
					? (
						<pre className={`terminal-output${outputClass(call)}`}>
							{output}
						</pre>
					)
					: (
						<div className="terminal-empty">
							{call.status === 'running' ? t('waitingOutput') : t('noOutput')}
						</div>
					)}
			</div>
		);
	}

	const input = formatArguments(call.arguments);
	const output = [call.result, call.error]
		.filter((value, index, values): value is string => (
			value !== undefined && value.length > 0 && values.indexOf(value) === index
		))
		.join('\n\n');
	const hasInput = input.length > 0 && input !== '{}';
	return (
		<div className="tool-io-card">
			{hasInput
				? (
					<div className="tool-io-section">
						<span className="tool-section-label">{t('input')}</span>
						<pre className="tool-io-text">{input}</pre>
					</div>
				)
				: null}
			{hasInput && output.length > 0 ? <span className="tool-io-divider" aria-hidden="true" /> : null}
			{output.length > 0
				? (
					<div className="tool-io-section">
						<span className="tool-section-label">{t('output')}</span>
						<pre className={`tool-io-text${outputClass(call)}`}>
							{output}
						</pre>
					</div>
				)
				: null}
		</div>
	);
}

function summaryClass(call: ToolCall): string {
	if (call.recoverableError !== undefined) {
		return ' warning-summary';
	}
	return call.status === 'error' ? ' error-summary' : '';
}

function outputClass(call: ToolCall): string {
	if (call.status !== 'error') {
		return '';
	}
	return call.recoverableError === undefined ? ' error-output' : ' warning-output';
}

function statusLabel(call: ToolCall, t: Translator): string {
	switch (call.status) {
		case 'running':
			return t('running');
		case 'completed':
			return t('completed');
		case 'error':
			return call.recoverableError === undefined ? t('failed') : t('needsAttention');
		case 'awaiting-approval':
			return t('waitingApproval');
	}
}

function toolIcon(name: string): JSX.Element {
	switch (normalizedTool(name)) {
		case 'bash':
			return <Terminal size={14} />;
		case 'read':
			return <FileInput size={14} />;
		case 'write':
		case 'edit':
			return <FilePenLine size={14} />;
		case 'search':
			return <Search size={14} />;
		case 'browse':
			return <FolderSearch size={14} />;
		case 'web':
			return <Globe size={14} />;
		default:
			return <Wrench size={14} />;
	}
}

function toolLabel(kind: string, name: string, t: Translator): string {
	switch (kind) {
		case 'bash':
			return t('runCommand');
		case 'read':
			return t('read');
		case 'write':
			return t('write');
		case 'edit':
			return t('edit');
		case 'search':
			return t('search');
		case 'browse':
			return t('browse');
		case 'web':
			return t('accessWeb');
		default:
			return name;
	}
}

function normalizedTool(name: string): string {
	const lower = name.toLowerCase();
	// Check the most specific verbs first because provider tool names often
	// combine them, such as `read_file` or `search_and_replace`.
	if (/bash|shell|terminal|exec/.test(lower)) {
		return 'bash';
	}
	if (/read/.test(lower)) {
		return 'read';
	}
	if (/write/.test(lower)) {
		return 'write';
	}
	if (/edit|patch|replace/.test(lower)) {
		return 'edit';
	}
	if (/search|grep|find/.test(lower)) {
		return 'search';
	}
	if (/list|glob|folder|directory/.test(lower)) {
		return 'browse';
	}
	if (/web|fetch|http|url/.test(lower)) {
		return 'web';
	}
	return lower;
}

function summarize(
	call: ToolCall,
	parsed: Record<string, unknown> | undefined,
	kind: string,
	t: Translator,
): string {
	if (call.status === 'awaiting-approval') {
		return t('waitingApproval');
	}
	if (call.recoverableError !== undefined) {
		const message = call.recoverableError === 'file-not-read'
			? t('fileReadRequired')
			: t('fileChangedReread');
		const path = stringArgument(parsed, 'path') ?? stringArgument(parsed, 'file_path');
		return path === undefined ? message : `${message} · ${compact(path)}`;
	}
	const keys = kind === 'bash'
		? ['description', 'command']
		: ['path', 'file_path', 'pattern', 'query', 'url', 'name', 'command'];
	for (const key of keys) {
		const value = parsed?.[key];
		if (typeof value === 'string' && value.length > 0) {
			return call.status === 'error'
					? compact(call.error ?? call.result ?? value)
				: compact(value);
		}
	}
	return compact(call.arguments);
}

function stringArgument(
	parsed: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = parsed?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function compact(value: string): string {
	const oneLine = value.replace(/\s+/g, ' ').trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function formatArguments(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}
