/** Runtime targets published by `deepseek-harness-runtime-bin`. */
export const RUNTIME_TARGETS = Object.freeze([
	'linux-x64',
	'linux-arm64',
	'macos-arm64',
	'macos-x64',
	'win-x64',
]);

const HOST_TARGETS = Object.freeze({
	'darwin-arm64': 'macos-arm64',
	'darwin-x64': 'macos-x64',
	'linux-arm64': 'linux-arm64',
	'linux-x64': 'linux-x64',
	'win32-x64': 'win-x64',
});

/** VS Code's platform identifier for each runtime target. */
export const VSCODE_TARGETS = Object.freeze({
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
	'macos-arm64': 'darwin-arm64',
	'macos-x64': 'darwin-x64',
	'win-x64': 'win32-x64',
});

/**
 * @param {string} platform
 * @param {string} arch
 * @returns {string | undefined}
 */
export function hostRuntimeTarget(platform = process.platform, arch = process.arch) {
	return HOST_TARGETS[`${platform}-${arch}`];
}

/**
 * Resolve an explicit target or the current build host's supported target.
 *
 * @param {string | undefined} explicitTarget
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
export function resolveRuntimeTarget(
	explicitTarget = process.env.SEEKDOCK_RUNTIME_TARGET,
	platform = process.platform,
	arch = process.arch,
) {
	const target = explicitTarget ?? hostRuntimeTarget(platform, arch);
	if (target === undefined) {
		throw new Error(`No SeekDock runtime target is defined for ${platform}-${arch}.`);
	}
	if (!RUNTIME_TARGETS.includes(target)) {
		throw new Error(
			`Unknown SeekDock runtime target ${target}; expected one of ${RUNTIME_TARGETS.join(', ')}.`,
		);
	}
	return target;
}
