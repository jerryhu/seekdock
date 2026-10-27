import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import {
	hostRuntimeTarget,
	resolveRuntimeTarget,
} from './runtime-targets.mjs';

export const RUNTIME_ROLES = ['executable', 'ripgrep', 'spawnHelper'];

const RUNTIME_DOCUMENT_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const STAGING_PREFIX = '.prepare-runtime-';
const WHEEL_RUNTIME_DIRECTORY = 'deepseek_harness_runtime/runtime/';

export { hostRuntimeTarget };

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
		|| manifest.schemaVersion !== 2
		|| typeof manifest.runtimeVersion !== 'string'
		|| !isRecord(manifest.targets)) {
		throw new Error(`Runtime manifest at ${manifestPath} has an invalid shape.`);
	}
	return manifest;
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
	const target = resolveRuntimeTarget(options.target);

	const manifest = await loadRuntimeManifest(root);
	const runtime = requireTarget(manifest, target);
	const runtimeRoot = join(root, 'resources', 'runtime');
	const targetDirectory = join(runtimeRoot, target);

	try {
		await verifyPreparedRuntime({ root, target });
		await removeCachedWheel(targetDirectory, runtime);
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
		const wheelUrl = options.assetBaseUrl === undefined
			? new URL(runtime.wheel.url)
			: new URL(runtime.wheel.filename, ensureTrailingSlash(options.assetBaseUrl));
		const wheelPath = join(stagingDirectory, runtime.wheel.filename);
		await downloadFile(wheelUrl, wheelPath, runtime.wheel, options.fetchImpl ?? fetch);
		await extractWheel(wheelPath, stagingDirectory, runtime);
		await rm(wheelPath, { force: true });

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
	const target = resolveRuntimeTarget(options.target);
	const manifest = await loadRuntimeManifest(root);
	const runtime = requireTarget(manifest, target);
	const targetDirectory = join(root, 'resources', 'runtime', target);
	await verifyArtifacts(manifest, target, targetDirectory);
	for (const filename of RUNTIME_DOCUMENT_FILES) {
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
	if (!isRecord(runtime.wheel)
		|| typeof runtime.wheel.filename !== 'string'
		|| basename(runtime.wheel.filename) !== runtime.wheel.filename
		|| typeof runtime.wheel.url !== 'string'
		|| !isSupportedWheelUrl(runtime.wheel.url)
		|| typeof runtime.wheel.size !== 'number'
		|| !Number.isSafeInteger(runtime.wheel.size)
		|| runtime.wheel.size <= 0
		|| typeof runtime.wheel.sha256 !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(runtime.wheel.sha256)) {
		throw new Error(`Runtime manifest target ${target} has invalid wheel metadata.`);
	}
	if (!isRecord(runtime.artifacts)) {
		throw new Error(`Runtime manifest target ${target} has no artifact metadata.`);
	}
	for (const role of RUNTIME_ROLES) {
		const artifact = runtime.artifacts[role];
		if (role === 'spawnHelper' && runtime.spawnHelper === undefined) {
			continue;
		}
		if (!isRecord(artifact)
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

async function downloadFile(assetUrl, outputPath, expected, fetchImpl) {
	let source;
	if (assetUrl.protocol === 'file:') {
		source = createReadStream(fileURLToPath(assetUrl));
	} else {
		let response;
		try {
			response = await fetchImpl(assetUrl);
		} catch (error) {
			throw new Error(`Could not download runtime wheel ${assetUrl.href}.`, { cause: error });
		}
		if (!response.ok) {
			throw new Error(
				`Could not download runtime wheel ${assetUrl.href}: HTTP ${response.status} ${response.statusText}.`,
			);
		}
		if (response.body === null) {
			throw new Error(`Runtime wheel ${assetUrl.href} returned an empty response body.`);
		}
		source = Readable.fromWeb(response.body);
	}

	try {
		await pipeline(source, createWriteStream(outputPath));
	} catch (error) {
		throw new Error(`Could not download runtime wheel ${assetUrl.href}.`, { cause: error });
	}
	const fileStat = await stat(outputPath);
	const actualHash = await hashFile(outputPath);
	if (fileStat.size !== expected.size || actualHash !== expected.sha256) {
		throw new Error(
			`Runtime wheel ${assetUrl.href} has ${fileStat.size} bytes with SHA-256 ${actualHash}; `
			+ `expected ${expected.size} bytes with SHA-256 ${expected.sha256}.`,
		);
	}
}

async function extractWheel(wheelPath, destination, runtime) {
	const wantedEntries = new Set(
		RUNTIME_ROLES
			.filter(role => runtime[role] !== undefined)
			.map(role => `${WHEEL_RUNTIME_DIRECTORY}${runtime[role]}`),
	);
	let entries;
	try {
		entries = unzipSync(await readFile(wheelPath), {
			filter: file => wantedEntries.has(file.name)
				|| RUNTIME_DOCUMENT_FILES.some(filename => file.name.endsWith(
					`.dist-info/licenses/${filename}`,
				)),
		});
	} catch (error) {
		throw new Error(`Could not unpack runtime wheel ${wheelPath}.`, { cause: error });
	}

	for (const role of RUNTIME_ROLES) {
		const filename = runtime[role];
		if (filename === undefined) {
			continue;
		}
		const contents = findZipEntry(
			entries,
			name => name === `${WHEEL_RUNTIME_DIRECTORY}${filename}`,
		);
		if (contents === undefined) {
			throw new Error(`Runtime wheel ${wheelPath} does not contain ${filename}.`);
		}
		const outputPath = join(destination, filename);
		await writeFile(outputPath, contents);
		await chmod(outputPath, 0o755);
	}
	for (const filename of RUNTIME_DOCUMENT_FILES) {
		const contents = findZipEntry(
			entries,
			name => name.endsWith(`.dist-info/licenses/${filename}`),
		);
		if (contents === undefined) {
			throw new Error(`Runtime wheel ${wheelPath} does not contain ${filename}.`);
		}
		await writeFile(join(destination, filename), contents);
	}
}

function findZipEntry(entries, predicate) {
	for (const [name, value] of Object.entries(entries)) {
		if (typeof value === 'object' && !(value instanceof Uint8Array)) {
			const nested = findZipEntry(value, predicate);
			if (nested !== undefined) {
				return nested;
			}
		} else if (value instanceof Uint8Array && predicate(name)) {
			return value;
		}
	}
	return undefined;
}

/**
 * Remove other targets' generated binaries before packaging a platform VSIX.
 *
 * @param {string} root
 * @param {string} keepTarget
 */
export async function pruneOtherRuntimeTargets(root, keepTarget) {
	const manifest = await loadRuntimeManifest(root);
	for (const [target, value] of Object.entries(manifest.targets)) {
		if (target === keepTarget || !isRecord(value)) {
			continue;
		}
		const runtime = requireTarget(manifest, target);
		await removeCachedWheel(join(resolve(root), 'resources', 'runtime', target), runtime);
		for (const role of RUNTIME_ROLES) {
			if (runtime[role] !== undefined) {
				await rm(
					join(resolve(root), 'resources', 'runtime', target, runtime[role]),
					{ force: true },
				);
			}
		}
	}
}

async function removeCachedWheel(directory, runtime) {
	await rm(join(directory, runtime.wheel.filename), { force: true });
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

function isSupportedWheelUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'file:';
	} catch {
		return false;
	}
}

function isMissingFileError(error) {
	return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
	const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
	const target = resolveRuntimeTarget(process.argv[2]);
	const assetBaseUrl = process.env.SEEKDOCK_RUNTIME_ASSET_DIR === undefined
		? process.env.SEEKDOCK_RUNTIME_ASSET_BASE_URL
		: ensureTrailingSlash(pathToFileURL(resolve(process.env.SEEKDOCK_RUNTIME_ASSET_DIR)).href);
	const result = await prepareRuntime({ root, target, assetBaseUrl });
	if (process.env.SEEKDOCK_RUNTIME_PRUNE === '1') {
		await pruneOtherRuntimeTargets(root, target);
	}
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
