/**
 * Process-local rename control for SeekDock's session action menu.
 *
 * The SDK wire has no title mutation method. This bridge resolves the live
 * session and delegates to DSH's log-backed title service, then drains the
 * session persistence barrier before acknowledging the rename.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export const name = 'seekdock-session-title-bridge';
export const inject = ['sessions', 'sessionTitle'];

const TITLE_WAIT_TIMEOUT_MS = 65_000;

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_SESSION_TITLE_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_SESSION_TITLE_SOCKET is not set.');
	}

	// Rename awaits the persistence barrier. Answer on the newline frame: on
	// Windows named pipes a client FIN can close the writable side before the
	// async response is sent, so never wait for `end`.
	const server = createServer({ allowHalfOpen: true }, socket => {
		let input = '';
		let answered = false;
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock session title socket error: ${String(error)}`);
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
			void (async () => {
				let response;
				try {
					const request = JSON.parse(requestText);
					response = request?.action === 'wait'
						? await waitForSessionTitle(ctx, request)
						: await renameSession(ctx, request);
				} catch (error) {
					response = { ok: false, message: errorMessage(error) };
				}
				if (!socket.destroyed) {
					socket.end(`${JSON.stringify(response)}\n`);
				}
			})();
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
	})(), 'seekdock.session-title.listen');
}

async function waitForSessionTitle(ctx, request) {
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { ok: false, code: 'session-required', message: 'A session id is required.' };
	}
	const session = ctx.sessions.get(request.sessionId);
	if (session === undefined) {
		return {
			ok: false,
			code: 'not-live',
			message: `SDK session is not live: ${request.sessionId}`,
		};
	}

	const events = session.snapshotEvents();
	const titleRequest = events.findLast(event => event.type === 'session/title-llm-request');
	const latestTitle = events.findLast(event => event.type === 'session/title');
	if (titleRequest !== undefined && (latestTitle === undefined || latestTitle.seq < titleRequest.seq)) {
		await waitForNextTitle(ctx, session, titleRequest.seq);
	}
	await ctx.sessions.flush(session);
	const title = ctx.sessionTitle.get(session);
	return {
		ok: true,
		...(title === undefined ? {} : { title: title.title, source: title.source.kind }),
	};
}

function waitForNextTitle(ctx, session, requestSeq) {
	return new Promise(resolve => {
		let settled = false;
		let dispose = () => { };
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			dispose();
			resolve();
		};
		const timer = setTimeout(finish, TITLE_WAIT_TIMEOUT_MS);
		dispose = ctx.on('session/event', (observed, event) => {
			if (observed.id === session.id && event.type === 'session/title' && event.seq > requestSeq) {
				finish();
			}
		});
	});
}

async function renameSession(ctx, request) {
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { ok: false, code: 'session-required', message: 'A session id is required.' };
	}
	if (typeof request.title !== 'string') {
		return { ok: false, code: 'title-required', message: 'A session title is required.' };
	}
	const session = ctx.sessions.get(request.sessionId);
	if (session === undefined) {
		return {
			ok: false,
			code: 'not-live',
			message: `SDK session is not live: ${request.sessionId}`,
		};
	}
	const renamed = ctx.sessionTitle.rename(session, request.title);
	await ctx.sessions.flush(session);
	return { ok: true, title: renamed.title };
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
