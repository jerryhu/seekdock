import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceChangeStore } from '../host/workspace-change-store.ts';
import type {
	WorkspaceChangeSet,
	WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';

const changes: WorkspaceChangeSet = {
	sessionId: 'session-1',
	seq: 12,
	turn: 2,
	files: [{
		path: 'src/app.ts',
		display: 'src/app.ts',
		added: 1,
		deleted: 1,
	}, {
		path: 'asset.png',
		display: 'asset.png',
		added: 0,
		deleted: 0,
		binary: true,
	}],
	total: 2,
	added: 1,
	deleted: 1,
};

const textDiff: Extract<WorkspaceFileDiff, { kind: 'text' }> = {
	kind: 'text',
	path: 'src/app.ts',
	display: 'src/app.ts',
	before: true,
	after: true,
	hunks: [{
		oldStart: 1,
		oldLines: 2,
		newStart: 1,
		newLines: 2,
		lines: [' const value = 1;', '-export default 1;', '+export default 2;'],
	}],
	coarse: false,
};

suite('Workspace change store', () => {
	test('persists a turn summary and captures its comparisons', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-workspace-changes-'));
		const store = new WorkspaceChangeStore(root);
		try {
			const requested: number[] = [];
			await store.record(changes, async (index) => {
				requested.push(index);
				return index === 0 ? textDiff : undefined;
			});
			await store.dispose();

			assert.deepStrictEqual(requested, [0, 1]);
			assert.deepStrictEqual([...await store.readSession('session-1')], [[12, changes]]);
			assert.deepStrictEqual(await store.readDiff('session-1', 12, 0), textDiff);
			assert.strictEqual(await store.readDiff('session-1', 12, 1), undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('removes every stored record of a deleted session', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-workspace-changes-'));
		const store = new WorkspaceChangeStore(root);
		try {
			await store.record(changes, async index => index === 0 ? textDiff : undefined);
			await store.dispose();

			await store.removeSession('session-1');
			assert.strictEqual((await store.readSession('session-1')).size, 0);
			assert.strictEqual(await store.readDiff('session-1', 12, 0), undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('ignores malformed or foreign stored summaries', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-workspace-changes-'));
		const store = new WorkspaceChangeStore(root);
		try {
			const directory = join(root, 'session-1', '12');
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, 'changes.json'), '{not json');
			assert.strictEqual((await store.readSession('session-1')).size, 0);

			await writeFile(join(directory, 'changes.json'), JSON.stringify({
				...changes,
				sessionId: 'other-session',
			}));
			assert.strictEqual((await store.readSession('session-1')).size, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
