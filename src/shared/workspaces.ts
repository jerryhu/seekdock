import {
	isNonEmptyString,
	isRecord,
} from './value-validation.ts';

/** Picker id for the fallback directory used when VS Code has no folder open. */
export const DEFAULT_WORKSPACE_ID = 'seekdock-default';

/** Where one selectable working directory comes from. */
export type WorkspaceOptionKind = 'folder' | 'default' | 'custom';

/** The subset of a VS Code workspace folder the picker model needs. */
export interface WorkspaceFolderRef {
	/** Stable identity, normally `folder.uri.toString()`. */
	id: string;
	/** Display name, which may be customized by a `.code-workspace` file. */
	name: string;
	/** Absolute directory path. */
	path: string;
}

/** One selectable working directory in the composer. */
export interface WorkspaceOption {
	id: string;
	name: string;
	/** Absolute host path, shown as the native hover tooltip. */
	path: string;
	kind: WorkspaceOptionKind;
}

/** Complete working-directory picker model shared with the chat Webview. */
export interface WorkspaceSelectionState {
	options: readonly WorkspaceOption[];
	currentId: string;
	/** Option the host is applying while the runtime restarts. */
	pendingId?: string;
	error?: string;
}

/**
 * @param path - absolute directory that is not one of the VS Code folders.
 * @returns the stable id used for its synthetic picker option.
 */
export function customWorkspaceId(path: string): string {
	return `custom:${path}`;
}

/**
 * Build the picker model from the VS Code folders and the directory the
 * runtime currently uses.
 *
 * @param folders - workspace folders in VS Code order; empty when none is open.
 * @param currentPath - absolute directory the runtime will use for new sessions.
 * @param defaultPath - fallback directory used when no folder is open.
 * @returns the ordered options, including a synthetic entry for a current
 * directory outside the folder list (for example, a resumed session's cwd).
 */
export function buildWorkspaceOptions(
	folders: readonly WorkspaceFolderRef[],
	currentPath: string,
	defaultPath: string,
): readonly WorkspaceOption[] {
	const options: WorkspaceOption[] = folders.length === 0
		? [{
			id: DEFAULT_WORKSPACE_ID,
			name: lastPathSegment(defaultPath),
			path: defaultPath,
			kind: 'default',
		}]
		: folders.map(folder => ({
			id: folder.id,
			name: folder.name,
			path: folder.path,
			kind: 'folder',
		}));
	if (options.some(option => option.path === currentPath)) {
		return options;
	}
	return [
		...options,
		{
			id: customWorkspaceId(currentPath),
			name: lastPathSegment(currentPath),
			path: currentPath,
			kind: 'custom',
		},
	];
}

/**
 * @param value - candidate option from the Webview boundary.
 * @returns whether `value` is one complete picker option.
 */
export function isWorkspaceOption(value: unknown): value is WorkspaceOption {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.id)
		&& isNonEmptyString(value.name)
		&& isNonEmptyString(value.path)
		&& (value.kind === 'folder' || value.kind === 'default' || value.kind === 'custom');
}

/**
 * @param value - candidate host message payload.
 * @returns whether the options, current id, pending id, and error form a
 * coherent selector state.
 */
export function isWorkspaceSelectionState(
	value: unknown,
): value is WorkspaceSelectionState {
	if (!isRecord(value)
		|| !Array.isArray(value.options)
		|| value.options.length === 0
		|| !value.options.every(isWorkspaceOption)
		|| !isNonEmptyString(value.currentId)
		|| !value.options.some(option => option.id === value.currentId)) {
		return false;
	}
	if (value.pendingId !== undefined && !isNonEmptyString(value.pendingId)) {
		return false;
	}
	return value.error === undefined || typeof value.error === 'string';
}

/**
 * Read the final path segment without importing Node's path module, so this
 * helper stays usable from both the extension host and the Webview.
 *
 * @param path - absolute path using either separator.
 * @returns the final segment, or the path itself when no segment remains.
 */
function lastPathSegment(path: string): string {
	const trimmed = path.replace(/[\\/]+$/u, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	const segment = index >= 0 ? trimmed.slice(index + 1) : trimmed;
	return segment.length > 0 ? segment : path;
}
