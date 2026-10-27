const PARAGRAPH_SEPARATOR = /\r?\n(?:[\t ]*\r?\n)+/;

/**
 * Build the single-line preview shown while a reasoning block is collapsed.
 *
 * @param text - complete or streaming reasoning text.
 * @param streaming - whether the reasoning tail is still arriving.
 * @returns the settled first line, or the latest completed paragraph's first line while streaming.
 */
export function reasoningSummary(text: string, streaming: boolean): string {
	const summary = streaming
		? latestCompletedParagraphFirstLine(text)
		: firstLine(text);
	return summary.replaceAll('**', '');
}

function latestCompletedParagraphFirstLine(text: string): string {
	const paragraphs = text.split(PARAGRAPH_SEPARATOR);
	for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
		const paragraph = paragraphs[index];
		if (paragraph === undefined) {
			continue;
		}
		const completed = index < paragraphs.length - 1 || paragraph.includes('\n');
		if (!completed) {
			continue;
		}
		const summary = firstLine(paragraph);
		if (summary.length > 0) {
			return summary;
		}
	}
	return '';
}

function firstLine(text: string): string {
	const newline = text.indexOf('\n');
	return (newline === -1 ? text : text.slice(0, newline)).trim();
}
