/** The two directory-backed skill scopes supported by SeekDock. */
export type ComposerSkillSource = 'workspace' | 'user';

interface ComposerSkillSourceMeta {
	label: string;
	rank: number;
}

const COMPOSER_SKILL_SOURCE_META: Record<ComposerSkillSource, ComposerSkillSourceMeta> = {
	workspace: {
		label: 'Workspace',
		rank: 100,
	},
	user: {
		label: 'User',
		rank: 200,
	},
};

/** Skill metadata the Webview can render without reading the instruction file. */
export interface ComposerSkill {
	name: string;
	description: string;
	source: ComposerSkillSource;
}

/**
 * Normalize a skill source returned by the SeekDock runtime bridge.
 *
 * @param source - source reported by the bridge.
 * @returns the supported source, or undefined for an unknown source.
 */
export function normalizeSkillSource(source: string): ComposerSkillSource | undefined {
	return isComposerSkillSource(source) ? source : undefined;
}

/**
 * @param source - supported skill scope.
 * @returns the display label and group order.
 */
export function composerSkillSourceMeta(source: ComposerSkillSource): ComposerSkillSourceMeta {
	return COMPOSER_SKILL_SOURCE_META[source];
}

/**
 * Return the slash query while the draft is a single leading skill token.
 *
 * @param draft - current composer text.
 * @returns text after the slash, or undefined when the slash menu should close.
 */
export function slashQueryFromDraft(draft: string): string | undefined {
	if (!draft.startsWith('/')) {
		return undefined;
	}
	const query = draft.slice(1);
	return /\s/.test(query) ? undefined : query;
}

/**
 * Rank skills by exact name, prefix, substring, name subsequence, and finally
 * description match. The result is stable for equal scores.
 *
 * @param skills - full catalog reported by DSH.
 * @param query - text typed after the slash.
 * @returns matching skills in display order.
 */
export function filterComposerSkills(
	skills: readonly ComposerSkill[],
	query: string,
): readonly ComposerSkill[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return [...skills].sort((left, right) => left.name.localeCompare(right.name));
	}
	return skills
		.map((skill, index) => ({
			skill,
			index,
			score: skillMatchScore(skill, needle),
		}))
		.filter(entry => entry.score >= 0)
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.map(entry => entry.skill);
}

/**
 * Group the filtered skills under their supported directory scopes.
 *
 * @param skills - skills after the slash-query filter.
 * @returns ordered non-empty source groups.
 */
export function groupComposerSkills(
	skills: readonly ComposerSkill[],
): readonly { source: ComposerSkillSource; skills: readonly ComposerSkill[] }[] {
	return (Object.keys(COMPOSER_SKILL_SOURCE_META) as ComposerSkillSource[])
		.map(source => ({
			source,
			skills: skills.filter(skill => skill.source === source),
		}))
		.filter(group => group.skills.length > 0);
}

/**
 * Remove skills that the user has disabled in settings.
 *
 * @param skills - full catalog reported by DSH.
 * @param disabledNames - persisted names hidden from the slash menu.
 * @returns enabled skills without mutating the DSH catalog.
 */
export function filterEnabledComposerSkills(
	skills: readonly ComposerSkill[],
	disabledNames: readonly string[],
): readonly ComposerSkill[] {
	if (disabledNames.length === 0) {
		return skills;
	}
	const disabled = new Set(disabledNames);
	return skills.filter(skill => !disabled.has(skill.name));
}

/**
 * Update the persisted disabled-skill set without changing catalog ordering.
 *
 * @param disabledNames - current persisted names.
 * @param name - skill whose enabled state changed.
 * @param enabled - new enabled state.
 * @returns normalized names sorted for stable global-state output.
 */
export function updateDisabledSkillNames(
	disabledNames: readonly string[],
	name: string,
	enabled: boolean,
): readonly string[] {
	const next = new Set(disabledNames);
	if (enabled) {
		next.delete(name);
	} else {
		next.add(name);
	}
	return [...next].sort((left, right) => left.localeCompare(right));
}

function isComposerSkillSource(source: string): source is ComposerSkillSource {
	return Object.hasOwn(COMPOSER_SKILL_SOURCE_META, source);
}

/**
 * Build the plain-text form DSH recognizes as explicit user skill calls.
 *
 * @param text - prompt text without skill invocations.
 * @param skillNames - selected skill names in chip order.
 * @returns slash invocations followed by the prompt.
 */
export function buildPromptWithSkills(text: string, skillNames: readonly string[]): string {
	const invocations = [...new Set(skillNames)].map(name => `/${name}`).join(' ');
	const prompt = text.trim();
	if (invocations.length === 0) {
		return prompt;
	}
	return prompt.length === 0 ? invocations : `${invocations} ${prompt}`;
}

function skillMatchScore(skill: ComposerSkill, needle: string): number {
	const name = skill.name.toLowerCase();
	if (name === needle) {
		return 0;
	}
	if (name.startsWith(needle)) {
		return 1;
	}
	if (name.includes(needle)) {
		return 2;
	}
	if (isOrderedSubsequence(needle, name)) {
		return 3;
	}
	if (skill.description.toLowerCase().includes(needle)) {
		return 4;
	}
	return -1;
}

function isOrderedSubsequence(needle: string, value: string): boolean {
	let cursor = 0;
	for (const character of value) {
		if (character === needle[cursor]) {
			cursor += 1;
			if (cursor === needle.length) {
				return true;
			}
		}
	}
	return false;
}
