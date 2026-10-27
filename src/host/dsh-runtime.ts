import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface RuntimeTarget {
	executable: string;
	ripgrep: string;
	spawnHelper?: string;
}

interface RuntimeManifest {
	sdkVersion: string;
	runtimePackage: string;
	runtimeVersion: string;
	targets: Record<string, RuntimeTarget>;
}

export interface ResolvedDshRuntime {
	executablePath: string;
	target: string;
	version: string;
}

const HOST_TARGETS: Record<string, string> = {
	'darwin-arm64': 'macos-arm64',
	'darwin-x64': 'macos-x64',
	'linux-arm64': 'linux-arm64',
	'linux-x64': 'linux-x64',
	'win32-x64': 'win-x64',
};

/**
 * Resolve the Python SDK runtime executable bundled for the extension host.
 *
 * Platform-specific VSIX builds include one manifest target from the matching
 * official Python SDK wheel.
 *
 * @param extensionPath - Absolute extension installation directory.
 * @param platform - Node platform, injectable for tests.
 * @param arch - Node architecture, injectable for tests.
 * @returns the verified runtime executable and its selected target.
 */
export function resolveDshRuntime(
	extensionPath: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): ResolvedDshRuntime {
	const target = HOST_TARGETS[`${platform}-${arch}`];
	if (target === undefined) {
		throw new Error(`SeekDock does not support DeepSeek Harness on ${platform}-${arch}.`);
	}

	const manifestPath = join(extensionPath, 'resources', 'runtime', 'manifest.json');
	let manifest: RuntimeManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
	} catch (error) {
		throw new Error(`SeekDock could not read its runtime manifest at ${manifestPath}.`, { cause: error });
	}

	const files = manifest.targets[target];
	if (files === undefined) {
		throw new Error(`SeekDock runtime manifest has no ${target} target.`);
	}

	const runtimeDir = join(extensionPath, 'resources', 'runtime', target);
	const executablePath = join(runtimeDir, files.executable);
	verifyExecutable(executablePath);
	verifyExecutable(join(runtimeDir, files.ripgrep));
	if (files.spawnHelper !== undefined) {
		verifyExecutable(join(runtimeDir, files.spawnHelper));
	}

	return { executablePath, target, version: manifest.runtimeVersion };
}

function verifyExecutable(path: string): void {
	try {
		accessSync(path, constants.X_OK);
	} catch (error) {
		throw new Error(`SeekDock runtime file is missing or not executable: ${path}`, { cause: error });
	}
}
