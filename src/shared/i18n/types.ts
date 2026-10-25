/** Languages currently supported by the SeekDock interface. */
export const SUPPORTED_LANGUAGES = [
	'en',
	'zh-cn',
	'zh-tw',
	'ru',
	'es',
	'pt',
	'fr',
	'de',
	'ja',
	'ko',
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export interface LanguageOption {
	value: Language;
	label: string;
}

/** Native language names shown in the settings picker. */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
	{ value: 'en', label: 'English' },
	{ value: 'zh-cn', label: '简体中文' },
	{ value: 'zh-tw', label: '繁體中文' },
	{ value: 'ru', label: 'Русский' },
	{ value: 'es', label: 'Español' },
	{ value: 'pt', label: 'Português' },
	{ value: 'fr', label: 'Français' },
	{ value: 'de', label: 'Deutsch' },
	{ value: 'ja', label: '日本語' },
	{ value: 'ko', label: '한국어' },
];

const INTL_LOCALES: Readonly<Record<Language, string>> = {
	en: 'en',
	'zh-cn': 'zh-CN',
	'zh-tw': 'zh-TW',
	ru: 'ru',
	es: 'es',
	pt: 'pt',
	fr: 'fr',
	de: 'de',
	ja: 'ja',
	ko: 'ko',
};

export type TranslationValues = Readonly<Record<string, string | number>>;

/** @returns whether a value is one of the supported language identifiers. */
export function isLanguage(value: unknown): value is Language {
	return typeof value === 'string'
		&& (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Map VS Code, browser, and legacy locale identifiers to a supported language.
 *
 * @param value - platform locale such as `zh-Hans`, `pt-BR`, or `en-US`.
 * @returns the closest supported language, defaulting to English.
 */
export function detectLanguage(value: string | undefined): Language {
	const normalized = value?.trim().toLowerCase().replaceAll('_', '-');
	if (normalized === undefined || normalized.length === 0) {
		return 'en';
	}
	if (normalized === 'zh' || normalized.startsWith('zh-cn') || normalized.startsWith('zh-hans')) {
		return 'zh-cn';
	}
	if (normalized.startsWith('zh-tw')
		|| normalized.startsWith('zh-hk')
		|| normalized.startsWith('zh-hant')) {
		return 'zh-tw';
	}
	const language = normalized.split('-')[0];
	return isLanguage(language) ? language : 'en';
}

/** @returns the BCP 47 locale used by Intl formatters. */
export function intlLocale(language: Language): string {
	return INTL_LOCALES[language];
}

export type Translator = (
	key: import('./en.ts').TranslationKey,
	values?: TranslationValues,
) => string;
