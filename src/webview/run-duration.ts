import type { Translator } from '../shared/i18n/index.ts';
import type { AssistantLive } from './store.ts';

/** Primary and optional detail text of the running assistant status line. */
export interface RunningStatusLabel {
	readonly primary: string;
	readonly detail?: string;
}

/**
 * Format a run duration with the locale's hour/minute/second templates.
 *
 * @param durationMs - elapsed milliseconds, or undefined when the log omitted it.
 * @param t - translator bound to the active interface language.
 * @returns compact localized duration, or `--` when no duration is known.
 */
export function formatDuration(durationMs: number | undefined, t: Translator): string {
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

/**
 * Choose the tail status text for a running assistant turn.
 *
 * The first second shows the plain activity label so a new turn does not flash
 * `0s`. Tool work appends the tool name as secondary detail, replacing the
 * former separate feedback row.
 *
 * @param elapsedMs - milliseconds since the assistant turn started.
 * @param live - current streaming activity, if any has arrived.
 * @param t - translator bound to the active interface language.
 * @returns localized primary label and optional tool detail.
 */
export function runningStatusLabel(
	elapsedMs: number,
	live: Pick<AssistantLive, 'phase' | 'toolName'> | undefined,
	t: Translator,
): RunningStatusLabel {
	const primary = elapsedMs < 1_000
		? t('working')
		: t('workingFor', { duration: formatDuration(elapsedMs, t) });
	if (live?.phase !== 'tool') {
		return { primary };
	}
	const detail = live.toolName === undefined
		? t('preparingToolCall')
		: t('preparingToolNamed', { name: live.toolName });
	return { primary, detail };
}
