import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	hostRuntimeTarget,
	loadRuntimeManifest,
	verifyPreparedRuntime,
} from './prepare-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = await loadRuntimeManifest(root);
const target = process.argv[2] ?? hostRuntimeTarget();
if (target === undefined) {
	throw new Error(`No SeekDock runtime target is defined for ${process.platform}-${process.arch}.`);
}

const runtime = await verifyPreparedRuntime({ root, target });
const temporaryHome = mkdtempSync(join(tmpdir(), 'seekdock-version-check-'));
const result = spawnSync(runtime.executablePath, ['--version'], {
	encoding: 'utf8',
	env: {
		...process.env,
		DSH_HOME: temporaryHome,
	},
	timeout: 10_000,
});
rmSync(temporaryHome, { recursive: true, force: true });
if (result.error !== undefined) {
	throw result.error;
}
if (result.status !== 0) {
	throw new Error(`Runtime ${target} failed its version check: ${result.stderr.trim()}`);
}

const actual = result.stdout.trim();
if (actual !== manifest.sdkVersion) {
	throw new Error(
		`Runtime ${target} reports ${JSON.stringify(actual)}, expected ${JSON.stringify(manifest.sdkVersion)}.`,
	);
}

console.log(`Verified DeepSeek Harness ${target} runtime ${actual}.`);
