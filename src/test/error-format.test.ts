import * as assert from 'node:assert';
import { formatErrorMessage } from '../host/error-format.ts';

suite('Error formatting', () => {
	test('removes every occurrence of the active credential', () => {
		const message = formatErrorMessage(
			new Error('request failed for sk-secret; retry sk-secret'),
			'sk-secret',
		);

		assert.strictEqual(message, 'request failed for [redacted]; retry [redacted]');
	});

	test('bounds provider errors before they reach the Webview', () => {
		const message = formatErrorMessage(new Error('x'.repeat(4_100)));

		assert.strictEqual(message.length, 4_001);
		assert.ok(message.endsWith('…'));
	});
});
