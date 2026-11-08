import * as assert from 'node:assert';
import { composerDecisions } from '../shared/composer-availability.ts';

suite('Composer availability', () => {
	test('keeps the draft editable while the runtime starts', () => {
		assert.deepStrictEqual(
			composerDecisions({ configured: true, busy: false, runtimeStatus: 'initializing' }),
			{ editable: true, sendable: true },
		);
		assert.deepStrictEqual(
			composerDecisions({ configured: true, busy: false, runtimeStatus: 'ready' }),
			{ editable: true, sendable: true },
		);
	});

	test('sends nothing without a live or starting runtime', () => {
		assert.deepStrictEqual(
			composerDecisions({ configured: true, busy: false, runtimeStatus: 'idle' }),
			{ editable: true, sendable: false },
		);
		assert.deepStrictEqual(
			composerDecisions({ configured: true, busy: false, runtimeStatus: 'error' }),
			{ editable: true, sendable: false },
		);
	});

	test('blocks a second turn while one runs', () => {
		assert.deepStrictEqual(
			composerDecisions({ configured: true, busy: true, runtimeStatus: 'ready' }),
			{ editable: true, sendable: false },
		);
	});

	test('requires an API key before accepting the draft', () => {
		assert.deepStrictEqual(
			composerDecisions({ configured: false, busy: false, runtimeStatus: 'ready' }),
			{ editable: false, sendable: false },
		);
	});
});
