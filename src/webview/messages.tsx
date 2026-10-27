import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Brain,
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CircleAlert,
	Copy,
	LoaderCircle,
	Sparkles,
} from 'lucide-preact';
import { Markdown } from './markdown.tsx';
import {
	type AssistantLive,
	type AssistantMessage,
	type ChatMessage,
	ConversationStore,
	type MessageId,
} from './store.ts';
import { ApprovalView, ToolCallView } from './tool-call.tsx';
import { copyText } from './copy.ts';
import { formatMessageClock } from './message-clock.ts';
import { reasoningSummary } from './reasoning-summary.ts';
import type { Approval, ApprovalAnswer } from '../shared/rpc.ts';
import type {
	WorkspaceChangeSet,
	WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import { intlLocale, type Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';
import { WorkspaceChangesView } from './workspace-changes.tsx';

interface MessageListProps {
	store: ConversationStore;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
	onRequestWorkspaceDiff: (
		changes: WorkspaceChangeSet,
		index: number,
	) => Promise<WorkspaceFileDiff | null>;
	onOpenWorkspaceDiff: (changes: WorkspaceChangeSet, index: number) => void;
}

interface SelectionMenuState {
	x: number;
	y: number;
	text: string;
}

/** Renders the conversation order while subscribing to each message separately. */
export function MessageList({
	store,
	onOpenLink,
	onApprovalAnswer,
	onRequestWorkspaceDiff,
	onOpenWorkspaceDiff,
}: MessageListProps): JSX.Element {
	const { t } = useI18n();
	const order = useOrder(store);
	const viewport = useRef<HTMLDivElement>(null);
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState>();

	useEffect(() => {
		const element = viewport.current;
		if (element === null) {
			return;
		}
		let stickToBottom = true;
		const onScroll = (): void => {
			stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
		};
		const observer = new MutationObserver(() => {
			if (stickToBottom) {
				element.scrollTop = element.scrollHeight;
			}
		});
		element.addEventListener('scroll', onScroll, { passive: true });
		observer.observe(element, { childList: true, subtree: true, characterData: true });
		return () => {
			element.removeEventListener('scroll', onScroll);
			observer.disconnect();
		};
	}, []);

	useEffect(() => {
		const element = viewport.current;
		if (element === null) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent): void => {
			if (
				event.defaultPrevented
				|| event.altKey
				|| event.shiftKey
				|| !(event.metaKey || event.ctrlKey)
				|| event.key.toLowerCase() !== 'c'
				|| isEditableTarget(event.target)
			) {
				return;
			}
			const text = selectedTextWithin(element);
			if (text === undefined) {
				return;
			}
			// VS Code handles Webview copy commands at its own layer, so stop the
			// shortcut here and copy this DOM selection directly.
			event.preventDefault();
			event.stopPropagation();
			void copyText(text);
		};
		const onContextMenu = (event: MouseEvent): void => {
			const text = selectedTextWithin(element);
			if (text === undefined) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setSelectionMenu({ x: event.clientX, y: event.clientY, text });
		};
		document.addEventListener('keydown', onKeyDown, true);
		element.addEventListener('contextmenu', onContextMenu);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			element.removeEventListener('contextmenu', onContextMenu);
		};
	}, []);

	return (
		<>
			<div className="messages" id="messages" ref={viewport}>
				<div
					className={`message-column${order.length === 0 ? ' empty' : ''}`}
				>
					{order.length === 0
						? (
							<div className="empty-state">
								<div className="empty-mark"><Sparkles size={18} /></div>
								<p>{t('emptyPrompt')}</p>
							</div>
						)
						: order.map(id => (
							<MessageRow
								key={id}
								id={id}
								store={store}
								onOpenLink={onOpenLink}
								onApprovalAnswer={onApprovalAnswer}
								onRequestWorkspaceDiff={onRequestWorkspaceDiff}
								onOpenWorkspaceDiff={onOpenWorkspaceDiff}
							/>
						))}
				</div>
			</div>
			{selectionMenu === undefined
				? null
				: (
					<SelectionCopyMenu
						menu={selectionMenu}
						onClose={() => setSelectionMenu(undefined)}
					/>
				)}
		</>
	);
}

