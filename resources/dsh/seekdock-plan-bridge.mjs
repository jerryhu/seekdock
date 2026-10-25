/**
 * Process-local plan-mode control for SeekDock's composer chip.
 *
 * The SDK wire only carries durable session events, so the current plan state
 * is read through DSH's own plan-mode service over a short private socket.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export const name = 'seekdock-plan-bridge';
export const inject = ['agents', 'planMode'];

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_PLAN_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_PLAN_SOCKET is not set.');
	}

	const server = createServer(socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock plan socket error: ${String(error)}`);
		});
		socket.on('data', chunk => {
			input += chunk;
		});
		socket.on('end', () => {
			let response;
			try {
				response = handle(ctx, JSON.parse(input));
			} catch (error) {
				response = { ok: false, message: errorMessage(error) };
			}
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});

	ctx.effect(() => (async () => {
		if (process.platform !== 'win32') {
			await rm(socketPath, { force: true });
		}
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		return () => new Promise(resolve => {
			server.close(() => {
				if (process.platform === 'win32') {
					resolve();
				} else {
					void rm(socketPath, { force: true }).finally(resolve);
				}
			});
		});
	})(), 'seekdock.plan.listen');
}

function handle(ctx, request) {
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { ok: false, message: 'A session id is required.' };
	}
	const agent = ctx.agents.get(request.sessionId);
	if (agent === undefined) {
		return {
			ok: false,
			code: 'no-session',
			message: `SDK session is not live: ${request.sessionId}`,
		};
	}
	if (request.action === 'state') {
		return { ok: true, ...ctx.planMode.get(agent) };
	}
	if (request.action === 'set') {
		if (typeof request.active !== 'boolean') {
			return { ok: false, message: 'A boolean plan-mode state is required.' };
		}
		ctx.planMode.set(agent, request.active);
		return { ok: true, ...ctx.planMode.get(agent) };
	}
	return { ok: false, message: `Unknown plan-mode action: ${String(request.action)}` };
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
