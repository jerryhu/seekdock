import type { ComposerFile } from './rpc.ts';

/**
 * Format one host path using DSH's `@path` prompt grammar.
 *
 * @param path - Workspace-relative or absolute host path.
 * @returns the prompt reference, or undefined when the path cannot be quoted safely.
 */
export function formatComposerFileMention(path: string): string | undefined {
	if (path.length === 0 || /[\u0000-\u001f\u007f-\u009f"]/u.test(path)) {
		return undefined;
	}
	return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Join the user's draft with the ordered file references selected beside it.
 *
 * @param text - Draft text typed by the user.
 * @param files - Files currently shown as composer chips.
 * @returns the complete prompt sent to DSH.
 */
export function buildPromptWithFiles(
	text: string,
	files: readonly ComposerFile[],
): string {
	const prompt = text.trim();
	const mentions = [...new Set(files.map(file => file.mention))];
	return [prompt, ...mentions].filter(part => part.length > 0).join('\n\n');
}