function MessageRow({
	id,
	store,
	onOpenLink,
	onApprovalAnswer,
	onRequestWorkspaceDiff,
	onOpenWorkspaceDiff,
}: {
	id: MessageId;
	store: ConversationStore;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
	onRequestWorkspaceDiff: MessageListProps['onRequestWorkspaceDiff'];
	onOpenWorkspaceDiff: MessageListProps['onOpenWorkspaceDiff'];
}): JSX.Element | null {
	const message = useMessage(store, id);
	if (message === undefined) {
		return null;
	}
	return message.kind === 'user'
		? <UserMessageView message={message} />
		: (
			<AssistantMessageView
				message={message}
				onOpenLink={onOpenLink}
				onApprovalAnswer={onApprovalAnswer}
				onRequestWorkspaceDiff={onRequestWorkspaceDiff}
				onOpenWorkspaceDiff={onOpenWorkspaceDiff}
			/>
		);
}

function UserMessageView({ message }: { message: Extract<ChatMessage, { kind: 'user' }> }): JSX.Element {
	const { t } = useI18n();
	return (
		<article className="message user-message">
			<div className="user-bubble">{message.text}</div>
			<footer className="user-message-meta">
				<MessageTimestamp createdAt={message.createdAt} />
				<CopyButton
					text={message.text}
					label={t('copyMessage')}
					tooltipAlign="end"
				/>
			</footer>
		</article>
	);
}

function AssistantMessageView({
	message,
	onOpenLink,
	onApprovalAnswer,
	onRequestWorkspaceDiff,
	onOpenWorkspaceDiff,
}: {
	message: AssistantMessage;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
	onRequestWorkspaceDiff: MessageListProps['onRequestWorkspaceDiff'];
	onOpenWorkspaceDiff: MessageListProps['onOpenWorkspaceDiff'];
}): JSX.Element {
	const { t } = useI18n();
	const text = message.entries
		.flatMap(entry => entry.kind === 'text' ? [entry.text] : [])
		.join('');
	const streaming = message.status === 'streaming';
	const cancelled = message.status === 'cancelled';
	const phase = activityLabel(message.live, t);
	const [processOpen, setProcessOpen] = useState(true);
	const durationMs = useElapsedDuration(message);
	const duration = formatDuration(durationMs, t);
	const hasProcess = message.entries.some(
		entry => entry.kind === 'reasoning' || entry.kind === 'tool',
	) || message.live?.blocks.some(block => block.kind === 'reasoning') === true
		|| message.live?.phase === 'tool';

	return (
		<article className="message assistant-message" aria-busy={streaming}>
			<header className="assistant-header">
				<button
					type="button"
					className="assistant-duration"
					aria-expanded={hasProcess ? processOpen : undefined}
					aria-label={hasProcess
						? processOpen ? t('collapseProcess') : t('expandProcess')
						: undefined}
					disabled={!hasProcess}
					data-tooltip={hasProcess
						? processOpen ? t('collapseProcess') : t('expandProcess')
						: undefined}
					data-tooltip-align="start"
					onClick={() => setProcessOpen(value => !value)}
				>
					<span>
						{streaming
							? t('workingFor', { duration })
							: t('workedFor', { duration })}
					</span>
					{hasProcess
						? processOpen
							? <ChevronDown size={13} aria-hidden="true" />
							: <ChevronRight size={13} aria-hidden="true" />
						: null}
				</button>
				{streaming || cancelled
					? (
						<span className="stream-state" role="status" aria-live="polite">
							{streaming ? <span className="stream-dot" /> : null}
							{streaming ? phase : t('stopped')}
						</span>
					)
					: null}
			</header>
			<div className="assistant-body">
				{message.entries.length === 0 && message.live === undefined && streaming
					? <ThinkingIndicator />
					: null}
				{message.entries.map((entry, index) => {
					switch (entry.kind) {
						case 'text':
							return (
								<div className="assistant-text" key={entry.id}>
									<Markdown text={entry.text} onOpenLink={onOpenLink} />
									{streaming
										&& message.live === undefined
										&& index === message.entries.length - 1
										? <span className="stream-cursor" aria-hidden="true" />
										: null}
								</div>
							);
						case 'reasoning':
							return processOpen
								? (
									<ReasoningView
										key={entry.id}
										text={entry.text}
										onOpenLink={onOpenLink}
									/>
								)
								: null;
						case 'tool':
							return processOpen
								? <ToolCallView key={entry.id} call={entry.call} />
								: null;
						case 'approval':
							return (
								<ApprovalView
									key={entry.id}
									approval={entry.approval}
									onAnswer={decision => onApprovalAnswer(entry.approval, decision)}
								/>
							);
					}
				})}
				{message.live !== undefined
					? (
						<LiveAssistantView
							live={message.live}
							processOpen={processOpen}
							onOpenLink={onOpenLink}
						/>
					)
					: null}
				{message.error !== undefined
					? (
						<div className="message-error" role="alert">
							<CircleAlert size={14} />
							<span>{message.error}</span>
						</div>
					)
					: null}
			</div>
			{!streaming
				&& (message.status === 'complete' || message.status === 'cancelled')
				&& message.changes !== undefined
				&& message.changes.files.length > 0
				? (
					<WorkspaceChangesView
						changes={message.changes}
						onRequestDiff={onRequestWorkspaceDiff}
						onOpenDiff={onOpenWorkspaceDiff}
					/>
				)
				: null}
			{!streaming && text.length > 0
				? (
					<footer className="assistant-actions">
						<CopyButton text={text} label={t('copyAnswer')} />
						<MessageTimestamp createdAt={message.createdAt} />
					</footer>
				)
				: null}
		</article>
	);
}

