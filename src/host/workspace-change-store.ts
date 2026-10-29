import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	isWorkspaceChangeSet,
	isWorkspaceFileDiff,
	type WorkspaceChangeSet,
	type WorkspaceFileDiff,
} from '../shared/workspace-changes.ts';
import { assertSafeSessionId } from './session-history.ts';

/** Total comparison bytes retained for one turn; beyond it the history card keeps working without previews. */
const CAPTURE_BUDGET_BYTES = 16 * 1024 * 1024;
/** One comparison above this size is only stored when the user asks for it. */
const CAPTURE_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

/** Reads one file comparison from DSH while its Runtime Session is still live. */
export type WorkspaceDiffReader = (index: number) => Promise<WorkspaceFileDiff | undefined>;

/**
 * Extension-owned copy of the changed-file cards DSH only serves while its
 * Runtime Session is live. Persisting each turn's summary and comparisons keeps
 * the card in a reopened conversation and lets its diff editor open again.
 *
 * The layout is private to this extension: `<root>/<sessionId>/<seq>/` holds
 * `changes.json` and one `<index>.json` per captured comparison.
 */
export class WorkspaceChangeStore {
	private readonly captures = new Map<string, Promise<void>>();

	constructor(private readonly rootDirectory: string) { }

	/**
	 * Persist one turn's changed-file summary so history replay can show it.
	 *
	 * @param changes - validated live change set announced by DSH.
	 */
	async saveChanges(changes: WorkspaceChangeSet): Promise<void> {
		assertUsableChangeSet(changes);
		await this.writeJson(this.changesPath(changes.sessionId, changes.seq), changes);
	}

	/**
	 * Persist one file comparison announced by a live turn.
	 *
	 * @param sessionId - session that owns the turn.
	 * @param seq - `workspace/changes` event sequence.
	 * @param index - the file's index in the summary.
	 * @param diff - validated comparison from DSH.
	 */
	async saveDiff(
		sessionId: string,
		seq: number,
		index: number,
		diff: WorkspaceFileDiff,
	): Promise<void> {
		assertSafeSessionId(sessionId);
		assertNonNegativeInteger(seq, 'sequence');
		assertNonNegativeInteger(index, 'file index');
		if (!isWorkspaceFileDiff(diff)) {
			throw new Error('SeekDock: refusing to persist an invalid workspace file diff.');
		}
		await this.writeJson(this.diffPath(sessionId, seq, index), diff);
	}

