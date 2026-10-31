import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Directory under the user's home that keeps SeekDock data across extension reinstalls. */
export const DATA_ROOT_DIRECTORY_NAME = '.seekdock';

/** Environment override for the data root; used by test hosts and debugging sessions. */
export const DATA_ROOT_ENV = 'SEEKDOCK_DATA_HOME';

/** Marker recording that the extension storage directory was migrated into the data root. */
const LAYOUT_MARKER_FILE = '.layout.json';

/** Layout version of the data root; bump when its own on-disk layout changes. */
const LAYOUT_VERSION = 2;

/**
 * Entries skipped when migration has to copy instead of rename: the runtime's
 * HOME override only holds reinstallable caches, so carrying it across devices
 * would move tens of megabytes for nothing.
 */
const CACHE_ENTRIES: ReadonlySet<string> = new Set(['runtime-home']);

/** File operations the migration needs; injectable so tests can force failure paths. */
export interface DataRootFileOps {
	/** Moves one directory entry; the extension storage and the home directory usually share a volume. */
	move(from: string, to: string): Promise<void>;
	/** Copies one directory entry recursively; only used when a move crosses a device boundary. */
	copy(from: string, to: string): Promise<void>;
	/** Removes one path recursively. */
	remove(path: string): Promise<void>;
}

/**
 * Adopts the previous layout on activation. Flip to `false` to retire the
 * migration in a later release; new data always lands in the data root.
 */
export const MIGRATE_LEGACY_DATA: boolean = true;

/** Inputs needed to pick the data root and migrate the previous layout into it. */
export interface ResolveDataRootOptions {
	/** `ExtensionContext.globalStorageUri.fsPath`, the location older builds used. */
	legacyRoot: string;
	/** Home directory holding the data root; defaults to `os.homedir()`. */
	homeDirectory?: string;
	/** Explicit data root, e.g. from `SEEKDOCK_DATA_HOME`. */
	overridePath?: string;
	/** Overrides {@link MIGRATE_LEGACY_DATA}; tests use it to cover both branches. */
	migrate?: boolean;
	/** Injectable file operations, for tests. */
	fileOps?: Partial<DataRootFileOps>;
}

/** Data root the extension should use for this session. */
export interface ResolvedDataRoot {
	root: string;
	/** Previous location when this call actually migrated data. */
	migratedFrom?: string;
}

/**
 * Resolve the directory holding everything SeekDock must keep across reinstall.
 *
 * VS Code 1.144 removes `<user data>/User/globalStorage/<extension id>` when an
 * extension is uninstalled, which used to erase every session, so durable data
 * lives in the user's home directory instead of the extension storage.
 *
 * @param options - legacy location, home directory, override, migration switch, and test hooks.
 * @returns the data root to use and, when data was moved, the previous location.
 */
export async function resolveDataRoot(options: ResolveDataRootOptions): Promise<ResolvedDataRoot> {
	const root = resolveRoot(options);
	const legacyRoot = resolve(options.legacyRoot);
	if (root === legacyRoot) {
		return { root };
	}

	try {
		// Session transcripts are sensitive, so the data root is private to the user.
		await mkdir(root, { recursive: true, mode: 0o700 });
	} catch (error) {
		console.warn('SeekDock: cannot create the data directory, keeping the extension storage location', error);
		return { root: legacyRoot };
	}

	if (await isPresent(join(root, LAYOUT_MARKER_FILE))) {
		return { root };
	}

	if (!(options.migrate ?? MIGRATE_LEGACY_DATA)) {
		// The switch only gates adopting the old data: new data still lands in the
		// data root, so turning it off never moves the store back into the
		// extension storage.
		return { root };
	}

	try {
		return await adoptDataRoot(legacyRoot, root, options);
	} catch (error) {
		console.warn('SeekDock: cannot inspect the data directories, keeping the extension storage location', error);
		return { root: legacyRoot };
	}
}

async function adoptDataRoot(
	legacyRoot: string,
	root: string,
	options: ResolveDataRootOptions,
): Promise<ResolvedDataRoot> {
	const legacyEntries = await entriesOf(legacyRoot);
	if (legacyEntries.length === 0) {
		return { root };
	}

	if ((await entriesOf(root)).length > 0) {
		// A previous run already moved the data but could not record it, or the
		// directory predates the marker. Never merge two stores into one.
		await recordLayout(root).catch(error => {
			console.warn('SeekDock: cannot record the data directory layout', error);
		});
		return { root };
	}

	const ops = fileOps(options.fileOps);
	if (!await migrateEntries(legacyRoot, root, legacyEntries, ops)) {
		// A second window may have finished the migration while this one failed.
		return await isPresent(join(root, 'dsh-home'))
			? { root }
			: { root: legacyRoot };
	}

	await recordLayout(root, legacyRoot).catch(error => {
		console.warn('SeekDock: cannot record the data directory layout', error);
	});
	await removeLegacyRemnants(legacyRoot, ops);
	return { root, migratedFrom: legacyRoot };
}

