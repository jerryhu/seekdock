import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../resources/dsh/seekdock-plan-bridge.mjs';

test('plan bridge answers a complete line without waiting for a half-close', async () => {
	const socketPath = createSocketPath();
	const previousSocketPath = process.env.SEEKDOCK_PLAN_SOCKET;
	process.env.SEEKDOCK_PLAN_SOCKET = socketPath;
	const agent = { active: false };
	let lifecycle;
	const ctx = {
		logger: { warn() {} },
		agents: { get: sessionId => (sessionId === 'live-1' ? agent : undefined) },
		planMode: {
			get: target => ({ active: target.active }),
			set: (target, active) => {
				target.active = active;
			},
		},
		effect(callback) {
			lifecycle = callback();
		},
	};

	try {
		apply(ctx);
		const dispose = await lifecycle;
		try {
			assert.deepStrictEqual(
				await request(socketPath, { action: 'state', sessionId: 'live-1' }),
				{ ok: true, active: false },
			);
			assert.deepStrictEqual(
				await request(socketPath, { action: 'set', sessionId: 'live-1', active: true }),
				{ ok: true, active: true },
			);
			assert.deepStrictEqual(
				await request(socketPath, { action: 'state', sessionId: 'gone' }),
				{
					ok: false,
					code: 'no-session',
					message: 'SDK session is not live: gone',
				},
			);
		} finally {
			await dispose();
		}
	} finally {
		if (previousSocketPath === undefined) {
			delete process.env.SEEKDOCK_PLAN_SOCKET;
		} else {
			process.env.SEEKDOCK_PLAN_SOCKET = previousSocketPath;
		}
	}
});

function createSocketPath() {
	return process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-plan-test-${process.pid}-${randomUUID()}`
		: join(
			tmpdir(),
			`seekdock-plan-test-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
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
			() => finish(new Error('Plan bridge did not answer a complete request line.')),
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
