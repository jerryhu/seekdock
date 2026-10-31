import * as assert from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DATA_ROOT_DIRECTORY_NAME,
	MIGRATE_LEGACY_DATA,
	resolveDataRoot,
	type DataRootFileOps,
} from '../host/data-root.ts';

/** Builds the directory layout older builds wrote into the extension storage. */
async function createLegacyRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'seekdock-legacy-'));
	const session = join(root, 'dsh-home', 'sessions', '--workspace--', 'session-1');
	await mkdir(session, { recursive: true });
	await writeFile(join(session, 'session.v4.jsonl.zstd'), 'transcript');
	await writeFile(join(root, 'active-system-prompt.md'), 'prompt');
	await mkdir(join(root, 'mcp'), { recursive: true });
	await writeFile(join(root, 'mcp', 'servers.json'), '[]');
	await mkdir(join(root, 'runtime-home', '.cache'), { recursive: true });
	await writeFile(join(root, 'runtime-home', '.cache', 'package.json'), '{}');
	return root;
}

async function createHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'seekdock-home-'));
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function fileHasCode(code: string): Error {
	return Object.assign(new Error(code), { code });
}

suite('Data root', () => {
	const temporaryPaths: string[] = [];

	// Every case leaves a few temp trees behind, so remove them in parallel and
	// give the hook more than mocha's default budget.
	suiteTeardown(async function (this: Mocha.Context) {
		this.timeout(10000);
		await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })));
	});

	async function track(path: string): Promise<string> {
		temporaryPaths.push(path);
		return path;
	}

	test('creates the data root for a fresh installation and leaves nothing behind', async () => {
		const home = await track(await createHome());
		const legacy = await track(join(home, 'globalStorage', 'jerryhu.seekdock'));

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });

		assert.strictEqual(resolved.root, join(home, DATA_ROOT_DIRECTORY_NAME));
		assert.strictEqual(resolved.migratedFrom, undefined);
		assert.ok(await exists(resolved.root), 'the data root was not created');
	});

	test('moves every durable entry out of the extension storage and drops the caches', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });
		const root = join(home, DATA_ROOT_DIRECTORY_NAME);

		assert.strictEqual(resolved.root, root);
		assert.strictEqual(resolved.migratedFrom, legacy);
		assert.deepStrictEqual(
			(await readdir(root)).sort(),
			['.layout.json', 'active-system-prompt.md', 'dsh-home', 'mcp'],
			'the data root does not hold exactly the durable entries and the layout marker',
		);
		assert.strictEqual(
			await readFile(
				join(root, 'dsh-home', 'sessions', '--workspace--', 'session-1', 'session.v4.jsonl.zstd'),
				'utf8',
			),
			'transcript',
			'the session transcript did not survive the migration',
		);
		assert.ok(!await exists(legacy), 'the previous extension storage directory is still present');
	});

	test('is idempotent once the data root holds the layout', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());

		const first = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });
		const second = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });

		assert.strictEqual(first.migratedFrom, legacy);
		assert.strictEqual(second.root, first.root);
		assert.strictEqual(second.migratedFrom, undefined, 'the migration ran twice');
	});

	test('follows the compiled-in migration switch when the caller does not override it', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home });

		if (MIGRATE_LEGACY_DATA) {
			assert.strictEqual(resolved.migratedFrom, legacy);
		} else {
			assert.strictEqual(resolved.migratedFrom, undefined);
			assert.deepStrictEqual(
				(await readdir(legacy)).sort(),
				['active-system-prompt.md', 'dsh-home', 'mcp', 'runtime-home'],
				'the retired migration still touched the previous store',
			);
		}
	});

	test('skips the migration and leaves the previous store untouched when the switch is off', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());

		const resolved = await resolveDataRoot({
			legacyRoot: legacy,
			homeDirectory: home,
			migrate: false,
		});

		assert.strictEqual(resolved.root, join(home, DATA_ROOT_DIRECTORY_NAME));
		assert.strictEqual(resolved.migratedFrom, undefined);
		assert.deepStrictEqual(await readdir(resolved.root), [], 'the data root should stay empty');
		assert.deepStrictEqual(
			(await readdir(legacy)).sort(),
			['active-system-prompt.md', 'dsh-home', 'mcp', 'runtime-home'],
			'the switch off must not touch the previous store',
		);
	});

	test('migrates on a later activation once the switch is back on', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());

		await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: false });
		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });

		assert.strictEqual(resolved.root, join(home, DATA_ROOT_DIRECTORY_NAME));
		assert.strictEqual(resolved.migratedFrom, legacy);
		assert.ok(!await exists(legacy), 'the previous extension storage directory is still present');
	});

	test('never merges two populated stores', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());
		const root = join(home, DATA_ROOT_DIRECTORY_NAME);
		await mkdir(join(root, 'dsh-home'), { recursive: true });
		await writeFile(join(root, 'dsh-home', 'current.jsonl'), 'current');

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true });

		assert.strictEqual(resolved.root, root);
		assert.strictEqual(resolved.migratedFrom, undefined);
		assert.deepStrictEqual(await readdir(join(root, 'dsh-home')), ['current.jsonl']);
		assert.ok(await exists(join(legacy, 'dsh-home')), 'the untouched store lost its data');
	});

	test('rolls back and keeps the previous location when a move fails', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());
		let moves = 0;
		const fileOps: Partial<DataRootFileOps> = {
			async move(from, to) {
				moves += 1;
				if (moves === 2) {
					throw fileHasCode('EACCES');
				}
				await rename(from, to);
			},
		};

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true, fileOps });

		assert.strictEqual(resolved.root, legacy, 'a failed migration did not fall back');
		assert.strictEqual(resolved.migratedFrom, undefined);
		assert.deepStrictEqual(
			(await readdir(legacy)).sort(),
			['active-system-prompt.md', 'dsh-home', 'mcp', 'runtime-home'],
			'the rollback did not restore every entry',
		);
		assert.deepStrictEqual(
			await readdir(join(home, DATA_ROOT_DIRECTORY_NAME)),
			[],
			'the aborted migration left data in the new root',
		);
	});

	test('copies the store when the data root lives on another device', async () => {
		const home = await track(await createHome());
		const legacy = await track(await createLegacyRoot());
		const fileOps: Partial<DataRootFileOps> = {
			async move() {
				throw fileHasCode('EXDEV');
			},
		};

		const resolved = await resolveDataRoot({ legacyRoot: legacy, homeDirectory: home, migrate: true, fileOps });
		const root = join(home, DATA_ROOT_DIRECTORY_NAME);

		assert.strictEqual(resolved.root, root);
		assert.strictEqual(resolved.migratedFrom, legacy);
		assert.deepStrictEqual(
			(await readdir(root)).sort(),
			['.layout.json', 'active-system-prompt.md', 'dsh-home', 'mcp'],
			'the cross-device fallback did not copy the durable entries',
		);
		assert.strictEqual(
			await readFile(join(root, 'active-system-prompt.md'), 'utf8'),
			'prompt',
		);
		assert.ok(!await exists(legacy), 'the copied entries were left behind');
	});

	test('prefers the override over the home directory', async () => {
		const home = await track(await createHome());
		const override = await track(await createHome());

		const resolved = await resolveDataRoot({
			legacyRoot: join(home, 'globalStorage', 'jerryhu.seekdock'),
			homeDirectory: home,
			overridePath: join(override, 'custom-root'),
		});

		assert.strictEqual(resolved.root, join(override, 'custom-root'));
		assert.ok(await exists(resolved.root));
	});

	test('keeps the previous location when the home directory is not writable', async () => {
		const home = await track(await createHome());
		const blocked = join(home, 'blocker');
		await writeFile(blocked, 'not a directory');
		const legacy = await track(await createLegacyRoot());

		const resolved = await resolveDataRoot({
			legacyRoot: legacy,
			homeDirectory: join(blocked, 'nested'),
		});

		assert.strictEqual(resolved.root, legacy);
		assert.ok(await exists(join(legacy, 'dsh-home')));
	});

	test('does nothing when the override already points at the previous location', async () => {
		const legacy = await track(await createLegacyRoot());

		const resolved = await resolveDataRoot({
			legacyRoot: legacy,
			homeDirectory: join(legacy, 'home'),
			overridePath: legacy,
		});

		assert.strictEqual(resolved.root, legacy);
		assert.strictEqual(resolved.migratedFrom, undefined);
		assert.deepStrictEqual(
			(await readdir(legacy)).sort(),
			['active-system-prompt.md', 'dsh-home', 'mcp', 'runtime-home'],
		);
	});
});