function LiveAssistantView({
	live,
	processOpen,
	onOpenLink,
}: {
	live: AssistantLive;
	processOpen: boolean;
	onOpenLink: (url: string) => void;
}): JSX.Element {
	const { t } = useI18n();
	const hasText = live.blocks.some(block => block.text.trim().length > 0);
	return (
		<>
			{live.blocks.map((block, index) => {
				if (block.kind === 'reasoning') {
					return processOpen
						? (
							<ReasoningView
								key={`${live.attemptId}:${block.blockIndex}`}
								text={block.text}
								onOpenLink={onOpenLink}
								running={live.phase === 'thinking' && index === live.blocks.length - 1}
							/>
						)
						: null;
				}
				return (
					<div className="assistant-text" key={`${live.attemptId}:${block.blockIndex}`}>
						<Markdown text={block.text} onOpenLink={onOpenLink} />
						<span className="stream-cursor" aria-hidden="true" />
					</div>
				);
			})}
			{live.phase === 'tool'
				? (
					<div className="live-feedback" role="status">
						<LoaderCircle size={13} className="spin" />
						<span>
							{live.toolName === undefined
								? t('preparingToolCall')
								: t('preparingToolNamed', { name: live.toolName })}
						</span>
					</div>
				)
				: null}
			{!hasText && live.phase !== 'tool' ? <ThinkingIndicator /> : null}
		</>
	);
}

function ReasoningView({
	text,
	onOpenLink,
	running = false,
}: {
	text: string;
	onOpenLink: (url: string) => void;
	running?: boolean;
}): JSX.Element | null {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const normalized = text.trim();
	if (normalized.length === 0) {
		return null;
	}
	const summary = reasoningSummary(text, running);
	return (
		<section className={`reasoning${running ? ' running' : ''}`}>
			<button
				type="button"
				className="reasoning-header process-row"
				aria-expanded={open}
				aria-label={open ? t('collapseDetails') : t('expandDetails')}
				data-tooltip={open ? t('collapseDetails') : t('expandDetails')}
				data-tooltip-align="start"
				onClick={() => setOpen(value => !value)}
			>
				<span className="process-leading" aria-hidden="true">
					{open
						? <ChevronUp size={14} />
						: (
							<>
								<span className="process-leading-icon"><Brain size={14} /></span>
								<ChevronDown size={14} className="process-leading-chevron" />
							</>
						)}
				</span>
				<span className="reasoning-heading">
					<span className="reasoning-label">{t('reasoningLabel')}</span>
					{summary.length > 0
						? (
							<>
								<span className="process-separator" aria-hidden="true" />
								<span className="reasoning-summary">{summary}</span>
							</>
						)
						: null}
				</span>
			</button>
			{open
				? (
					<div className="reasoning-body">
						<Markdown text={text} onOpenLink={onOpenLink} />
					</div>
				)
				: null}
		</section>
	);
}

