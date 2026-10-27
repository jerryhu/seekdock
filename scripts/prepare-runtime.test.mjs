import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import {
	hostRuntimeTarget,
	loadRuntimeManifest,
	prepareRuntime,
	verifyPreparedRuntime,
} from './prepare-runtime.mjs';
import {
	RUNTIME_TARGETS,
	VSCODE_TARGETS,
} from './runtime-targets.mjs';

const TARGET = 'macos-arm64';
const WHEEL_FILENAME = 'fixture-runtime.whl';
const FILES = {
	executable: 'fixture-runtime',
	ripgrep: 'fixture-runtime-rg',
	spawnHelper: 'fixture-runtime-spawn-helper',
};
const CONTENTS = {
	executable: Buffer.from('fixture runtime executable\n'),
	ripgrep: Buffer.from('fixture ripgrep\n'),
	spawnHelper: Buffer.from('fixture spawn helper\n'),
};
const DOCUMENTS = {
	LICENSE: Buffer.from('fixture license\n'),
	'THIRD_PARTY_NOTICES.md': Buffer.from('fixture notices\n'),
};

test('maps every DeepSeek Harness runtime to its build host and VS Code target', () => {
	assert.deepStrictEqual(
		[
			hostRuntimeTarget('linux', 'x64'),
			hostRuntimeTarget('linux', 'arm64'),
			hostRuntimeTarget('darwin', 'arm64'),
			hostRuntimeTarget('darwin', 'x64'),
			hostRuntimeTarget('win32', 'x64'),
		],
		RUNTIME_TARGETS,
	);
	assert.deepStrictEqual(
		Object.fromEntries(RUNTIME_TARGETS.map(target => [target, VSCODE_TARGETS[target]])),
		{
			'linux-x64': 'linux-x64',
			'linux-arm64': 'linux-arm64',
			'macos-arm64': 'darwin-arm64',
			'macos-x64': 'darwin-x64',
			'win-x64': 'win32-x64',
		},
	);
});

test('runtime manifest includes every official runtime wheel', async () => {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const manifest = await loadRuntimeManifest(root);
	assert.deepStrictEqual(Object.keys(manifest.targets).sort(), [...RUNTIME_TARGETS].sort());
	for (const target of RUNTIME_TARGETS) {
		const runtime = manifest.targets[target];
		assert.match(runtime.wheel.filename, /0\.2\.1rc2/u);
		assert.match(runtime.wheel.url, /^https:\/\/files\.pythonhosted\.org\//u);
		assert.match(runtime.wheel.sha256, /^[a-f0-9]{64}$/u);
		assert.ok(runtime.wheel.size > 0);
	}
});

test('downloads, verifies, and installs all runtime artifacts from a wheel', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets());
	try {
		await fixture.writeManifest(server.url);
		const result = await prepareRuntime({
			root: fixture.root,
			target: TARGET,
		});

		assert.strictEqual(result.reused, false);
		for (const role of Object.keys(FILES)) {
			assert.deepStrictEqual(
				await readFile(join(fixture.runtimeDirectory, FILES[role])),
				CONTENTS[role],
			);
		}
		const executableMode = (await stat(join(fixture.runtimeDirectory, FILES.executable))).mode;
		assert.notStrictEqual(executableMode & 0o111, 0);
		for (const [filename, contents] of Object.entries(DOCUMENTS)) {
			assert.deepStrictEqual(
				await readFile(join(fixture.runtimeDirectory, filename)),
				contents,
			);
		}
		await assert.rejects(access(join(fixture.runtimeDirectory, WHEEL_FILENAME)));
		assert.deepStrictEqual([...server.requests], [WHEEL_FILENAME]);
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('reuses a verified runtime without downloading again', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets());
	try {
		await fixture.writeManifest(server.url);
		await prepareRuntime({ root: fixture.root, target: TARGET });
		const result = await prepareRuntime({
			root: fixture.root,
			target: TARGET,
		});

		assert.strictEqual(result.reused, true);
		assert.strictEqual(server.requests.size, 1);
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when the wheel returns HTTP 404', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets(), {
		failures: new Map([[WHEEL_FILENAME, { status: 404 }]]),
	});
	try {
		await fixture.writeManifest(server.url);
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET }),
			/HTTP 404/u,
		);
		await assert.rejects(access(join(fixture.runtimeDirectory, FILES.executable)));
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when the downloaded wheel has the wrong SHA-256', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets());
	try {
		await fixture.writeManifest(server.url, {
			wheelSha256: '0'.repeat(64),
		});
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET }),
			/SHA-256/u,
		);
		await assert.rejects(access(join(fixture.runtimeDirectory, FILES.executable)));
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when the downloaded wheel is not valid ZIP data', async () => {
	const fixture = await createFixture();
	const replacement = Buffer.from('not zip');
	const server = await startAssetServer(makeAssets(), {
		replacements: new Map([[WHEEL_FILENAME, replacement]]),
	});
	try {
		await fixture.writeManifest(server.url, {
			wheelSha256: createHash('sha256').update(replacement).digest('hex'),
			wheelSize: replacement.length,
		});
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET }),
			/Could not unpack runtime wheel/u,
		);
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when the wheel response is truncated', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets(), {
		truncate: new Set([WHEEL_FILENAME]),
	});
	try {
		await fixture.writeManifest(server.url);
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET }),
		);
		await assert.rejects(access(join(fixture.runtimeDirectory, FILES.executable)));
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('rejects a cache whose content no longer matches the manifest', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets());
	try {
		await fixture.writeManifest(server.url);
		await prepareRuntime({ root: fixture.root, target: TARGET });
		await writeFile(join(fixture.runtimeDirectory, FILES.executable), 'tampered');
		await assert.rejects(
			verifyPreparedRuntime({ root: fixture.root, target: TARGET }),
			/size|SHA-256/u,
		);
	} finally {
		await server.close();
		await fixture.close();
	}
});

