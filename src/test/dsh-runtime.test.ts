import * as assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDshRuntime } from '../host/dsh-runtime.ts';

const TARGETS = [
	{
		platform: 'linux',
		arch: 'x64',
		target: 'linux-x64',
		files: [
			'deepseek-harness-sdk-runtime-linux-x64',
			'deepseek-harness-sdk-runtime-linux-x64-rg',
		],
	},
	{
		platform: 'linux',
		arch: 'arm64',
		target: 'linux-arm64',
		files: [
			'deepseek-harness-sdk-runtime-linux-arm64',
			'deepseek-harness-sdk-runtime-linux-arm64-rg',
		],
	},
	{
		platform: 'darwin',
		arch: 'arm64',
		target: 'macos-arm64',
		files: [
			'deepseek-harness-sdk-runtime-macos-arm64',
			'deepseek-harness-sdk-runtime-macos-arm64-rg',
			'deepseek-harness-sdk-runtime-macos-arm64-spawn-helper',
		],
	},
	{
		platform: 'darwin',
		arch: 'x64',
		target: 'macos-x64',
		files: [
			'deepseek-harness-sdk-runtime-macos-x64',
			'deepseek-harness-sdk-runtime-macos-x64-rg',
			'deepseek-harness-sdk-runtime-macos-x64-spawn-helper',
		],
	},
	{
		platform: 'win32',
		arch: 'x64',
		target: 'win-x64',
		files: [
			'deepseek-harness-sdk-runtime-win-x64.exe',
			'deepseek-harness-sdk-runtime-win-x64-rg.exe',
		],
	},
] as const;

suite('DSH runtime resolution', () => {
	test('resolves every DeepSeek Harness system runtime', () => {
		const extensionPath = mkdtempSync(join(tmpdir(), 'seekdock-runtime-resolution-'));
		try {
			writeManifest(extensionPath);
			for (const target of TARGETS) {
				const runtimeDirectory = join(extensionPath, 'resources', 'runtime', target.target);
				mkdirSync(runtimeDirectory, { recursive: true });
				for (const filename of target.files) {
					const filePath = join(runtimeDirectory, filename);
					writeFileSync(filePath, 'fixture runtime\n');
					chmodSync(filePath, 0o755);
				}

				const runtime = resolveDshRuntime(extensionPath, target.platform, target.arch);
				assert.strictEqual(runtime.target, target.target);
				assert.strictEqual(runtime.version, 'fixture-runtime');
				assert.strictEqual(runtime.executablePath, join(runtimeDirectory, target.files[0]));
			}
		} finally {
			rmSync(extensionPath, { recursive: true, force: true });
		}
	});

	test('rejects an unpublished runtime architecture', () => {
		const extensionPath = mkdtempSync(join(tmpdir(), 'seekdock-runtime-resolution-'));
		try {
			writeManifest(extensionPath);
			assert.throws(
				() => resolveDshRuntime(extensionPath, 'win32', 'arm64'),
				/does not support DeepSeek Harness on win32-arm64/u,
			);
		} finally {
			rmSync(extensionPath, { recursive: true, force: true });
		}
	});
});

function writeManifest(extensionPath: string): void {
	const runtimeRoot = join(extensionPath, 'resources', 'runtime');
	mkdirSync(runtimeRoot, { recursive: true });
	writeFileSync(
		join(runtimeRoot, 'manifest.json'),
		JSON.stringify({
			sdkVersion: 'fixture-sdk',
			runtimePackage: 'deepseek-harness-runtime-bin',
			runtimeVersion: 'fixture-runtime',
			targets: Object.fromEntries(TARGETS.map(({ target, files }) => [
				target,
				{
					executable: files[0],
					ripgrep: files[1],
					...(files[2] === undefined ? {} : { spawnHelper: files[2] }),
				},
			])),
		}),
		'utf8',
	);
}
