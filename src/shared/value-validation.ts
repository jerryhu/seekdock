/**
 * Primitive guards shared by the host/Webview boundary.
 *
 * Keeping these checks in one module prevents each RPC adapter from growing a
 * slightly different definition of a valid string or JSON object.
 */

/** @returns whether `value` is a plain JSON-style object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns whether `value` is a string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** @returns whether `value` is a safe integer greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** @returns whether `value` is a safe integer greater than or equal to zero. */
export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
