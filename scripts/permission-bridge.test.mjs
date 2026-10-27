import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../resources/dsh/seekdock-permission-bridge.mjs';

const CATALOG = {
	options: [{ value: 'workspace-write', name: 'workspace-write' }],
	defaultOptions: [{ value: 'workspace-write', name: 'workspace-write' }],
	defaultPreset: 'workspace-write',
};

test('permission bridge answers a complete line without waiting for a half-close', async () => {
	const socketPath = createSocketPath();
	const previousSocketPath = process.env.SEEKDOCK_PERMISSION_SOCKET;
	process.env.SEEKDOCK_PERMISSION_SOCKET = socketPath;
	let lifecycle;
	const ctx = {
		logger: { warn() {} },
		permissionPresets: { catalog: () => CATALOG },
		sessions: { get: () => undefined },
		effect(callback) {
			lifecycle = callback();
		},
	};

	try {
		apply(ctx);
		const dispose = await lifecycle;
		try {
			const response = await request(socketPath, { action: 'catalog' });
			assert.deepStrictEqual(response, { ok: true, catalog: CATALOG });
		} finally {
			await dispose();
		}
	} finally {
		if (previousSocketPath === undefined) {
			delete process.env.SEEKDOCK_PERMISSION_SOCKET;
		} else {
			process.env.SEEKDOCK_PERMISSION_SOCKET = previousSocketPath;
		}
	}
});

function createSocketPath() {
	return process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-permission-test-${process.pid}-${randomUUID()}`
		: join(
			tmpdir(),
			`seekdock-permission-test-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
}

function request(socketPath, payload) {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		let settled = false;
		const finish = (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) {
				reject(error);
				return;
			}
			try {
				resolve(JSON.parse(response));
			} catch (parseError) {
				reject(parseError);
			}
		};
		const timer = setTimeout(
			() => finish(new Error('Permission bridge did not answer a complete request line.')),
			2_000,
		);
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.write(`${JSON.stringify(payload)}\n`);
		});
		socket.on('data', chunk => {
			response += chunk;
			if (response.includes('\n')) {
				finish();
			}
		});
		socket.once('error', finish);
		socket.once('end', () => finish());
	});
}
