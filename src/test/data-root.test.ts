import * as assert from 'node:assert';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_ROOT_DIRECTORY_NAME, resolveDataRoot } from '../host/data-root.ts';

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

suite('Data root', () => {
	const temporaryPaths: string[] = [];

	suiteTeardown(async () => {
		for (const path of temporaryPaths) {
			await rm(path, { recursive: true, force: true });
		}
	});

	async function track(path: string): Promise<string> {
		temporaryPaths.push(path);
		return path;
	}

	test('creates an empty data root for a fresh installation', async () => {
		const home = await track(await createHome());

		const root = await resolveDataRoot({ homeDirectory: home });

		assert.strictEqual(root, join(home, DATA_ROOT_DIRECTORY_NAME));
		assert.deepStrictEqual(await readdir(root), [], 'the fresh data root is not empty');
	});

	test('prefers the override over the home directory', async () => {
		const home = await track(await createHome());
		const override = await track(await createHome());

		const root = await resolveDataRoot({
			homeDirectory: home,
			overridePath: join(override, 'custom-root'),
		});

		assert.strictEqual(root, join(override, 'custom-root'));
		assert.ok(await exists(root), 'the override directory was not created');
	});

	test('ignores a blank override', async () => {
		const home = await track(await createHome());

		const root = await resolveDataRoot({ homeDirectory: home, overridePath: '  ' });

		assert.strictEqual(root, join(home, DATA_ROOT_DIRECTORY_NAME));
	});

	test('leaves an existing data root untouched', async () => {
		const home = await track(await createHome());
		const root = join(home, DATA_ROOT_DIRECTORY_NAME);
		await mkdir(join(root, 'dsh-home'), { recursive: true });
		await writeFile(join(root, 'dsh-home', 'current.jsonl'), 'current');

		const resolved = await resolveDataRoot({ homeDirectory: home });

		assert.strictEqual(resolved, root);
		assert.deepStrictEqual(await readdir(root), ['dsh-home'], 'the existing data root was modified');
		assert.strictEqual(await readFile(join(root, 'dsh-home', 'current.jsonl'), 'utf8'), 'current');
	});

	test('fails instead of falling back when the data root cannot be created', async () => {
		const home = await track(await createHome());
		const blocker = join(home, 'blocker');
		await writeFile(blocker, 'not a directory');

		await assert.rejects(
			() => resolveDataRoot({ homeDirectory: join(blocker, 'nested') }),
			(error: unknown) => {
				assert.ok(error instanceof Error, 'the failure is not an Error');
				assert.match(error.message, /cannot create the data directory/);
				const cause = error.cause as NodeJS.ErrnoException | undefined;
				assert.strictEqual(cause?.code, 'ENOTDIR');
				return true;
			},
		);
	});
});
