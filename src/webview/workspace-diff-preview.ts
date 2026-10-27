import type { WorkspaceFileDiff } from '../shared/workspace-changes.ts';

export type WorkspaceDiffPreviewLineKind = 'header' | 'context' | 'added' | 'removed';

export interface WorkspaceDiffPreviewLine {
	kind: WorkspaceDiffPreviewLineKind;
	text: string;
}

/** Flatten validated hunks into the bounded set of lines a hover card draws. */
export function workspaceDiffPreview(
	diff: Extract<WorkspaceFileDiff, { kind: 'text' }>,
	maxLines = 80,
): { lines: readonly WorkspaceDiffPreviewLine[]; total: number } {
	const lines: WorkspaceDiffPreviewLine[] = [];
	for (const hunk of diff.hunks) {
		lines.push({
			kind: 'header',
			text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		});
		for (const line of hunk.lines) {
			const kind = line.startsWith('+')
				? 'added'
				: line.startsWith('-') ? 'removed' : 'context';
			lines.push({ kind, text: line });
		}
	}
	return {
		lines: lines.slice(0, Math.max(0, maxLines)),
		total: lines.length,
	};
}
