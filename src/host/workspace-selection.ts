import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import type { WorkspaceFolderRef } from '../shared/workspaces.ts';

/**
 * Canonicalize one directory path for identity comparisons.
 *
 * VS Code lowercases the drive letter of a `Uri.fsPath` on Windows while a
 * session header keeps whatever case produced it. Normalizing the drive keeps
 * the picker from listing the same folder twice; the rest of the path is left
 * untouched so tooltips show the user's spelling.
 *
 * @param path - absolute directory path.
 * @returns the resolved path with a normalized Windows drive letter.
 */
export function canonicalWorkspacePath(path: string): string {
	const resolved = resolve(path);
	return process.platform === 'win32'
		? resolved.replace(/^([a-z]):/u, (_, drive: string) => `${drive.toUpperCase()}:`)
		: resolved;
}

/**
 * Describe the open VS Code folders for the picker model.
 *
 * Paths are canonicalized so the host can compare them with session header
 * cwds without worrying about trailing separators or `..` segments.
 *
 * @returns the folders in VS Code order.
 */
export function workspaceFolderRefs(): readonly WorkspaceFolderRef[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
		id: folder.uri.toString(),
		name: folder.name,
		path: canonicalWorkspacePath(folder.uri.fsPath),
	}));
}

/**
 * @param left - first absolute path.
 * @param right - second absolute path.
 * @returns whether both paths address the same location after canonicalization.
 */
export function sameWorkspacePath(left: string, right: string): boolean {
	return canonicalWorkspacePath(left) === canonicalWorkspacePath(right);
}

/**
 * @param path - absolute path to inspect.
 * @returns whether the path currently resolves to a directory.
 */
export async function isExistingDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		// Missing or inaccessible is the caller's rejection case, not a host failure.
		return false;
	}
}
