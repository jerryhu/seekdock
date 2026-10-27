import * as assert from 'node:assert';
import { formatMessageClock } from '../webview/message-clock.ts';

suite('Message clock', () => {
	const now = new Date(2026, 9, 27, 10, 0).getTime();

	test('shows only the time for messages from the current day', () => {
		assert.strictEqual(
			formatMessageClock(new Date(2026, 9, 27, 14, 38).getTime(), 'en', now),
			'14:38',
		);
	});

	test('shows month and day for earlier messages in the current year', () => {
		assert.strictEqual(
			formatMessageClock(new Date(2026, 9, 26, 14, 38).getTime(), 'en', now),
			'10/26 14:38',
		);
	});

	test('adds the year for messages from an earlier year', () => {
		assert.strictEqual(
			formatMessageClock(new Date(2025, 9, 26, 14, 38).getTime(), 'en', now),
			'10/26/2025 14:38',
		);
	});
});
