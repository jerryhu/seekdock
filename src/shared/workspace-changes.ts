import {
	isNonEmptyString,
	isNonNegativeInteger,
	isPositiveInteger,
	isRecord,
} from './value-validation.ts';

/** One file changed during a completed or interrupted Agent turn. */
export interface WorkspaceChangedFile {
	/** Workspace-relative path, or an absolute path outside the workspace. */
	path: string;
	/** Path label supplied by DSH for presentation. */
	display: string;
	/** Lines added in this turn. */
	added: number;
	/** Lines deleted in this turn. */
	deleted: number;
	/** Present when DSH could not compare the file as text. */
	binary?: true;
	/** Present when a comparison side exceeded DSH's file-size bound. */
	oversized?: true;
}

/** File counts and paths summarized for one Agent turn. */
export interface WorkspaceChangesSummary {
	turn: number;
	files: readonly WorkspaceChangedFile[];
	total: number;
	added: number;
	deleted: number;
}

/** Live file changes announced by one Agent turn. */
export interface WorkspaceChangeSet extends WorkspaceChangesSummary {
	sessionId: string;
	/** Sequence number of the DSH workspace/changes event. */
	seq: number;
}

/** One contextual diff hunk with one-based line coordinates. */
export interface WorkspaceDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Hunk body lines, each prefixed with `+`, `-`, or a space. */
	lines: readonly string[];
}

/** One file comparison served by DSH while its Runtime session remains live. */
export type WorkspaceFileDiff =
	| {
		kind: 'text';
		path: string;
		display: string;
		before: boolean;
		after: boolean;
		hunks: readonly WorkspaceDiffHunk[];
		coarse: boolean;
	}
	| {
		kind: 'binary' | 'oversized';
		path: string;
		display: string;
	};

/** @returns whether `value` is one changed-file record from DSH. */
export function isWorkspaceChangedFile(value: unknown): value is WorkspaceChangedFile {
	if (!isRecord(value)) {
		return false;
	}
	return isNonEmptyString(value.path)
		&& isNonEmptyString(value.display)
		&& isNonNegativeInteger(value.added)
		&& isNonNegativeInteger(value.deleted)
		&& (value.binary === undefined || value.binary === true)
		&& (value.oversized === undefined || value.oversized === true);
}

/** @returns whether `value` is a complete live change set. */
export function isWorkspaceChangeSet(value: unknown): value is WorkspaceChangeSet {
	return isRecord(value)
		&& isNonEmptyString(value.sessionId)
		&& isNonNegativeInteger(value.seq)
		&& isWorkspaceChangesSummary(value);
}

/** @returns whether `value` is a validated per-turn changes summary. */
export function isWorkspaceChangesSummary(value: unknown): value is WorkspaceChangesSummary {
	if (!isRecord(value)) {
		return false;
	}
	return isPositiveInteger(value.turn)
		&& Array.isArray(value.files)
		&& value.files.every(isWorkspaceChangedFile)
		&& isNonNegativeInteger(value.total)
		&& value.total >= value.files.length
		&& isNonNegativeInteger(value.added)
		&& isNonNegativeInteger(value.deleted);
}

/** @returns whether `value` is one validated DSH diff hunk. */
export function isWorkspaceDiffHunk(value: unknown): value is WorkspaceDiffHunk {
	if (!isRecord(value)) {
		return false;
	}
	return isNonNegativeInteger(value.oldStart)
		&& isNonNegativeInteger(value.oldLines)
		&& isNonNegativeInteger(value.newStart)
		&& isNonNegativeInteger(value.newLines)
		&& Array.isArray(value.lines)
		&& value.lines.every(line => (
			typeof line === 'string'
			&& /^[+ -]/u.test(line)
		));
}

/** @returns whether `value` is one live text, binary, or oversized comparison. */
export function isWorkspaceFileDiff(value: unknown): value is WorkspaceFileDiff {
	if (!isRecord(value)
		|| !isNonEmptyString(value.path)
		|| !isNonEmptyString(value.display)) {
		return false;
	}
	if (value.kind === 'binary' || value.kind === 'oversized') {
		return true;
	}
	return value.kind === 'text'
		&& typeof value.before === 'boolean'
		&& typeof value.after === 'boolean'
		&& typeof value.coarse === 'boolean'
		&& Array.isArray(value.hunks)
		&& value.hunks.every(isWorkspaceDiffHunk);
}
