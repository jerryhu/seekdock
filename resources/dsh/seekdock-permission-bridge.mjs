/**
 * Process-local permission control for SeekDock's composer picker.
 *
 * The SDK wire exposes durable session events only, so the current permission
 * preset and the selectable catalog are read over this short private socket.
 * All writes still go through DSH's permission-presets service; SeekDock does
 * not maintain a second permission table.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export const name = 'seekdock-permission-bridge';
export const inject = ['permissionPresets', 'sessions'];

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_PERMISSION_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_PERMISSION_SOCKET is not set.');
	}

	const server = createServer(socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock permission socket error: ${String(error)}`);
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
	})(), 'seekdock.permission.listen');
}

function handle(ctx, request) {
	const catalog = ctx.permissionPresets.catalog();
	if (request?.action === 'catalog') {
		return { ok: true, catalog };
	}
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { ok: false, message: 'A session id is required.', catalog };
	}
	const session = ctx.sessions.get(request.sessionId);
	if (session === undefined) {
		return {
			ok: false,
			code: 'no-session',
			message: `SDK session is not live: ${request.sessionId}`,
			catalog,
		};
	}
	if (request.action === 'state') {
		return { ok: true, catalog, current: ctx.permissionPresets.current(session) };
	}
	if (request.action === 'set') {
		if (typeof request.preset !== 'string' || request.preset.length === 0) {
			return { ok: false, message: 'A preset is required.', catalog };
		}
		try {
			ctx.permissionPresets.set(session, request.preset);
		} catch (error) {
			return {
				ok: false,
				message: errorMessage(error),
				catalog,
				current: ctx.permissionPresets.current(session),
			};
		}
		return { ok: true, catalog, current: ctx.permissionPresets.current(session) };
	}
	return { ok: false, message: `Unknown permission action: ${String(request.action)}`, catalog };
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
