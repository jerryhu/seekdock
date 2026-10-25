import {
	LocalizedError,
	translate,
	type Language,
} from '../shared/i18n/index.ts';

const MAX_VISIBLE_ERROR_LENGTH = 4_000;
const REDACTED_API_KEY = '[redacted]';

/**
 * Convert an unknown failure into text that is safe to show in a Webview.
 *
 * SecretStorage can return a credential that an SDK error echoes back, so the
 * active key is removed before the message crosses the trust boundary.
 *
 * @param error - failure raised by DSH, VS Code, or local validation.
 * @param apiKey - credential that must never appear in rendered errors.
 * @param language - language used for `LocalizedError` messages.
 * @returns bounded, credential-free error text.
 */
export function formatErrorMessage(
	error: unknown,
	apiKey = '',
	language: Language = 'en',
): string {
	const message = error instanceof LocalizedError
		? translate(language, error.key, error.values)
		: error instanceof Error
			? error.message
			: String(error);
	const redacted = apiKey.length === 0
		? message
		: message.replaceAll(apiKey, REDACTED_API_KEY);
	return redacted.length > MAX_VISIBLE_ERROR_LENGTH
		? `${redacted.slice(0, MAX_VISIBLE_ERROR_LENGTH)}…`
		: redacted;
}
