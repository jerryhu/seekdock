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

	test('labels running and completed work duration in every language', () => {
		for (const language of SUPPORTED_LANGUAGES) {
			const running = translate(language, 'workingFor', { duration: '1m 2s' });
			const worked = translate(language, 'workedFor', { duration: '1m 2s' });
			const activity = translate(language, 'working');

			assert.ok(running.includes('1m 2s'), `${language} omitted the running duration`);
			assert.ok(worked.includes('1m 2s'), `${language} omitted the worked duration`);
			assert.notStrictEqual(running, worked, `${language} used the same running and worked label`);
			assert.ok(activity.length > 0, `${language} has no running activity label`);
			assert.ok(!activity.includes('{duration}'), `${language} left a placeholder in the activity label`);
		}
		assert.strictEqual(
			translate('en', 'workingFor', { duration: '1m 2s' }),
			'Working for 1m 2s ···',
		);
		assert.strictEqual(
			translate('en', 'workedFor', { duration: '1m 2s' }),
			'Worked for 1m 2s',
		);
		assert.strictEqual(translate('en', 'working'), 'Working');
		assert.strictEqual(
			translate('zh-cn', 'workingFor', { duration: '1m 2s' }),
			'处理中，已用时 1m 2s ···',
		);
		assert.strictEqual(
			translate('zh-cn', 'workedFor', { duration: '1m 2s' }),
			'用时 1m 2s',
		);
		assert.strictEqual(translate('zh-cn', 'working'), '处理中');
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
