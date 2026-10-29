import * as assert from 'node:assert';
import { createTranslator } from '../shared/i18n/index.ts';
import { formatDuration, runningStatusLabel } from '../webview/run-duration.ts';

const en = createTranslator('en');

suite('Run duration', () => {
	test('formats seconds, minutes, and hours without leading zeros', () => {
		assert.strictEqual(formatDuration(0, en), '0s');
		assert.strictEqual(formatDuration(9_400, en), '9s');
		assert.strictEqual(formatDuration(62_000, en), '1m 2s');
		assert.strictEqual(formatDuration(3_723_000, en), '1h 2m 3s');
	});

	test('keeps the unknown-duration placeholder for replayed messages', () => {
		assert.strictEqual(formatDuration(undefined, en), '--');
	});

	test('shows the plain activity label before the first whole second', () => {
		assert.deepStrictEqual(runningStatusLabel(0, undefined, en), { primary: 'Working' });
		assert.deepStrictEqual(runningStatusLabel(999, undefined, en), { primary: 'Working' });
	});

	test('adds the elapsed time from the first second on', () => {
		assert.deepStrictEqual(
			runningStatusLabel(1_000, { phase: 'thinking' }, en),
			{ primary: 'Working for 1s ···' },
		);
		assert.deepStrictEqual(
			runningStatusLabel(62_000, { phase: 'writing' }, en),
			{ primary: 'Working for 1m 2s ···' },
		);
	});

	test('names the tool while a tool call is being prepared', () => {
		assert.deepStrictEqual(
			runningStatusLabel(5_000, { phase: 'tool', toolName: 'Read' }, en),
			{
				primary: 'Working for 5s ···',
				detail: 'Preparing Read',
			},
		);
		assert.deepStrictEqual(
			runningStatusLabel(5_000, { phase: 'tool' }, en),
			{
				primary: 'Working for 5s ···',
				detail: 'Preparing tool call',
			},
		);
	});
});