function useElapsedDuration(message: AssistantMessage): number | undefined {
	const [now, setNow] = useState(() => Date.now());
	const streaming = message.status === 'streaming';
	useEffect(() => {
		if (!streaming) {
			return;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [message.createdAt, streaming]);
	if (message.durationMs !== undefined) {
		return message.durationMs;
	}
	return streaming ? Math.max(0, now - message.createdAt) : undefined;
}

function formatDuration(durationMs: number | undefined, t: Translator): string {
	if (durationMs === undefined) {
		return '--';
	}
	const totalSeconds = Math.floor(durationMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return t('durationHours', { hours, minutes, seconds });
	}
	if (minutes > 0) {
		return t('durationMinutes', { minutes, seconds });
	}
	return t('durationSeconds', { seconds });
}

function MessageTimestamp({ createdAt }: { createdAt: number }): JSX.Element {
	const { language } = useI18n();
	const date = new Date(createdAt);
	const formatted = formatMessageClock(createdAt, intlLocale(language));
	return (
		<time className="message-timestamp" dateTime={date.toISOString()}>
			{formatted}
		</time>
	);
}

function CopyButton({
	text,
	label,
	tooltipAlign = 'start',
}: {
	text: string;
	label: string;
	tooltipAlign?: 'start' | 'end';
}): JSX.Element {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={copied ? t('copied') : label}
			data-tooltip={copied ? t('copied') : label}
			data-tooltip-align={tooltipAlign}
			onClick={() => {
				void copyText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1_500);
				});
			}}
		>
			{copied ? <Check size={13} /> : <Copy size={13} />}
		</button>
	);
}

function SelectionCopyMenu({
	menu,
	onClose,
}: {
	menu: SelectionMenuState;
	onClose: () => void;
}): JSX.Element {
	const { t } = useI18n();
	const menuElement = useRef<HTMLDivElement>(null);
	const left = Math.min(menu.x, Math.max(8, window.innerWidth - 168));
	const top = Math.min(menu.y, Math.max(8, window.innerHeight - 52));

	useEffect(() => {
		const onPointerDown = (event: PointerEvent): void => {
			if (event.target instanceof Node && menuElement.current?.contains(event.target)) {
				return;
			}
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape') {
				return;
			}
			event.preventDefault();
			onClose();
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('scroll', onClose, true);
		window.addEventListener('resize', onClose);
		window.addEventListener('blur', onClose);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeyDown, true);
			document.removeEventListener('scroll', onClose, true);
			window.removeEventListener('resize', onClose);
			window.removeEventListener('blur', onClose);
		};
	}, [onClose]);

	return (
		<div
			ref={menuElement}
			className="selection-copy-menu"
			role="menu"
			style={{ left: `${left}px`, top: `${top}px` }}
			onPointerDown={event => event.stopPropagation()}
		>
			<button
				type="button"
				className="selection-copy-menu-item"
				role="menuitem"
				onClick={() => {
					void copyText(menu.text).then(onClose);
				}}
			>
				<Copy size={13} aria-hidden="true" />
				<span>{t('copySelection')}</span>
			</button>
		</div>
	);
}

function selectedTextWithin(element: Element): string | undefined {
	const selection = window.getSelection();
	if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
		return undefined;
	}
	const text = selection.toString();
	if (text.length === 0 || !element.contains(selection.getRangeAt(0).commonAncestorContainer)) {
		return undefined;
	}
	return text;
}

function isEditableTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLElement
		&& (target.isContentEditable || target.matches('input, textarea, select'));
}

function activityLabel(live: AssistantLive | undefined, t: Translator): string {
	switch (live?.phase) {
		case 'thinking':
			return t('thinking');
		case 'writing':
			return t('generating');
		case 'tool':
			return t('callingTool');
		default:
			return t('preparing');
	}
}

function ThinkingIndicator(): JSX.Element {
	const { t } = useI18n();
	return (
		<div className="thinking" aria-label={t('thinkingAria')}>
			<span />
			<span />
			<span />
		</div>
	);
}

function useOrder(store: ConversationStore): readonly MessageId[] {
	const [order, setOrder] = useState<readonly MessageId[]>(() => store.getOrder());
	useEffect(() => store.subscribeOrder(() => setOrder(store.getOrder())), [store]);
	return order;
}

function useMessage(store: ConversationStore, id: MessageId): ChatMessage | undefined {
	const [, setVersion] = useState(0);
	useEffect(
		() => store.subscribeMessage(id, () => setVersion(value => value + 1)),
		[store, id],
	);
	return store.getMessage(id);
}