function resolveRoot(options: ResolveDataRootOptions): string {
	const override = options.overridePath?.trim();
	if (override !== undefined && override.length > 0) {
		return resolve(override);
	}
	return resolve(join(options.homeDirectory ?? homedir(), DATA_ROOT_DIRECTORY_NAME));
}

async function migrateEntries(
	legacyRoot: string,
	root: string,
	names: readonly string[],
	ops: DataRootFileOps,
): Promise<boolean> {
	const moved = await moveEntries(legacyRoot, root, names, ops);
	if (moved.done) {
		return true;
	}
	await moveBack(root, legacyRoot, moved.names, ops);
	if (!isCrossDeviceError(moved.error)) {
		console.warn('SeekDock: failed to migrate the extension data directory, keeping the old location', moved.error);
		return false;
	}
	// Distinct volumes: copying is the only way to keep the previous store intact
	// until every entry arrived at its new home.
	return copyEntries(legacyRoot, root, names, ops);
}

async function moveEntries(
	legacyRoot: string,
	root: string,
	names: readonly string[],
	ops: DataRootFileOps,
): Promise<{ done: true } | { done: false; names: readonly string[]; error: unknown }> {
	const moved: string[] = [];
	for (const name of names) {
		if (CACHE_ENTRIES.has(name)) {
			continue;
		}
		try {
			await ops.move(join(legacyRoot, name), join(root, name));
			moved.push(name);
		} catch (error) {
			return { done: false, names: moved, error };
		}
	}
	return { done: true };
}

async function copyEntries(
	legacyRoot: string,
	root: string,
	names: readonly string[],
	ops: DataRootFileOps,
): Promise<boolean> {
	const copied: string[] = [];
	try {
		for (const name of names) {
			if (CACHE_ENTRIES.has(name)) {
				continue;
			}
			// Record the attempt first so a half-copied entry is discarded too.
			copied.push(name);
			await ops.copy(join(legacyRoot, name), join(root, name));
		}
	} catch (error) {
		await discardCopies(root, copied, ops);
		console.warn('SeekDock: failed to copy the extension data directory, keeping the old location', error);
		return false;
	}

	// The copies are complete, so the sources can go; leftovers only cost disk.
	for (const name of copied) {
		await ops.remove(join(legacyRoot, name)).catch((error: unknown) => {
			console.warn(`SeekDock: could not remove the migrated "${name}" from the old location`, error);
		});
	}
	return true;
}

/**
 * Return already-moved entries so a failed migration leaves exactly one usable
 * store behind.
 */
async function moveBack(
	root: string,
	legacyRoot: string,
	names: readonly string[],
	ops: DataRootFileOps,
): Promise<void> {
	for (const name of [...names].reverse()) {
		await ops.move(join(root, name), join(legacyRoot, name)).catch((error: unknown) => {
			console.warn(`SeekDock: could not roll back the migrated "${name}"`, error);
		});
	}
}

async function discardCopies(
	root: string,
	names: readonly string[],
	ops: DataRootFileOps,
): Promise<void> {
	for (const name of [...names].reverse()) {
		await ops.remove(join(root, name)).catch((error: unknown) => {
			console.warn(`SeekDock: could not discard the copied "${name}"`, error);
		});
	}
}

/**
 * Drop the previous location once it holds nothing but the skipped caches; the
 * runtime recreates both under the data root on its next start.
 */
async function removeLegacyRemnants(legacyRoot: string, ops: DataRootFileOps): Promise<void> {
	const remaining = await entriesOf(legacyRoot);
	if (remaining.some(name => !CACHE_ENTRIES.has(name))) {
		return;
	}
	await ops.remove(legacyRoot).catch((error: unknown) => {
		console.warn('SeekDock: could not remove the previous extension storage directory', error);
	});
}

async function recordLayout(root: string, migratedFrom?: string): Promise<void> {
	const marker = {
		layout: LAYOUT_VERSION,
		...(migratedFrom === undefined ? {} : { migratedFrom }),
		migratedAt: new Date().toISOString(),
	};
	await writeFile(join(root, LAYOUT_MARKER_FILE), `${JSON.stringify(marker, null, '\t')}\n`, 'utf8');
}

async function entriesOf(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function isPresent(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function isCrossDeviceError(error: unknown): boolean {
	return errorCode(error) === 'EXDEV';
}

function fileOps(overrides: Partial<DataRootFileOps> | undefined): DataRootFileOps {
	return {
		move: overrides?.move ?? (async (from, to) => { await rename(from, to); }),
		copy: overrides?.copy ?? (async (from, to) => { await cp(from, to, { recursive: true }); }),
		remove: overrides?.remove ?? (async path => { await rm(path, { recursive: true, force: true }); }),
	};
}
