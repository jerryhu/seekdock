import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
	Check,
	ChevronDown,
	ChevronRight,
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
import type { Approval, ApprovalAnswer } from '../shared/rpc.ts';
import type { Translator } from '../shared/i18n/index.ts';
import { useI18n } from './i18n-context.tsx';

interface MessageListProps {
	store: ConversationStore;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
}

/** Renders the conversation order while subscribing to each message separately. */
export function MessageList({
	store,
	onOpenLink,
	onApprovalAnswer,
}: MessageListProps): JSX.Element {
	const { t } = useI18n();
	const order = useOrder(store);
	const viewport = useRef<HTMLDivElement>(null);

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

	return (
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
						/>
					))}
			</div>
		</div>
	);
}

function MessageRow({
	id,
	store,
	onOpenLink,
	onApprovalAnswer,
}: {
	id: MessageId;
	store: ConversationStore;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
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
			/>
		);
}

function UserMessageView({ message }: { message: Extract<ChatMessage, { kind: 'user' }> }): JSX.Element {
	return (
		<article className="message user-message">
			<div className="user-bubble">{message.text}</div>
		</article>
	);
}

function AssistantMessageView({
	message,
	onOpenLink,
	onApprovalAnswer,
}: {
	message: AssistantMessage;
	onOpenLink: (url: string) => void;
	onApprovalAnswer: (approval: Approval, decision: ApprovalAnswer) => void;
}): JSX.Element {
	const { t } = useI18n();
	const text = message.entries
		.flatMap(entry => entry.kind === 'text' ? [entry.text] : [])
		.join('');
	const streaming = message.status === 'streaming';
	const cancelled = message.status === 'cancelled';
	const phase = activityLabel(message.live, t);
	const [processOpen, setProcessOpen] = useState(false);
	const durationMs = useElapsedDuration(message);
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
					<span>{t('elapsed', { duration: formatDuration(durationMs, t) })}</span>
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
			{!streaming && text.length > 0
				? (
					<footer className="assistant-actions">
						<CopyButton text={text} />
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
			{live.blocks.map((block) => {
				if (block.kind === 'reasoning') {
					return processOpen
						? (
							<ReasoningView
								key={`${live.attemptId}:${block.blockIndex}`}
								text={block.text}
								onOpenLink={onOpenLink}
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
}: {
	text: string;
	onOpenLink: (url: string) => void;
}): JSX.Element | null {
	const normalized = text.trim();
	if (normalized.length === 0) {
		return null;
	}
	return (
		<section className="reasoning">
			<div className="reasoning-body">
				<Markdown text={text} onOpenLink={onOpenLink} />
			</div>
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

function CopyButton({ text }: { text: string }): JSX.Element {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={copied ? t('copied') : t('copyAnswer')}
			data-tooltip={copied ? t('copied') : t('copyAnswer')}
			data-tooltip-align="start"
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
