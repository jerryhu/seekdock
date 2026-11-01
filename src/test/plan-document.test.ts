import * as assert from 'node:assert';
import {
	planDocument,
	planDocumentFromArguments,
	planFileName,
	planSummary,
	planTitle,
} from '../shared/plan-document.ts';

const PLAN = [
	'# Add a widget to the composer',
	'',
	'Render **one** widget above the textarea, then',
	'wire it to the store.',
	'',
	'- step one',
	'- step two',
].join('\n');

suite('Plan document', () => {
	test('derives the title and opening paragraph from plan Markdown', () => {
		assert.deepStrictEqual(planDocument(PLAN), {
			title: 'Add a widget to the composer',
			markdown: PLAN,
			summary: 'Render one widget above the textarea, then wire it to the store.',
		});
	});

	test('falls back to a generic title and empty summary', () => {
		assert.strictEqual(planTitle('Just prose, no heading.'), 'Plan');
		assert.strictEqual(planSummary('# Only a heading'), '');
		assert.strictEqual(planTitle('#   Padded heading   '), 'Padded heading');
	});

	test('reads the plan out of logged exit_plan_mode arguments', () => {
		assert.deepStrictEqual(
			planDocumentFromArguments(JSON.stringify({ plan: PLAN }))?.title,
			'Add a widget to the composer',
		);
		assert.strictEqual(planDocumentFromArguments('not json'), undefined);
		assert.strictEqual(planDocumentFromArguments('{"plan":5}'), undefined);
		assert.strictEqual(planDocumentFromArguments('{"plan":"   "}'), undefined);
	});

	test('names one Markdown file per plan, stable across sessions', () => {
		const name = planFileName('Add a widget to the composer', PLAN);
		assert.match(name, /^Add a widget to the composer-[0-9a-f]{8}\.md$/);
		assert.strictEqual(name, planFileName('Add a widget to the composer', PLAN));
		assert.notStrictEqual(name, planFileName('Add a widget to the composer', `${PLAN}!`));
	});

	test('keeps file names safe for every platform', () => {
		assert.strictEqual(planFileName('a/b:c*?"<>|d', PLAN), `a-b-c-d-${hashSuffix(PLAN)}.md`);
		assert.match(planFileName('   ', PLAN), /^plan-[0-9a-f]{8}\.md$/);
		assert.ok(planFileName('x'.repeat(200), PLAN).length < 90);
	});
});

function hashSuffix(markdown: string): string {
	return planFileName('x', markdown).replace(/^x-/, '').replace(/\.md$/, '');
}
