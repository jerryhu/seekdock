import { spawn } from 'node:child_process';

// The TypeScript SDK launches dshBin with Node. This wrapper bridges that
// launch contract to the native executable shipped by the Python SDK.
const executable = process.env.SEEKDOCK_DSH_RUNTIME;
if (executable === undefined || executable.length === 0) {
	console.error('SeekDock: SEEKDOCK_DSH_RUNTIME is not set.');
	process.exitCode = 127;
} else {
	const child = spawn(executable, process.argv.slice(2), {
		env: process.env,
		stdio: 'inherit',
		windowsHide: true,
	});

	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(signal, () => {
			if (!child.killed) {
				child.kill(signal);
			}
		});
	}

	child.on('error', (error) => {
		console.error(`SeekDock: failed to start the DeepSeek Harness runtime: ${error.message}`);
		process.exitCode = 1;
	});
	child.on('exit', (code, signal) => {
		if (signal !== null) {
			process.exitCode = 128 + signalNumber(signal);
			return;
		}
		process.exitCode = code ?? 1;
	});
}

function signalNumber(signal: NodeJS.Signals): number {
	switch (signal) {
		case 'SIGHUP':
			return 1;
		case 'SIGINT':
			return 2;
		case 'SIGTERM':
			return 15;
		default:
			return 1;
	}
}
