import * as assert from 'node:assert';
import { RequestTimeoutError } from '@deepseek-ai/dsh-sdk-client';
import { runtimeProcessCwd, startHarness } from '../host/harness-runner.ts';

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

suite('Harness runtime process cwd', () => {
	test('uppercases the drive letter of a Windows runtime home', () => {
		assert.strictEqual(
			runtimeProcessCwd('c:\\Users\\jerry\\.seekdock\\runtime-home', 'win32'),
			'C:\\Users\\jerry\\.seekdock\\runtime-home',
		);
	});

	test('normalizes forward-slash Windows paths', () => {
		assert.strictEqual(
			runtimeProcessCwd('c:/Users/jerry/.seekdock/runtime-home', 'win32'),
			'C:\\Users\\jerry\\.seekdock\\runtime-home',
		);
	});

	test('keeps an uppercase C: runtime home unchanged', () => {
		assert.strictEqual(
			runtimeProcessCwd('C:\\Users\\jerry\\.seekdock\\runtime-home', 'win32'),
			'C:\\Users\\jerry\\.seekdock\\runtime-home',
		);
	});

	test('falls back to C: when the runtime home is on another drive', () => {
		assert.strictEqual(
			runtimeProcessCwd('D:\\data\\seekdock\\runtime-home', 'win32'),
			'C:\\',
		);
	});

	test('falls back to C: for a UNC runtime home', () => {
		assert.strictEqual(
			runtimeProcessCwd('\\\\server\\share\\runtime-home', 'win32'),
			'C:\\',
		);
	});

	test('keeps non-Windows paths unchanged', () => {
		assert.strictEqual(
			runtimeProcessCwd('/home/jerry/.seekdock/runtime-home', 'linux'),
			'/home/jerry/.seekdock/runtime-home',
		);
	});
});
