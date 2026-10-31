import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Directory under the user's home that keeps SeekDock data across extension reinstalls. */
export const DATA_ROOT_DIRECTORY_NAME = '.seekdock';

/** Environment override for the data root; used by test hosts and debugging sessions. */
export const DATA_ROOT_ENV = 'SEEKDOCK_DATA_HOME';

/** Inputs needed to pick the data root. */
export interface ResolveDataRootOptions {
	/** Home directory holding the data root; defaults to `os.homedir()`. */
	homeDirectory?: string;
	/** Explicit data root, e.g. from `SEEKDOCK_DATA_HOME`. */
	overridePath?: string;
}

/**
 * Resolve and create the directory holding everything SeekDock must keep across reinstall.
 *
 * VS Code 1.144 removes `<user data>/User/globalStorage/<extension id>` when an
 * extension is uninstalled, which used to erase every session, so durable data
 * lives in the user's home directory instead of the extension storage.
 *
 * @param options - home directory and explicit override.
 * @returns the data root to use.
 * @throws when the directory cannot be created; the extension storage is not a
 * fallback because uninstalling the extension deletes it.
 */
export async function resolveDataRoot(options: ResolveDataRootOptions = {}): Promise<string> {
	const root = resolveRoot(options);
	try {
		// Session transcripts are sensitive, so the data root is private to the user.
		await mkdir(root, { recursive: true, mode: 0o700 });
	} catch (error) {
		throw new Error(`SeekDock: cannot create the data directory at ${root}`, { cause: error });
	}
	return root;
}

function resolveRoot(options: ResolveDataRootOptions): string {
	const override = options.overridePath?.trim();
	if (override !== undefined && override.length > 0) {
		return resolve(override);
	}
	return resolve(join(options.homeDirectory ?? homedir(), DATA_ROOT_DIRECTORY_NAME));
}
