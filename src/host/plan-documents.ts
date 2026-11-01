import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { planFileName } from '../shared/plan-document.ts';

/** Directory under the data root that keeps materialized plan documents. */
const PLAN_DIRECTORY = 'plans';

/**
 * Owns the Markdown files that make a submitted plan readable outside the chat.
 *
 * DSH desktop opens submitted plans in its right sidebar; VS Code's equivalent
 * is the built-in Markdown preview, so each plan is written once into the data
 * root and opened beside the chat from there.
 */
export class PlanDocuments {
	/**
	 * @param dataRoot - SeekDock data root; plans live under `plans/` inside it.
	 */
	constructor(private readonly dataRoot: string) { }

	/**
	 * Write one plan as Markdown and open it beside the chat.
	 *
	 * @param markdown - complete plan Markdown from the review card.
	 * @param title - card title, used for the file name.
	 */
	async open(markdown: string, title: string): Promise<void> {
		const directory = join(this.dataRoot, PLAN_DIRECTORY);
		await mkdir(directory, { recursive: true });
		const file = join(directory, planFileName(title, markdown));
		// A trailing newline keeps the rendered file a well-formed text document.
		await writeFile(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
		const uri = vscode.Uri.file(file);
		try {
			await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
		} catch (error) {
			// The Markdown extension can be disabled; the source stays readable.
			console.warn('SeekDock: Markdown preview is unavailable, opening the plan as text', error);
			await vscode.window.showTextDocument(uri, { preview: true });
		}
	}
}
