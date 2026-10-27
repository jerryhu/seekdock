/**
 * Mount DSH's per-turn workspace-change recorder in the SDK profile and expose
 * its live summary/comparison service to the SeekDock extension host.
 *
 * The package is nested under the runtime's Web bundle, so loading it by bare
 * name from this resources directory does not work. Cordis can import it from
 * the active runtime profile, which is also where its peer services live.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export const name = 'seekdock-workspace-changes';
export const inject = ['subprocess', 'fs'];

const WORKSPACE_CHANGES_PACKAGE = '@deepseek-ai/dsh-workspace-changes';

export async function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_WORKSPACE_CHANGES_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_WORKSPACE_CHANGES_SOCKET is not set.');
	}

	const workspaceChangesPlugin = await ctx.loader.import(
		WORKSPACE_CHANGES_PACKAGE,
		ctx.baseUrl,
	);
	if (typeof workspaceChangesPlugin?.apply !== 'function'
		|| typeof workspaceChangesPlugin?.Config !== 'function') {
		throw new Error('SeekDock: the runtime exposes no workspace-changes plugin.');
	}
	workspaceChangesPlugin.apply(ctx, workspaceChangesPlugin.Config({}));

	const lifetime = new AbortController();
	const requests = new Set();
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		const controller = new AbortController();
		requests.add(controller);
		let input = '';
		let answered = false;
		socket.setEncoding('utf8');
		socket.on('error', (error) => {
			ctx.logger.warn(`SeekDock workspace-changes socket error: ${String(error)}`);
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
			const text = boundary < 0 ? input : input.slice(0, boundary);
			void handle(ctx, text, controller.signal, lifetime.signal).then((response) => {
				if (!socket.destroyed) {
					socket.end(`${JSON.stringify(response)}\n`);
				}
			}).finally(() => {
				requests.delete(controller);
			});
		};

		socket.on('data', (chunk) => {
			input += chunk;
			answer();
		});
		socket.on('end', answer);
		socket.on('close', () => {
			if (!answered) {
				controller.abort();
			}
			requests.delete(controller);
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
		return () => new Promise((resolve) => {
			lifetime.abort();
			for (const controller of requests) {
				controller.abort();
			}
			server.close(() => {
				if (process.platform === 'win32') {
					resolve();
				} else {
					void rm(socketPath, { force: true }).finally(resolve);
				}
			});
		});
	})(), 'seekdock.workspace-changes.listen');
}

async function handle(ctx, text, requestSignal, lifetimeSignal) {
	let request;
	try {
		request = JSON.parse(text);
	} catch {
		return { ok: false, message: 'Invalid workspace-changes request.' };
	}
	if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
		return { ok: false, message: 'A session id is required.' };
	}
	if (!Number.isSafeInteger(request.seq) || request.seq < 0) {
		return { ok: false, message: 'A valid workspace-changes sequence is required.' };
	}

	try {
		if (request.action === 'summary') {
			let summary = ctx.workspaceChanges.summary(request.sessionId, request.seq);
			if (summary === undefined) {
				await new Promise(resolve => setImmediate(resolve));
				summary = ctx.workspaceChanges.summary(request.sessionId, request.seq);
			}
			if (summary === undefined) {
				return { ok: false, code: 'missing', message: 'Workspace changes are no longer available.' };
			}
			return {
				ok: true,
				summary: {
					turn: summary.turn,
					files: summary.files,
					total: summary.total,
					added: summary.added,
					deleted: summary.deleted,
				},
			};
		}
		if (request.action === 'diff') {
			if (!Number.isSafeInteger(request.index) || request.index < 0) {
				return { ok: false, message: 'A valid changed-file index is required.' };
			}
			const signal = AbortSignal.any([requestSignal, lifetimeSignal]);
			const diff = await ctx.workspaceChanges.diff(
				request.sessionId,
				request.seq,
				request.index,
				signal,
			);
			if (diff === undefined) {
				return { ok: false, code: 'missing', message: 'The file comparison is no longer available.' };
			}
			return { ok: true, diff };
		}
		return { ok: false, message: `Unknown workspace-changes action: ${String(request.action)}` };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
