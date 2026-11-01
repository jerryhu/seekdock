import { isRecord } from './value-validation.ts';

/** Heading a plan without its own Markdown heading falls back to. */
const FALLBACK_TITLE = 'Plan';

/** Longest heading kept for a card title, in characters. */
const TITLE_LIMIT = 120;

/** Longest body preview kept for a collapsed card, in characters. */
const SUMMARY_LIMIT = 240;

/** Presentation data derived from one submitted plan's Markdown. */
export interface PlanDocument {
	/** First Markdown heading, or a generic fallback. */
	title: string;
	/** Complete plan Markdown, exactly as the model submitted it. */
	markdown: string;
	/** Opening paragraph, shortened for a collapsed card. */
	summary: string;
}

/**
 * Read the plan out of one logged `exit_plan_mode` invocation.
 *
 * @param argumentsJson - raw tool arguments string from the session log.
 * @returns the submitted plan, or `undefined` for unrelated or malformed arguments.
 */
export function planDocumentFromArguments(argumentsJson: string): PlanDocument | undefined {
	let value: unknown;
	try {
		value = JSON.parse(argumentsJson);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.plan !== 'string' || value.plan.trim().length === 0) {
		return undefined;
	}
	return planDocument(value.plan);
}

/**
 * Derive the card title and body preview from one plan.
 *
 * @param markdown - complete plan Markdown.
 * @returns title, original Markdown, and a shortened opening paragraph.
 */
export function planDocument(markdown: string): PlanDocument {
	return {
		title: planTitle(markdown),
		markdown,
		summary: planSummary(markdown),
	};
}

/**
 * @param markdown - complete plan Markdown.
 * @returns the first Markdown heading's text, trimmed to a card title.
 */
export function planTitle(markdown: string): string {
	for (const line of markdown.split('\n')) {
		const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.trim());
		if (match?.[1] !== undefined && match[1].length > 0) {
			return truncate(match[1], TITLE_LIMIT);
		}
	}
	return FALLBACK_TITLE;
}

/**
 * Summarize the plan's opening paragraph, skipping its heading and formatting.
 *
 * @param markdown - complete plan Markdown.
 * @returns single-line body preview, or an empty string when the plan is only a heading.
 */
export function planSummary(markdown: string): string {
	const body = markdown
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('#'));
	const paragraph: string[] = [];
	for (const line of body) {
		// A list or fence starts a new block, so the preview stops at the first one.
		if (paragraph.length > 0 && /^([-*+]\s|\d+[.)]\s|```|\|)/.test(line)) {
			break;
		}
		paragraph.push(line.replace(/^([-*+]\s|\d+[.)]\s|>\s*)/, ''));
	}
	return truncate(paragraph.join(' ').replace(/[*_`]/g, ''), SUMMARY_LIMIT);
}

function truncate(text: string, limit: number): string {
	const collapsed = text.trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit).trimEnd()}…`;
}

/** Longest file name stem kept for a materialized plan, in characters. */
const FILE_STEM_LIMIT = 60;

/**
 * Name the Markdown file that materializes one plan.
 *
 * The content hash keeps one plan in one file, so previewing the same plan
 * again focuses the existing document instead of writing a copy.
 *
 * @param title - card title taken from the plan.
 * @param markdown - complete plan Markdown.
 * @returns a file name ending in `.md`.
 */
export function planFileName(title: string, markdown: string): string {
	return `${fileStem(title)}-${contentHash(markdown)}.md`;
}

function fileStem(title: string): string {
	const stem = title
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/-+/g, '-')
		.replace(/^[\s.-]+|[\s.-]+$/g, '')
		.slice(0, FILE_STEM_LIMIT)
		.trim();
	return stem.length === 0 ? 'plan' : stem;
}

/** FNV-1a over the plan text: stable across sessions, no Node dependency. */
function contentHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}
