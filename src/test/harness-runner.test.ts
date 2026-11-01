import * as assert from 'node:assert';
import { RequestTimeoutError } from '@deepseek-ai/dsh-sdk-client';
import { startHarness } from '../host/harness-runner.ts';

suite('Harness runtime start', () => {
	test('retries once when the initialize handshake times out', async () => {
		let attempts = 0;
		const harness = {
			start: async (): Promise<void> => {
				attempts += 1;
				if (attempts === 1) {
					throw new RequestTimeoutError('initialize timed out after 30000ms waiting for dsh profile "sdk"');
				}
			},
		};

		await startHarness(harness);

		assert.strictEqual(attempts, 2);
	});

	test('reports the timeout after the retry also fails', async () => {
		let attempts = 0;
		const failure = new RequestTimeoutError('initialize timed out after 30000ms waiting for dsh profile "sdk"');
		const harness = {
			start: async (): Promise<void> => {
				attempts += 1;
				throw failure;
			},
		};

		await assert.rejects(startHarness(harness), error => error === failure);
		assert.strictEqual(attempts, 2);
	});

	test('does not retry a runtime that failed to start', async () => {
		let attempts = 0;
		const failure = new Error('dsh profile "sdk": DeepSeek Harness runtime exited');
		const harness = {
			start: async (): Promise<void> => {
				attempts += 1;
				throw failure;
			},
		};

		await assert.rejects(startHarness(harness), error => error === failure);
		assert.strictEqual(attempts, 1);
	});
});
