import * as vscode from 'vscode';
import type { WorkspaceFileDiff } from '../shared/workspace-changes.ts';

const DIFF_SCHEME = 'seekdock-workspace-diff';

interface DocumentPair {
	before: string;
	after: string;
}

/**
 * Render DSH's contextual hunks as two stable text documents for VS Code's
 * native diff editor. Hunk headers keep the original line coordinates visible.
 *
 * @param diff - one validated text comparison.
 * @returns the left and right document bodies.
 */
export function workspaceDiffDocumentContents(
	diff: Extract<WorkspaceFileDiff, { kind: 'text' }>,
): DocumentPair {
	const before: string[] = [];
	const after: string[] = [];
	for (const [index, hunk] of diff.hunks.entries()) {
		const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
		before.push(header);
		after.push(header);
		for (const line of hunk.lines) {
			const text = line.slice(1);
			if (line.startsWith(' ')) {
				before.push(text);
				after.push(text);
			} else if (line.startsWith('-')) {
				before.push(text);
			} else {
				after.push(text);
			}
		}
		if (index < diff.hunks.length - 1) {
			// Identical separators let the native diff align every changed hunk.
			before.push('');
			after.push('');
		}
	}
	return {
		before: before.join('\n'),
		after: after.join('\n'),
	};
}

/** Owns the read-only virtual documents opened by workspace change rows. */
export class WorkspaceDiffDocuments implements vscode.Disposable {
	private readonly registration: vscode.Disposable;
	private readonly contents = new Map<string, string>();
	private nextId = 0;

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
			provideTextDocumentContent: uri => this.contents.get(uri.toString()) ?? '',
		});
	}

	/**
	 * Open one text comparison in VS Code's native diff editor.
	 *
	 * @param diff - validated text comparison.
	 * @param title - localized editor title.
	 */
	async open(
		diff: Extract<WorkspaceFileDiff, { kind: 'text' }>,
		title: string,
	): Promise<void> {
		const id = `${Date.now().toString(36)}-${this.nextId++}`;
		const { before, after } = workspaceDiffDocumentContents(diff);
		const beforeUri = this.documentUri(id, 'before', diff.path);
		const afterUri = this.documentUri(id, 'after', diff.path);
		this.contents.set(beforeUri.toString(), before);
		this.contents.set(afterUri.toString(), after);
		await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, {
			preview: true,
		});
	}

	dispose(): void {
		this.registration.dispose();
		this.contents.clear();
	}

	private documentUri(id: string, side: 'before' | 'after', path: string): vscode.Uri {
		const filename = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'file';
		return vscode.Uri.from({
			scheme: DIFF_SCHEME,
			path: `/${id}/${side}/${filename}`,
		});
	}
}
