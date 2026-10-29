/**
 * Decide whether one assistant answer's reasoning and tool rows render.
 *
 * A live answer must expose its activity. Once the answer settles — completed,
 * stopped, failed, or restored from history — the rows fold behind the duration
 * toggle until the reader expands them.
 *
 * @param streaming - whether the answer is still running.
 * @param expanded - whether the reader opened the settled answer's process rows.
 * @returns whether reasoning and tool rows are visible.
 */
export function processRowsVisible(streaming: boolean, expanded: boolean): boolean {
	return streaming || expanded;
}
