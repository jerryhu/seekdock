/**
 * Forward DSH approval questions to the SeekDock Webview and return the user's
 * one-shot decision.
 *
 * DSH dispatches `approval/request` as a waterfall. This bridge claims requests
 * that carry a tool call id, sends them over a short private socket, and answers
 * with the outcome the Webview selected. A missing or unresponsive host returns
 * `unavailable`, which keeps DSH's fail-closed contract: an unanswered question
 * never allows the call. Requests without a call id are delegated unchanged
 * because they cannot be attached to a visible tool card.
 */

import { connect } from 'node:net';

export const name = 'seekdock-approval-bridge';
export const inject = ['approval'];

const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
const REQUEST_TIMEOUT_MS = 10 * 60_000;

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_APPROVAL_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_APPROVAL_SOCKET is not set.');
	}

	ctx.on('approval/request', (request, next) => {
		const callId = request.callId;
		if (typeof callId !== 'string' || callId.length === 0) {
			return next();
		}
		return askHost(ctx, socketPath, request, callId).then(outcome => (
			outcome === 'unavailable' ? next() : outcome
		));
	});
}

function askHost(ctx, socketPath, request, callId) {
	const payload = {
		toolName: request.toolName,
		toolCallId: callId,
		sessionId: String(request.agent.session.id),
		...(request.reason === undefined ? {} : { reason: request.reason }),
		...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
	};

	return new Promise(resolve => {
		const socket = connect(socketPath);
		let buffer = '';
		let settled = false;
		let timer;

		const finish = outcome => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			request.signal?.removeEventListener('abort', onAbort);
			socket.destroy();
			resolve(outcome);
		};
		const onAbort = () => finish('cancelled');

		timer = setTimeout(() => finish('cancelled'), REQUEST_TIMEOUT_MS);
		request.signal?.addEventListener('abort', onAbort, { once: true });
		if (request.signal?.aborted === true) {
			finish('cancelled');
			return;
		}

		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.write(`${JSON.stringify(payload)}\n`);
		});
		socket.on('data', chunk => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline === -1) {
				return;
			}
			try {
				const reply = JSON.parse(buffer.slice(0, newline));
				finish(OUTCOMES.has(reply?.outcome) ? reply.outcome : 'unavailable');
			} catch {
				finish('unavailable');
			}
		});
		socket.once('error', error => {
			ctx.logger.warn(`SeekDock approval socket error: ${String(error)}`);
			finish('unavailable');
		});
		socket.once('end', () => finish('unavailable'));
	});
}
