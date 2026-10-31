import * as assert from 'node:assert';
import { recoverableToolError } from '../host/tool-call-error.ts';

suite('Recoverable tool errors', () => {
	test('maps stale and unread filesystem failures only', () => {
		assert.strictEqual(recoverableToolError('FS_NOT_OBSERVED'), 'file-not-read');
		assert.strictEqual(recoverableToolError('FS_STALE_VERSION'), 'file-changed');
		assert.strictEqual(recoverableToolError('FS_NOT_FOUND'), undefined);
		assert.strictEqual(recoverableToolError(undefined), undefined);
		assert.strictEqual(recoverableToolError(42), undefined);
	});
});