function makeAssets() {
	return new Map([[WHEEL_FILENAME, makeWheel()]]);
}

function makeWheel() {
	return Buffer.from(zipSync({
		deepseek_harness_runtime: {
			runtime: Object.fromEntries(
				Object.entries(FILES).map(([role, filename]) => [filename, CONTENTS[role]]),
			),
		},
		'deepseek_harness_runtime_bin-0.2.1rc2.dist-info': {
			licenses: DOCUMENTS,
		},
	}));
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), 'seekdock-runtime-prepare-test-'));
	const runtimeDirectory = join(root, 'resources', 'runtime', TARGET);
	await mkdir(join(root, 'resources', 'runtime'), { recursive: true });

	return {
		root,
		runtimeDirectory,
		async writeManifest(assetBaseUrl, overrides = {}) {
			const wheel = makeWheel();
			const artifacts = Object.fromEntries(
				Object.entries(FILES).map(([role]) => [
					role,
					{
						size: CONTENTS[role].length,
						sha256: createHash('sha256').update(CONTENTS[role]).digest('hex'),
					},
				]),
			);
			await writeFile(
				join(root, 'resources', 'runtime', 'manifest.json'),
				JSON.stringify({
					schemaVersion: 2,
					sdkVersion: 'fixture',
					runtimeVersion: 'fixture',
					targets: {
						[TARGET]: {
							...FILES,
							wheel: {
								filename: WHEEL_FILENAME,
								url: new URL(WHEEL_FILENAME, assetBaseUrl).href,
								size: overrides.wheelSize ?? wheel.length,
								sha256: overrides.wheelSha256
									?? createHash('sha256').update(wheel).digest('hex'),
							},
							artifacts,
						},
					},
				}),
			);
		},
		async close() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function startAssetServer(assets, options = {}) {
	const requests = new Set();
	const server = createServer((request, response) => {
		const filename = request.url?.replace(/^\//u, '') ?? '';
		requests.add(filename);
		const failure = options.failures?.get(filename);
		if (failure !== undefined) {
			response.writeHead(failure.status);
			response.end();
			return;
		}
		const contents = options.replacements?.get(filename) ?? assets.get(filename);
		if (contents === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			'content-length': options.truncate?.has(filename) ? contents.length + 100 : contents.length,
		});
		if (options.truncate?.has(filename)) {
			response.end(contents.subarray(0, Math.max(1, contents.length - 1)));
			return;
		}
		response.end(contents);
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Runtime fixture server did not bind a TCP port.');
	}
	return {
		url: `http://127.0.0.1:${address.port}/`,
		requests,
		close: () => new Promise((resolveClose, rejectClose) => {
			server.close(error => error === undefined ? resolveClose() : rejectClose(error));
		}),
	};
}
