import * as assert from 'node:assert';
import {
	buildPromptWithSkills,
	composerSkillSourceMeta,
	filterEnabledComposerSkills,
	filterComposerSkills,
	groupComposerSkills,
	normalizeSkillSource,
	slashQueryFromDraft,
	updateDisabledSkillNames,
	type ComposerSkill,
} from '../shared/composer-skills.ts';

const SKILLS: ComposerSkill[] = [
	{ name: 'adobe-xd', description: 'Design prototypes', source: 'user' },
	{ name: 'office-pdf', description: 'Convert office documents', source: 'workspace' },
	{ name: 'project-review', description: 'Review local changes', source: 'workspace' },
	{ name: 'pdf', description: 'Read and create PDF files', source: 'user' },
];

suite('Composer skills', () => {
	test('maps sources to the Workspace and User groups', () => {
		assert.strictEqual(normalizeSkillSource('workspace'), 'workspace');
		assert.strictEqual(normalizeSkillSource('user'), 'user');
		assert.strictEqual(normalizeSkillSource('runtime'), undefined);

		assert.deepStrictEqual(composerSkillSourceMeta('workspace'), {
			label: 'Workspace',
			rank: 100,
		});
		assert.deepStrictEqual(composerSkillSourceMeta('user'), {
			label: 'User',
			rank: 200,
		});
	});

	test('groups skills by source priority', () => {
		assert.deepStrictEqual(
			groupComposerSkills([
				...SKILLS,
				{ name: 'shared', description: 'Shared', source: 'user' },
			]).map(group => group.source),
			['workspace', 'user'],
		);
	});

	test('opens the slash menu only for a single leading skill token', () => {
		assert.strictEqual(slashQueryFromDraft('/'), '');
		assert.strictEqual(slashQueryFromDraft('/pdf'), 'pdf');
		assert.strictEqual(slashQueryFromDraft('/pdf prompt'), undefined);
		assert.strictEqual(slashQueryFromDraft('explain /pdf'), undefined);
		assert.strictEqual(slashQueryFromDraft(''), undefined);
	});

	test('ranks exact, prefix, substring, and description matches', () => {
		assert.deepStrictEqual(
			filterComposerSkills(SKILLS, 'pdf').map(skill => skill.name),
			['pdf', 'office-pdf'],
		);
		assert.deepStrictEqual(
			filterComposerSkills(SKILLS, 'office').map(skill => skill.name),
			['office-pdf'],
		);
		assert.deepStrictEqual(
			filterComposerSkills(SKILLS, 'prototype').map(skill => skill.name),
			['adobe-xd'],
		);
	});

	test('builds multiple slash invocations in chip order without duplicates', () => {
		assert.strictEqual(buildPromptWithSkills('', ['pdf']), '/pdf');
		assert.strictEqual(
			buildPromptWithSkills('summarize this', ['pdf', 'adobe-xd', 'pdf']),
			'/pdf /adobe-xd summarize this',
		);
		assert.strictEqual(buildPromptWithSkills('keep prose', []), 'keep prose');
	});

	test('hides disabled skills and updates the persisted name set', () => {
		const disabled = updateDisabledSkillNames([], 'pdf', false);
		assert.deepStrictEqual(disabled, ['pdf']);
		assert.deepStrictEqual(
			filterEnabledComposerSkills(SKILLS, disabled).map(skill => skill.name),
			['adobe-xd', 'office-pdf', 'project-review'],
		);
		assert.deepStrictEqual(updateDisabledSkillNames(disabled, 'pdf', true), []);
	});
});
