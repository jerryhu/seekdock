import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
	prepareRuntime,
	verifyPreparedRuntime,
} from './prepare-runtime.mjs';

const TARGET = 'macos-arm64';
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

test('downloads, verifies, and installs all runtime artifacts', async () => {
	const fixture = await createFixture();
	const assets = makeAssets();
	const server = await startAssetServer(assets);
	try {
		await fixture.writeManifest(server.url);
		const result = await prepareRuntime({
			root: fixture.root,
			target: TARGET,
			assetBaseUrl: server.url,
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
		assert.strictEqual(server.requests.size, 3);
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
		await prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url });
		const result = await prepareRuntime({
			root: fixture.root,
			target: TARGET,
			assetBaseUrl: server.url,
		});

		assert.strictEqual(result.reused, true);
		assert.strictEqual(server.requests.size, 3);
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when an asset returns HTTP 404', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets(), {
		failures: new Map([['fixture-runtime-rg.gz', { status: 404 }]]),
	});
	try {
		await fixture.writeManifest(server.url);
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url }),
			/HTTP 404/u,
		);
		await assert.rejects(access(join(fixture.runtimeDirectory, FILES.executable)));
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when a downloaded artifact has the wrong SHA-256', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets());
	try {
		await fixture.writeManifest(server.url, {
			executableSha256: '0'.repeat(64),
		});
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url }),
			/SHA-256/u,
		);
		await assert.rejects(access(join(fixture.runtimeDirectory, FILES.executable)));
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when a downloaded artifact is not valid gzip data', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets(), {
		replacements: new Map([['fixture-runtime-spawn-helper.gz', Buffer.from('not gzip')]]),
	});
	try {
		await fixture.writeManifest(server.url);
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url }),
			/Could not unpack runtime asset/u,
		);
	} finally {
		await server.close();
		await fixture.close();
	}
});

test('fails when an asset response is truncated', async () => {
	const fixture = await createFixture();
	const server = await startAssetServer(makeAssets(), {
		truncate: new Set(['fixture-runtime-rg.gz']),
	});
	try {
		await fixture.writeManifest(server.url);
		await assert.rejects(
			prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url }),
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
		await prepareRuntime({ root: fixture.root, target: TARGET, assetBaseUrl: server.url });
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
	return new Map(
		Object.entries(FILES).map(([role, filename]) => [
			`${filename}.gz`,
			gzipSync(CONTENTS[role]),
		]),
	);
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), 'seekdock-runtime-prepare-test-'));
	const runtimeDirectory = join(root, 'resources', 'runtime', TARGET);
	await mkdir(runtimeDirectory, { recursive: true });
	await writeFile(join(runtimeDirectory, 'LICENSE'), 'fixture license\n');
	await writeFile(join(runtimeDirectory, 'THIRD_PARTY_NOTICES.md'), 'fixture notices\n');

	return {
		root,
		runtimeDirectory,
		async writeManifest(assetBaseUrl, overrides = {}) {
			const artifacts = Object.fromEntries(
				Object.entries(FILES).map(([role, filename]) => [
					role,
					{
						asset: `${filename}.gz`,
						size: CONTENTS[role].length,
						sha256: overrides[`${role}Sha256`]
							?? createHash('sha256').update(CONTENTS[role]).digest('hex'),
					},
				]),
			);
			await writeFile(
				join(root, 'resources', 'runtime', 'manifest.json'),
				JSON.stringify({
					sdkVersion: 'fixture',
					runtimeVersion: 'fixture',
					release: {
						tag: 'runtime-fixture',
						assetBaseUrl,
					},
					targets: {
						[TARGET]: {
							...FILES,
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
