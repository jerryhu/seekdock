import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { runningStatusLabel } from './run-duration.ts';
import type { AssistantMessage } from './store.ts';
import { useI18n } from './i18n-context.tsx';

/** Whale-tail outline drawn when the animated mask cannot run. */
const TAIL_PATH = 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742';

/**
 * Show the running turn's activity at the transcript tail.
 *
 * The clock lives here, not in the message view, so one tick per second
 * re-renders this row instead of the streamed Markdown and process entries.
 * @param props - assistant message whose `createdAt` anchors the clock.
 * @returns the animated status row while the turn streams.
 */
export function AssistantRunningStatus(
	{ message }: { message: AssistantMessage },
): JSX.Element {
	const { t } = useI18n();
	const elapsedMs = useRunClock(message.createdAt);
	const { primary, detail } = runningStatusLabel(elapsedMs, message.live, t);
	return (
		<div className="assistant-running">
			<span
				className="visually-hidden"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{t('working')}
			</span>
			<span className="assistant-running-icon" aria-hidden="true">
				<span className="assistant-running-whale" />
				<svg
					className="assistant-running-tail"
					width="100%"
					height="100%"
					viewBox="0 0 16 16"
					fill="none"
				>
					<path d={TAIL_PATH} stroke="currentColor" strokeWidth={1} />
				</svg>
			</span>
			<span className="assistant-running-label">
				<span className="assistant-running-text">{primary}</span>
				{detail === undefined
					? null
					: <span className="assistant-running-detail">{detail}</span>}
			</span>
		</div>
	);
}

/** @returns milliseconds elapsed since the turn started, ticking once per second. */
function useRunClock(createdAt: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [createdAt]);
	return Math.max(0, now - createdAt);
}
