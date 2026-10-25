import * as assert from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SYSTEM_PROMPT_STATE_KEY,
	SystemPromptStore,
	type PromptStateStorage,
} from '../host/system-prompt-store.ts';
import { LocalizedError } from '../shared/i18n/index.ts';

class MemoryState implements PromptStateStorage {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}
}

suite('System prompt store', () => {
	test('uses the packaged default, persists overrides, and restores the default', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-prompt-store-'));
		const defaultPromptPath = join(root, 'default.md');
		const runtimePromptPath = join(root, 'runtime', 'active.md');
		const state = new MemoryState();
		const store = new SystemPromptStore(defaultPromptPath, runtimePromptPath, state);

		try {
			await writeFile(defaultPromptPath, 'Default prompt\n', 'utf8');
			assert.deepStrictEqual(await store.getState(), {
				systemPrompt: 'Default prompt',
				isDefault: true,
			});
			assert.strictEqual(await store.syncRuntimePrompt(), 'Default prompt');
			assert.strictEqual(await readFile(runtimePromptPath, 'utf8'), 'Default prompt');

			await store.save('Custom prompt\n');
			assert.deepStrictEqual(await store.getState(), {
				systemPrompt: 'Custom prompt',
				isDefault: false,
			});
			assert.strictEqual(state.get<string>(SYSTEM_PROMPT_STATE_KEY), 'Custom prompt');
			assert.strictEqual(await readFile(runtimePromptPath, 'utf8'), 'Custom prompt');

			await store.reset();
			assert.deepStrictEqual(await store.getState(), {
				systemPrompt: 'Default prompt',
				isDefault: true,
			});
			assert.strictEqual(state.get<string>(SYSTEM_PROMPT_STATE_KEY), undefined);
			assert.strictEqual(await readFile(runtimePromptPath, 'utf8'), 'Default prompt');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('rejects an empty prompt', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-prompt-empty-'));
		const defaultPromptPath = join(root, 'default.md');
		const store = new SystemPromptStore(
			defaultPromptPath,
			join(root, 'active.md'),
			new MemoryState(),
		);

		try {
			await writeFile(defaultPromptPath, 'Default prompt\n', 'utf8');
			await assert.rejects(
				store.save('   \n'),
				error => error instanceof LocalizedError && error.key === 'hostPromptEmpty',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
