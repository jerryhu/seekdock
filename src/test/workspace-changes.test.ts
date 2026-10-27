import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
	WorkspaceDiffDocuments,
	workspaceDiffDocumentContents,
} from '../host/workspace-diff-documents.ts';
import {
	isWorkspaceChangeSet,
	isWorkspaceFileDiff,
	type WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import { workspaceDiffPreview } from '../webview/workspace-diff-preview.ts';

const textDiff: Extract<WorkspaceFileDiff, { kind: 'text' }> = {
	kind: 'text',
	path: 'src/app.ts',
	display: 'src/app.ts',
	before: true,
	after: true,
	hunks: [{
		oldStart: 4,
		oldLines: 3,
		newStart: 4,
		newLines: 3,
		lines: [' const before = true;', '-const value = 1;', '+const value = 2;'],
	}, {
		oldStart: 20,
		oldLines: 2,
		newStart: 20,
		newLines: 2,
		lines: [' return value;', '-}', '+};'],
	}],
	coarse: false,
};

suite('Workspace changes', () => {
	test('validates live summaries and contextual file comparisons', () => {
		assert.ok(isWorkspaceChangeSet({
			sessionId: 'session-1',
			seq: 12,
			turn: 2,
			files: [{
				path: 'src/app.ts',
				display: 'src/app.ts',
				added: 1,
				deleted: 1,
			}],
			total: 1,
			added: 1,
			deleted: 1,
		}));
		assert.ok(isWorkspaceFileDiff(textDiff));
		assert.ok(isWorkspaceFileDiff({
			kind: 'binary',
			path: 'asset.png',
			display: 'asset.png',
		}));
		assert.ok(!isWorkspaceChangeSet({
			sessionId: 'session-1',
			seq: -1,
			turn: 2,
			files: [],
			total: 0,
			added: 0,
			deleted: 0,
		}));
		assert.ok(!isWorkspaceFileDiff({
			...textDiff,
			hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: ['invalid'] }],
		}));
	});

	test('renders both native-diff sides with original hunk coordinates', () => {
		assert.deepStrictEqual(workspaceDiffDocumentContents(textDiff), {
			before: [
				'@@ -4,3 +4,3 @@',
				'const before = true;',
				'const value = 1;',
				'',
				'@@ -20,2 +20,2 @@',
				'return value;',
				'}',
			].join('\n'),
			after: [
				'@@ -4,3 +4,3 @@',
				'const before = true;',
				'const value = 2;',
				'',
				'@@ -20,2 +20,2 @@',
				'return value;',
				'};',
			].join('\n'),
		});
	});

	test('flattens and bounds hover preview lines', () => {
		const full = workspaceDiffPreview(textDiff);
		assert.deepStrictEqual(full.lines.map(line => line.kind), [
			'header',
			'context',
			'removed',
			'added',
			'header',
			'context',
			'removed',
			'added',
		]);
		assert.strictEqual(full.total, 8);

		const bounded = workspaceDiffPreview(textDiff, 3);
		assert.strictEqual(bounded.lines.length, 3);
		assert.strictEqual(bounded.total, 8);
	});

	test('opens contextual hunks in a native VS Code diff editor', async () => {
		const documents = new WorkspaceDiffDocuments();
		try {
			await documents.open(textDiff, 'SeekDock diff test');
			const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			assert.ok(input instanceof vscode.TabInputTextDiff);
			assert.strictEqual(input.original.scheme, 'seekdock-workspace-diff');
			assert.strictEqual(input.modified.scheme, 'seekdock-workspace-diff');
			const before = await vscode.workspace.openTextDocument(input.original);
			const after = await vscode.workspace.openTextDocument(input.modified);
			assert.match(before.getText(), /const value = 1;/u);
			assert.match(after.getText(), /const value = 2;/u);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			documents.dispose();
		}
	});
});
