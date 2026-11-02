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

	// Answer on the newline frame. On Windows named pipes a client FIN can close
	// the writable side before the response is sent, so never wait for `end`.
	const server = createServer({ allowHalfOpen: true }, socket => {
		let input = '';
		let answered = false;
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock cancel socket error: ${String(error)}`);
		});
		const answer = () => {
			if (answered) {
				return;
			}
			const boundary = input.indexOf('\n');
			if (boundary < 0 && !socket.readableEnded) {
				return;
			}
			answered = true;
			const requestText = boundary < 0 ? input : input.slice(0, boundary);
			socket.end(`${JSON.stringify(cancel(ctx, requestText))}\n`);
		};
		socket.on('data', chunk => {
			input += chunk;
			answer();
		});
		socket.on('end', answer);
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
