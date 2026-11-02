import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	RUNTIME_TARGETS,
	VSCODE_TARGETS,
	resolveRuntimeTarget,
} from './runtime-targets.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requested = process.argv[2];
const targets = requested === 'all'
	? RUNTIME_TARGETS
	: [resolveRuntimeTarget(requested)];
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
// Node refuses to spawn `.cmd` shims without a shell on Windows (EINVAL), and the
// pinned devDependency must win over whatever `npx` would fetch.
const require = createRequire(import.meta.url);
const vsceBin = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');

for (const target of targets) {
	const vscodeTarget = VSCODE_TARGETS[target];
	if (vscodeTarget === undefined) {
		throw new Error(`No VS Code target is defined for ${target}.`);
	}
	const output = resolve(root, `seekdock-${vscodeTarget}-${packageJson.version}.vsix`);
	const result = spawnSync(
		process.execPath,
		[
			vsceBin,
			'package',
			'--readme-path',
			'MARKETPLACE_README.md',
			'--target',
			vscodeTarget,
			'--allow-missing-repository',
			'--out',
			output,
		],
		{
			cwd: root,
			env: {
				...process.env,
				SEEKDOCK_RUNTIME_PRUNE: '1',
				SEEKDOCK_RUNTIME_TARGET: target,
			},
			stdio: 'inherit',
		},
	);
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
		break;
	}
	console.log(`Packaged ${target} as ${output}.`);
}
