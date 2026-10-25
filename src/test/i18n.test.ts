import * as assert from 'node:assert';
import {
	LANGUAGE_OPTIONS,
	SUPPORTED_LANGUAGES,
	detectLanguage,
	intlLocale,
	translate,
} from '../shared/i18n/index.ts';
import { detectInitialLanguage } from '../webview/i18n-context.tsx';

suite('Interface localization', () => {
	test('exposes every supported language in the settings picker', () => {
		assert.deepStrictEqual(
			LANGUAGE_OPTIONS.map(option => option.value),
			[...SUPPORTED_LANGUAGES],
		);
		assert.strictEqual(LANGUAGE_OPTIONS.length, 10);
	});

	test('maps VS Code and browser locales to supported languages', () => {
		assert.strictEqual(detectLanguage('zh-Hans'), 'zh-cn');
		assert.strictEqual(detectLanguage('zh-CN'), 'zh-cn');
		assert.strictEqual(detectLanguage('zh-Hant-HK'), 'zh-tw');
		assert.strictEqual(detectLanguage('pt-BR'), 'pt');
		assert.strictEqual(detectLanguage('es-419'), 'es');
		assert.strictEqual(detectLanguage('de-DE'), 'de');
		assert.strictEqual(detectLanguage('ko-KR'), 'ko');
		assert.strictEqual(detectLanguage('it-IT'), 'en');
		assert.strictEqual(detectLanguage(undefined), 'en');
	});

	test('translates and interpolates strings in every language', () => {
		for (const language of SUPPORTED_LANGUAGES) {
			const text = translate(language, 'messageCount', { count: 3 });
			assert.ok(text.includes('3'), `${language} did not interpolate the message count`);
			assert.notStrictEqual(text, 'messageCount');
			assert.ok(intlLocale(language).length > 0);
		}
		assert.strictEqual(translate('zh-tw', 'settings'), '設定');
		assert.strictEqual(translate('ru', 'cancel'), 'Отмена');
		assert.strictEqual(translate('fr', 'save'), 'Enregistrer');
	});

	test('uses the host-declared document language before the first state message', () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: { documentElement: { lang: 'zh-TW' } },
		});
		try {
			assert.strictEqual(detectInitialLanguage(), 'zh-tw');
		} finally {
			if (previous === undefined) {
				delete (globalThis as { document?: unknown }).document;
			} else {
				Object.defineProperty(globalThis, 'document', previous);
			}
		}
	});
});
