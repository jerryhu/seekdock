import * as assert from 'node:assert';
import { reasoningSummary } from '../webview/reasoning-summary.ts';

suite('Reasoning summary', () => {
	test('uses the first line after reasoning settles', () => {
		assert.strictEqual(
			reasoningSummary('**Inspect the files**\nThen compare the results', false),
			'Inspect the files',
		);
	});

	test('uses the latest paragraph with a completed first line while streaming', () => {
		assert.strictEqual(
			reasoningSummary('First thought\n\nLatest thought\nUnfinished details', true),
			'Latest thought',
		);
	});

	test('keeps the last completed paragraph while the streaming tail is unfinished', () => {
		assert.strictEqual(
			reasoningSummary('First thought\n\nUnfinished tail', true),
			'First thought',
		);
		assert.strictEqual(reasoningSummary('Unfinished tail', true), '');
	});
});
