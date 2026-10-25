import * as assert from 'node:assert';
import {
	DEFAULT_MODEL_SELECTION,
		REASONING_LEVELS,
	displayModelSelection,
	isModelSelection,
	sameModelSelection,
} from '../shared/model-selection.ts';

suite('Model selection presentation', () => {
	test('uses the requested default and compact trigger label', () => {
		assert.deepStrictEqual(DEFAULT_MODEL_SELECTION, {
			model: 'deepseek-flash',
			reasoningEffort: 'low',
		});
		assert.strictEqual(
			displayModelSelection(DEFAULT_MODEL_SELECTION),
			'DeepSeek-V4.1-Flash Low',
		);
	});

	test('accepts only the two modeled routes and four reasoning levels', () => {
		assert.deepStrictEqual(
			REASONING_LEVELS.map(level => level.name),
			['Off', 'Low', 'High', 'Max'],
		);
		assert.ok(isModelSelection({
			model: 'deepseek-v4-pro',
			reasoningEffort: 'max',
		}));
		assert.ok(!isModelSelection({
			model: 'deepseek-v4-flash',
			reasoningEffort: 'low',
		}));
		assert.ok(!isModelSelection({
			model: 'deepseek-flash',
			reasoningEffort: 'medium',
		}));
		assert.ok(!isModelSelection({ model: 'deepseek-flash' }));
	});

	test('compares both dimensions of a selection', () => {
		assert.ok(sameModelSelection(
			{ model: 'deepseek-flash', reasoningEffort: 'low' },
			{ model: 'deepseek-flash', reasoningEffort: 'low' },
		));
		assert.ok(!sameModelSelection(
			{ model: 'deepseek-flash', reasoningEffort: 'low' },
			{ model: 'deepseek-flash', reasoningEffort: 'high' },
		));
	});
});
