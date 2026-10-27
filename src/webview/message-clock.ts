/**
 * Format a message timestamp using the compact conversation clock:
 * time only today, month/day within the current year, and a year prefix for
 * older messages. The day/year cuts follow DeepSeek Harness message chrome.
 *
 * @param timestamp - Message creation time in epoch milliseconds.
 * @param locale - Intl locale used for localized numeric date fields.
 * @param now - Reference time for day and year comparisons.
 * @returns A compact message clock.
 */
export function formatMessageClock(
	timestamp: number,
	locale: string,
	now: number = Date.now(),
): string {
	const date = new Date(timestamp);
	const current = new Date(now);
	const clock = new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(date);
	const sameDay = date.getFullYear() === current.getFullYear()
		&& date.getMonth() === current.getMonth()
		&& date.getDate() === current.getDate();
	if (sameDay) {
		return clock;
	}
	const sameYear = date.getFullYear() === current.getFullYear();
	const calendarDate = new Intl.DateTimeFormat(locale, {
		...(sameYear ? {} : { year: 'numeric' }),
		month: 'numeric',
		day: 'numeric',
	}).format(date);
	return `${calendarDate} ${clock}`;
}
