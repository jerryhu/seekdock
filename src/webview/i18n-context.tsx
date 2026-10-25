import { createContext } from 'preact';
import { useContext, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
	createTranslator,
	detectLanguage,
	intlLocale,
	type Language,
	type Translator,
} from '../shared/i18n/index.ts';

interface I18nContextValue {
	language: Language;
	t: Translator;
}

const FALLBACK: I18nContextValue = {
	language: 'en',
	t: createTranslator('en'),
};

const I18nContext = createContext<I18nContextValue>(FALLBACK);

/**
 * Resolve the language before the host's first state message arrives.
 * The extension writes its persisted language into the document's `lang`
 * attribute, which is more reliable than the Webview's browser locale.
 *
 * @returns the host-declared language, or the closest browser language.
 */
export function detectInitialLanguage(): Language {
	const declared = typeof document === 'undefined'
		? undefined
		: document.documentElement.lang;
	if (declared !== undefined && declared.trim().length > 0) {
		return detectLanguage(declared);
	}
	return detectLanguage(
		typeof navigator === 'undefined' ? undefined : navigator.language,
	);
}

/** Provide the active interface language to nested Webview components. */
export function I18nProvider({
	language,
	children,
}: {
	language: Language;
	children: ComponentChildren;
}): preact.JSX.Element {
	useEffect(() => {
		document.documentElement.lang = intlLocale(language);
	}, [language]);
	return (
		<I18nContext.Provider value={{ language, t: createTranslator(language) }}>
			{children}
		</I18nContext.Provider>
	);
}

/** @returns the active language and its typed translator. */
export function useI18n(): I18nContextValue {
	return useContext(I18nContext);
}
