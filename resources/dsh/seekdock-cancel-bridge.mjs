/**
 * Process-local control channel for SeekDock's stop button. It receives the
 * target session id over a short private socket and cancels through the same
 * live Agent API used by DSH's own user stop action.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export const name = 'seekdock-cancel-bridge';
export const inject = ['agents'];

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_CANCEL_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_CANCEL_SOCKET is not set.');
	}

	const server = createServer(socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock cancel socket error: ${String(error)}`);
		});
		socket.on('data', chunk => {
			input += chunk;
		});
		socket.on('end', () => {
			const response = cancel(ctx, input);
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
	})(), 'seekdock.cancel.listen');
}

function cancel(ctx, input) {
	let request;
	try {
		request = JSON.parse(input);
	} catch {
		return { accepted: false, interrupted: false, message: 'Invalid cancel request.' };
	}
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { accepted: false, interrupted: false, message: 'A session id is required.' };
	}

	const agent = ctx.agents.get(request.sessionId);
	if (agent === undefined) {
		return {
			accepted: false,
			interrupted: false,
			message: `SDK session is not live: ${request.sessionId}`,
		};
	}
	const interrupted = agent.status === 'running';
	agent.cancel({ kind: 'user' }, { keepInbox: true });
	return { accepted: true, interrupted };
}
