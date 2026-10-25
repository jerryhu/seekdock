/**
 * Read-only skill catalog bridge for SeekDock's Webview composer.
 *
 * The SDK wire does not expose the browser-side `/` source used by DSH's own
 * Web UI. This process-local socket reads the same skill registry and returns
 * metadata or the selected instruction file without duplicating discovery.
 */

import { realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';

export const name = 'seekdock-skill-bridge';
export const inject = ['skills'];

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_SKILL_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_SKILL_SOCKET is not set.');
	}
	const roots = {
		workspace: requiredDirectory('SEEKDOCK_WORKSPACE_SKILL_DIR'),
		user: requiredDirectory('SEEKDOCK_USER_SKILL_DIR'),
	};

	// Catalog and skill reads await DSH providers. Keep the writable half open
	// after the client's request FIN so the async response can still be sent.
	const server = createServer({ allowHalfOpen: true }, socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('error', error => {
			ctx.logger.warn(`SeekDock skill socket error: ${String(error)}`);
		});
		socket.on('data', chunk => {
			input += chunk;
		});
		socket.on('end', () => {
			void (async () => {
				let response;
				try {
					response = await handle(ctx, JSON.parse(input), roots);
				} catch (error) {
					response = { ok: false, message: errorMessage(error) };
				}
				socket.end(`${JSON.stringify(response)}\n`);
			})();
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
	})(), 'seekdock.skills.listen');
}

async function handle(ctx, request, roots) {
	const cwd = typeof request?.cwd === 'string' && request.cwd.length > 0
		? request.cwd
		: process.cwd();
	if (request?.action === 'list') {
		const skills = await ctx.skills.list({ cwd });
		const catalog = await Promise.all(skills.map(async skill => {
			const source = await sourceForPath(skill.path, roots);
			if (skill.invocation?.userInvocable === false || source === undefined) {
				return undefined;
			}
			return {
				name: skill.name,
				description: skill.description,
				source,
				modelInvocable: skill.invocation?.modelInvocable !== false,
				path: skill.path,
			};
		}));
		return {
			ok: true,
			skills: catalog
				.filter(skill => skill !== undefined)
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
	}
	if (request?.action === 'get') {
		if (typeof request.name !== 'string' || request.name.length === 0) {
			return { ok: false, message: 'A skill name is required.' };
		}
		const skill = await ctx.skills.get(request.name, { cwd });
		if (skill === undefined) {
			return { ok: false, code: 'not-found', message: `Skill not found: ${request.name}` };
		}
		const source = await sourceForPath(skill.path, roots);
		if (source === undefined) {
			return { ok: false, code: 'not-found', message: `Skill not found: ${request.name}` };
		}
		return {
			ok: true,
			skill: {
				name: skill.name,
				description: skill.description,
				source,
				modelInvocable: skill.invocation.modelInvocable,
				content: skill.content,
				...(skill.path === undefined ? {} : { path: skill.path }),
			},
		};
	}
	return { ok: false, message: `Unknown skill action: ${String(request?.action)}` };
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function requiredDirectory(name) {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`SeekDock: ${name} is not set.`);
	}
	return value;
}

async function sourceForPath(path, roots) {
	if (typeof path !== 'string') {
		return undefined;
	}
	const resolvedPath = await canonicalPath(path);
	for (const [source, root] of Object.entries(roots)) {
		if (isPathInside(root, path) || isPathInside(await canonicalPath(root), resolvedPath)) {
			return source;
		}
	}
	return undefined;
}

async function canonicalPath(path) {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

function isPathInside(root, path) {
	const child = relative(root, path);
	return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
