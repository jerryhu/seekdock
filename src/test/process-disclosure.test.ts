import * as assert from 'node:assert';
import { processRowsVisible } from '../webview/process-disclosure.ts';

suite('Process rows disclosure', () => {
	test('keeps reasoning and tool rows visible while the answer streams', () => {
		assert.strictEqual(processRowsVisible(true, false), true);
		assert.strictEqual(processRowsVisible(true, true), true);
	});

	test('folds reasoning and tool rows when the answer settles', () => {
		assert.strictEqual(processRowsVisible(false, false), false);
	});

	test('reopens settled reasoning and tool rows after the reader expands them', () => {
		assert.strictEqual(processRowsVisible(false, true), true);
	});
});
