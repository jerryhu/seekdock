import { de } from './de.ts';
import {
	en,
	type TranslationDictionary,
	type TranslationKey,
} from './en.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { ja } from './ja.ts';
import { ko } from './ko.ts';
import { pt } from './pt.ts';
import { ru } from './ru.ts';
import {
	type Language,
	type Translator,
	type TranslationValues,
} from './types.ts';
import { zhCn } from './zh-cn.ts';
import { zhTw } from './zh-tw.ts';

export {
	LANGUAGE_OPTIONS,
	SUPPORTED_LANGUAGES,
	detectLanguage,
	intlLocale,
	isLanguage,
	type Language,
	type LanguageOption,
	type Translator,
	type TranslationValues,
} from './types.ts';
export { type TranslationKey } from './en.ts';

const DICTIONARIES: Readonly<Record<Language, TranslationDictionary>> = {
	en,
	'zh-cn': zhCn,
	'zh-tw': zhTw,
	ru,
	es,
	pt,
	fr,
	de,
	ja,
	ko,
};

/**
 * Resolve one typed interface string and interpolate `{name}` placeholders.
 *
 * @param language - active interface language.
 * @param key - strongly typed message key.
 * @param values - optional placeholder values.
 * @returns localized text, falling back to English for an invalid runtime value.
 */
export function translate(
	language: Language,
	key: TranslationKey,
	values?: TranslationValues,
): string {
	const dictionary = DICTIONARIES[language] ?? en;
	const template = dictionary[key] ?? en[key];
	if (values === undefined) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
		const value = values[name];
		return value === undefined ? placeholder : String(value);
	});
}

/** @returns a translator bound to one interface language. */
export function createTranslator(language: Language): Translator {
	return (key, values) => translate(language, key, values);
}

/** Error carrying a translation key so the host can localize at send time. */
export class LocalizedError extends Error {
	constructor(
		readonly key: TranslationKey,
		readonly values?: TranslationValues,
		options?: ErrorOptions,
	) {
		super(key, options);
		this.name = 'LocalizedError';
	}
}
