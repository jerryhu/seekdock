/**
 * Contribute the user-editable SeekDock prompt through DSH's system-prompt
 * registry. The text is loaded from a host-owned file so settings changes do
 * not require rewriting this packaged plugin or the Cordis overlay.
 */

import { readFileSync } from 'node:fs';

export const name = 'seekdock-system-prompt';
export const inject = ['systemPrompt'];

const LITERAL_OPEN = '{{seekdock_prompt_literal_open}}';
const LITERAL_CLOSE = '{{seekdock_prompt_literal_close}}';

export function apply(ctx) {
	const promptPath = process.env.SEEKDOCK_SYSTEM_PROMPT_PATH;
	if (promptPath === undefined || promptPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_SYSTEM_PROMPT_PATH is not set.');
	}
	const text = readFileSync(promptPath, 'utf8').trim();
	if (text.length === 0) {
		throw new Error('SeekDock: the configured system prompt is empty.');
	}

	// Prompt-section interpolation is mandatory in the SDK runtime shipped with
	// SeekDock. Escape brace pairs into registered variables so user-authored
	// Markdown reaches the model literally instead of being parsed as variables.
	ctx.systemPrompt.variable('seekdock_prompt_literal_open', () => '{{');
	ctx.systemPrompt.variable('seekdock_prompt_literal_close', () => '}}');
	ctx.systemPrompt.section({
		name: 'seekdock:user-system-prompt',
		order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
		text: text.replace(/\{\{|\}\}/g, braces => braces === '{{' ? LITERAL_OPEN : LITERAL_CLOSE),
	});

	ctx.systemPrompt.section({
		name: 'seekdock:vscode-file-references',
		order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'),
		text: '[VS Code] Paths prefixed with @ are files explicitly selected by the user. '
			+ 'Relative paths resolve from the workspace root; @"..." quotes paths containing spaces. '
			+ 'Use the read tool when their contents are needed.',
	});
}
