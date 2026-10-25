import * as assert from 'node:assert';
import { tooltipHorizontalShift } from '../webview/tooltip-position.ts';

suite('Tooltip positioning', () => {
	test('shifts a left-clipped tooltip back into the viewport', () => {
		assert.strictEqual(
			tooltipHorizontalShift({ left: -22, right: 38 }, 320),
			30,
		);
	});

	test('shifts a right-clipped tooltip back into the viewport', () => {
		assert.strictEqual(
			tooltipHorizontalShift({ left: 280, right: 350 }, 320),
			-38,
		);
	});

	test('leaves a tooltip inside the viewport unchanged', () => {
		assert.strictEqual(
			tooltipHorizontalShift({ left: 48, right: 108 }, 320),
			0,
		);
	});
});
