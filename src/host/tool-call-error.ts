import type { RecoverableToolError } from '../shared/rpc.ts';

/**
 * Classify a DSH tool failure that the agent can recover from by retrying with
 * fresh filesystem observations.
 *
 * @param code - Structured DSH error code from a `tool/result` event.
 * @returns The UI-facing recovery category, or undefined for other failures.
 */
export function recoverableToolError(code: unknown): RecoverableToolError | undefined {
	switch (code) {
		case 'FS_NOT_OBSERVED':
			return 'file-not-read';
		case 'FS_STALE_VERSION':
			return 'file-changed';
		default:
			return undefined;
	}
}
