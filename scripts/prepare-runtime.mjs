import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

export const RUNTIME_ROLES = ['executable', 'ripgrep', 'spawnHelper'];

const HOST_TARGETS = {
	'darwin-arm64': 'macos-arm64',
	'darwin-x64': 'macos-x64',
	'linux-arm64': 'linux-arm64',
	'linux-x64': 'linux-x64',
	'win32-x64': 'win-x64',
};
const PRESERVED_RUNTIME_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const STAGING_PREFIX = '.prepare-runtime-';

/**
 * @param {string} root
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadRuntimeManifest(root) {
	const manifestPath = join(root, 'resources', 'runtime', 'manifest.json');
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	} catch (error) {
		throw new Error(`Could not read runtime manifest at ${manifestPath}.`, { cause: error });
	}
	if (!isRecord(manifest)
		|| typeof manifest.sdkVersion !== 'string'
		|| typeof manifest.runtimeVersion !== 'string'
		|| !isRecord(manifest.release)
		|| typeof manifest.release.tag !== 'string'
		|| typeof manifest.release.assetBaseUrl !== 'string'
		|| !isRecord(manifest.targets)) {
		throw new Error(`Runtime manifest at ${manifestPath} has an invalid shape.`);
	}
	return manifest;
}

/**
 * @param {string} platform
 * @param {string} arch
 * @returns {string | undefined}
 */
export function hostRuntimeTarget(platform = process.platform, arch = process.arch) {
	return HOST_TARGETS[`${platform}-${arch}`];
}

/**
 * Download and atomically install a runtime target.
 *
 * @param {{
 *   root: string;
 *   target?: string;
 *   assetBaseUrl?: string;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<{ target: string; runtimeVersion: string; reused: boolean }>}
 */
export async function prepareRuntime(options) {
	const root = resolve(options.root);
	const target = options.target ?? hostRuntimeTarget();
	if (target === undefined) {
		throw new Error(`No SeekDock runtime target is defined for ${process.platform}-${process.arch}.`);
	}

	const manifest = await loadRuntimeManifest(root);
	const runtime = requireTarget(manifest, target);
	const runtimeRoot = join(root, 'resources', 'runtime');
	const targetDirectory = join(runtimeRoot, target);
	const assetBaseUrl = options.assetBaseUrl ?? manifest.release.assetBaseUrl;

	try {
		await verifyPreparedRuntime({ root, target });
		return {
			target,
			runtimeVersion: manifest.runtimeVersion,
			reused: true,
		};
	} catch {
		// A partial or stale checkout is replaced below after every artifact verifies.
	}

	const stagingDirectory = await mkdtemp(join(runtimeRoot, STAGING_PREFIX));
	try {
		await preserveRuntimeDocumentation(targetDirectory, stagingDirectory);
		for (const role of RUNTIME_ROLES) {
			const artifact = runtime.artifacts[role];
			if (artifact === undefined) {
				continue;
			}
			const outputPath = join(stagingDirectory, runtime[role]);
			const assetUrl = new URL(artifact.asset, ensureTrailingSlash(assetBaseUrl));
			await downloadArtifact(assetUrl, outputPath, artifact, options.fetchImpl ?? fetch);
			await chmod(outputPath, 0o755);
		}

		await verifyArtifacts(manifest, target, stagingDirectory);
		await replaceRuntimeDirectory(targetDirectory, stagingDirectory);
		return {
			target,
			runtimeVersion: manifest.runtimeVersion,
			reused: false,
		};
	} finally {
		await rm(stagingDirectory, { recursive: true, force: true });
	}
}

/**
 * @param {{ root: string; target?: string }} options
 * @returns {Promise<{ target: string; runtimeVersion: string; executablePath: string }>}
 */
export async function verifyPreparedRuntime(options) {
	const root = resolve(options.root);
	const target = options.target ?? hostRuntimeTarget();
	if (target === undefined) {
		throw new Error(`No SeekDock runtime target is defined for ${process.platform}-${process.arch}.`);
	}
	const manifest = await loadRuntimeManifest(root);
	const runtime = requireTarget(manifest, target);
	const targetDirectory = join(root, 'resources', 'runtime', target);
	await verifyArtifacts(manifest, target, targetDirectory);
	for (const filename of PRESERVED_RUNTIME_FILES) {
		await access(join(targetDirectory, filename), constants.R_OK);
	}
	return {
		target,
		runtimeVersion: manifest.runtimeVersion,
		executablePath: join(targetDirectory, runtime.executable),
	};
}

function requireTarget(manifest, target) {
	const runtime = manifest.targets[target];
	if (!isRecord(runtime)) {
		throw new Error(`Runtime manifest has no ${target} target.`);
	}
	for (const role of ['executable', 'ripgrep']) {
		requireRelativeFilename(runtime[role], `${target}.${role}`);
	}
	if (runtime.spawnHelper !== undefined) {
		requireRelativeFilename(runtime.spawnHelper, `${target}.spawnHelper`);
	}
	if (!isRecord(runtime.artifacts)) {
		throw new Error(`Runtime manifest target ${target} has no downloadable artifacts.`);
	}
	for (const role of RUNTIME_ROLES) {
		const artifact = runtime.artifacts[role];
		if (role === 'spawnHelper' && runtime.spawnHelper === undefined) {
			continue;
		}
		if (!isRecord(artifact)
			|| typeof artifact.asset !== 'string'
			|| basename(artifact.asset) !== artifact.asset
			|| typeof artifact.size !== 'number'
			|| !Number.isSafeInteger(artifact.size)
			|| artifact.size <= 0
			|| typeof artifact.sha256 !== 'string'
			|| !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
			throw new Error(`Runtime manifest target ${target} has invalid ${role} metadata.`);
		}
	}
	return runtime;
}

