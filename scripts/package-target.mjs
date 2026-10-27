import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

for (const target of targets) {
	const vscodeTarget = VSCODE_TARGETS[target];
	if (vscodeTarget === undefined) {
		throw new Error(`No VS Code target is defined for ${target}.`);
	}
	const output = resolve(root, `seekdock-${vscodeTarget}-${packageJson.version}.vsix`);
	const result = spawnSync(
		npx,
		[
			'--yes',
			'@vscode/vsce',
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