	/**
	 * Load every stored summary of one session, keyed by event sequence.
	 *
	 * @param sessionId - session selected from history.
	 * @returns summaries usable for transcript replay; empty when none were stored.
	 */
	async readSession(sessionId: string): Promise<ReadonlyMap<number, WorkspaceChangeSet>> {
		assertSafeSessionId(sessionId);
		const changes = new Map<number, WorkspaceChangeSet>();
		let entries;
		try {
			entries = await readdir(this.sessionPath(sessionId), { withFileTypes: true });
		} catch (error) {
			if (!isMissingPath(error)) {
				console.warn(`SeekDock: failed to read cached workspace changes for ${sessionId}`, error);
			}
			return changes;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
				continue;
			}
			const seq = Number(entry.name);
			const stored = await this.readJson(this.changesPath(sessionId, seq));
			if (stored === undefined) {
				continue;
			}
			if (!isWorkspaceChangeSet(stored)
				|| stored.sessionId !== sessionId
				|| stored.seq !== seq) {
				console.warn(`SeekDock: ignoring a malformed workspace change record for ${sessionId}/${seq}.`);
				continue;
			}
			changes.set(seq, stored);
		}
		return changes;
	}

	/**
	 * Read one previously stored comparison.
	 *
	 * @param sessionId - session that owns the turn.
	 * @param seq - `workspace/changes` event sequence.
	 * @param index - the file's index in the summary.
	 * @returns the comparison, or undefined when this turn never stored it.
	 */
	async readDiff(
		sessionId: string,
		seq: number,
		index: number,
	): Promise<WorkspaceFileDiff | undefined> {
		assertSafeSessionId(sessionId);
		if (!isNonNegativeIntegerValue(seq) || !isNonNegativeIntegerValue(index)) {
			return undefined;
		}
		const stored = await this.readJson(this.diffPath(sessionId, seq, index));
		return isWorkspaceFileDiff(stored) ? stored : undefined;
	}

	/**
	 * Persist one turn and capture its comparisons in the background, so the
	 * reopened conversation can still open them after DSH drops the live record.
	 *
	 * @param changes - validated live change set announced by DSH.
	 * @param readDiff - reads one comparison from the live Runtime Session.
	 */
	async record(changes: WorkspaceChangeSet, readDiff: WorkspaceDiffReader): Promise<void> {
		await this.saveChanges(changes);
		const key = `${changes.sessionId}/${changes.seq}`;
		if (this.captures.has(key)) {
			return;
		}
		const capture = this.capture(changes, readDiff)
			.catch((error: unknown) => {
				console.warn('SeekDock: failed to capture workspace file diffs', error);
			})
			.finally(() => {
				this.captures.delete(key);
			});
		this.captures.set(key, capture);
	}

	/**
	 * Remove every stored record of one deleted session.
	 *
	 * @param sessionId - session being deleted from DSH's store.
	 */
	async removeSession(sessionId: string): Promise<void> {
		assertSafeSessionId(sessionId);
		// Let in-flight captures finish first, so none recreates the directory
		// after deletion.
		const prefix = `${sessionId}/`;
		await Promise.allSettled(
			[...this.captures]
				.filter(([key]) => key.startsWith(prefix))
				.map(([, capture]) => capture),
		);
		await rm(this.sessionPath(sessionId), { recursive: true, force: true });
	}

	/** Wait for the comparisons still being captured from the live Runtime Session. */
	async dispose(): Promise<void> {
		await Promise.allSettled([...this.captures.values()]);
	}

	private async capture(
		changes: WorkspaceChangeSet,
		readDiff: WorkspaceDiffReader,
	): Promise<void> {
		let budget = CAPTURE_BUDGET_BYTES;
		for (const [index] of changes.files.entries()) {
			if (budget <= 0) {
				return;
			}
			let diff: WorkspaceFileDiff | undefined;
			try {
				diff = await readDiff(index);
			} catch (error) {
				console.warn(`SeekDock: failed to read a workspace diff for ${changes.sessionId}/${changes.seq}/${index}`, error);
				continue;
			}
			if (diff === undefined) {
				continue;
			}
			const size = JSON.stringify(diff).length;
			if (size > CAPTURE_FILE_LIMIT_BYTES) {
				continue;
			}
			await this.saveDiff(changes.sessionId, changes.seq, index, diff);
			budget -= size;
		}
	}

	private sessionPath(sessionId: string): string {
		return join(this.rootDirectory, sessionId);
	}

	private changesPath(sessionId: string, seq: number): string {
		return join(this.sessionPath(sessionId), String(seq), 'changes.json');
	}

	private diffPath(sessionId: string, seq: number, index: number): string {
		return join(this.sessionPath(sessionId), String(seq), `${index}.json`);
	}

	private async readJson(path: string): Promise<unknown> {
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch (error) {
			// The cache is auxiliary: an unreadable record must not fail the
			// session load or diff request it was meant to enrich.
			if (!isMissingPath(error)) {
				console.warn(`SeekDock: failed to read workspace change data at ${path}`, error);
			}
			return undefined;
		}
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			console.warn(`SeekDock: ignoring unreadable workspace change data at ${path}`, error);
			return undefined;
		}
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(value), 'utf8');
	}
}

function assertUsableChangeSet(changes: WorkspaceChangeSet): void {
	assertSafeSessionId(changes.sessionId);
	assertNonNegativeInteger(changes.seq, 'sequence');
	if (!isWorkspaceChangeSet(changes)) {
		throw new Error('SeekDock: refusing to persist an invalid workspace change summary.');
	}
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!isNonNegativeIntegerValue(value)) {
		throw new Error(`SeekDock: ${label} must be a non-negative integer.`);
	}
}

function isNonNegativeIntegerValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