function requireRelativeFilename(value, label) {
	if (typeof value !== 'string' || value.length === 0 || basename(value) !== value) {
		throw new Error(`Runtime manifest has an invalid filename for ${label}.`);
	}
}

async function verifyArtifacts(manifest, target, directory) {
	const runtime = requireTarget(manifest, target);
	for (const role of RUNTIME_ROLES) {
		const artifact = runtime.artifacts[role];
		if (artifact === undefined) {
			continue;
		}
		const filePath = join(directory, runtime[role]);
		let fileStat;
		try {
			fileStat = await stat(filePath);
		} catch (error) {
			throw new Error(`Runtime file is missing: ${filePath}.`, { cause: error });
		}
		if (!fileStat.isFile() || fileStat.size !== artifact.size) {
			throw new Error(
				`Runtime file ${filePath} has size ${fileStat.size}, expected ${artifact.size}.`,
			);
		}
		try {
			await access(filePath, constants.X_OK);
		} catch (error) {
			throw new Error(`Runtime file is not executable: ${filePath}.`, { cause: error });
		}
		const actualHash = await hashFile(filePath);
		if (actualHash !== artifact.sha256) {
			throw new Error(
				`Runtime file ${filePath} has SHA-256 ${actualHash}, expected ${artifact.sha256}.`,
			);
		}
	}
}

async function preserveRuntimeDocumentation(targetDirectory, stagingDirectory) {
	for (const filename of PRESERVED_RUNTIME_FILES) {
		await copyFile(join(targetDirectory, filename), join(stagingDirectory, filename));
	}
}

async function downloadArtifact(assetUrl, outputPath, artifact, fetchImpl) {
	let source;
	if (assetUrl.protocol === 'file:') {
		source = createReadStream(fileURLToPath(assetUrl));
	} else {
		let response;
		try {
			response = await fetchImpl(assetUrl);
		} catch (error) {
			throw new Error(`Could not download runtime asset ${assetUrl.href}.`, { cause: error });
		}
		if (!response.ok) {
			throw new Error(
				`Could not download runtime asset ${assetUrl.href}: HTTP ${response.status} ${response.statusText}.`,
			);
		}
		if (response.body === null) {
			throw new Error(`Runtime asset ${assetUrl.href} returned an empty response body.`);
		}
		source = Readable.fromWeb(response.body);
	}

	const digest = createHash('sha256');
	let size = 0;
	const measure = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.length;
			digest.update(chunk);
			callback(null, chunk);
		},
	});
	try {
		await pipeline(source, createGunzip(), measure, createWriteStream(outputPath));
	} catch (error) {
		throw new Error(`Could not unpack runtime asset ${assetUrl.href}.`, { cause: error });
	}
	const actualHash = digest.digest('hex');
	if (size !== artifact.size || actualHash !== artifact.sha256) {
		throw new Error(
			`Runtime asset ${assetUrl.href} produced ${size} bytes with SHA-256 ${actualHash}; `
			+ `expected ${artifact.size} bytes with SHA-256 ${artifact.sha256}.`,
		);
	}
}

async function replaceRuntimeDirectory(targetDirectory, stagingDirectory) {
	const backupDirectory = join(
		resolve(targetDirectory, '..'),
		`${STAGING_PREFIX}backup-${randomUUID()}`,
	);
	let movedExistingDirectory = false;
	try {
		try {
			await rename(targetDirectory, backupDirectory);
			movedExistingDirectory = true;
		} catch (error) {
			if (!isMissingFileError(error)) {
				throw error;
			}
		}
		await rename(stagingDirectory, targetDirectory);
		if (movedExistingDirectory) {
			await rm(backupDirectory, { recursive: true, force: true });
		}
	} catch (error) {
		if (movedExistingDirectory) {
			try {
				await rename(backupDirectory, targetDirectory);
			} catch (restoreError) {
				throw new Error(
					`Could not publish the runtime and could not restore ${targetDirectory}.`,
					{ cause: restoreError },
				);
			}
		}
		throw error;
	}
}

async function hashFile(filePath) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		digest.update(chunk);
	}
	return digest.digest('hex');
}

function ensureTrailingSlash(value) {
	return value.endsWith('/') ? value : `${value}/`;
}

function isMissingFileError(error) {
	return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
	const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
	const target = process.argv[2] ?? hostRuntimeTarget();
	const manifest = await loadRuntimeManifest(root);
	const assetBaseUrl = process.env.SEEKDOCK_RUNTIME_ASSET_DIR === undefined
		? process.env.SEEKDOCK_RUNTIME_ASSET_BASE_URL ?? manifest.release.assetBaseUrl
		: ensureTrailingSlash(pathToFileURL(resolve(process.env.SEEKDOCK_RUNTIME_ASSET_DIR)).href);
	const result = await prepareRuntime({ root, target, assetBaseUrl });
	console.log(
		`${result.reused ? 'Verified' : 'Prepared'} DeepSeek Harness ${result.target} `
		+ `runtime ${result.runtimeVersion}.`,
	);
}

if (process.argv[1] !== undefined
	&& import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
