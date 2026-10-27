import { createHash } from 'node:crypto';
import {
	collectMcpSecretNames,
	WORKSPACE_FOLDER_VARIABLE,
	type McpEntry,
	type McpServer,
} from '../../shared/mcp-servers.ts';

const SECRET_VARIABLE_PATTERN = /\$\{secret:([^}]+)\}/g;
const SECRET_ENV_PREFIX = 'SEEKDOCK_MCP_SECRET_';

/** Generated DSH patch layer and the secret names it expects in the runtime environment. */
export interface McpRuntimePatch {
	yaml: string;
	secretNames: readonly string[];
}

/**
 * Build a DSH patch that mounts one `mcp-client` row per enabled server.
 *
 * Secret placeholders become child-process environment expressions, so the
 * persisted patch never contains secret values.
 *
 * @param servers - complete persisted MCP server list.
 * @param workspaceRoot - active HarnessRunner workspace.
 * @returns patch YAML and referenced SecretStorage names.
 */
export function buildMcpRuntimePatch(
	servers: readonly McpServer[],
	workspaceRoot: string,
): McpRuntimePatch {
	const enabled = servers.filter(server => server.enabled);
	const secretNames = [...new Set(enabled.flatMap(collectMcpSecretNames))].sort();
	if (enabled.length === 0) {
		return { yaml: '[]\n', secretNames };
	}

	const lines = ['- insert:'];
	for (const server of enabled) {
		const id = `seekdock-mcp-${createHash('sha256')
			.update(server.serverName)
			.digest('hex')
			.slice(0, 12)}`;
		lines.push(
			`  - id: ${quote(id)}`,
			`    name: "@deepseek-ai/dsh-mcp-client"`,
			'    config:',
			`      serverName: ${quote(server.serverName)}`,
			`      transport: ${quote(server.transport === 'stdio' ? 'stdio' : 'streamable-http')}`,
		);
		if (server.transport === 'stdio') {
			lines.push(`      command: ${renderValue(server.command, workspaceRoot)}`);
			appendStringArray(lines, 'args', server.args, workspaceRoot);
			appendEntries(lines, 'env', server.env, workspaceRoot);
			lines.push(
				`      cwd: ${renderValue(server.cwd ?? WORKSPACE_FOLDER_VARIABLE, workspaceRoot)}`,
			);
		} else {
			lines.push(`      url: ${renderValue(server.url, workspaceRoot)}`);
			appendEntries(lines, 'headers', server.headers, workspaceRoot);
		}
		lines.push(
			'      toolCallTimeoutMs: 60000',
			'      failOnStartupError: false',
		);
	}
	return {
		yaml: `${lines.join('\n')}\n`,
		secretNames,
	};
}

/**
 * Map secret names to isolated child-process environment keys.
 *
 * @param secretNames - names referenced by the generated patch.
 * @param readSecret - SecretStorage-backed lookup.
 * @returns environment entries without persisting their values.
 */
export async function resolveMcpRuntimeSecrets(
	secretNames: readonly string[],
	readSecret: (name: string) => PromiseLike<string | undefined>,
): Promise<Readonly<Record<string, string>>> {
	const entries = await Promise.all(secretNames.map(async (name) => {
		const value = await readSecret(name);
		if (value === undefined) {
			throw new Error(`MCP secret is not configured: ${name}`);
		}
		return [secretEnvironmentName(name), value] as const;
	}));
	return Object.fromEntries(entries);
}

/** @returns the child-process environment key for one SecretStorage-backed MCP variable. */
export function secretEnvironmentName(name: string): string {
	return `${SECRET_ENV_PREFIX}${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

function appendStringArray(
	lines: string[],
	key: string,
	values: readonly string[],
	workspaceRoot: string,
): void {
	if (values.length === 0) {
		lines.push(`      ${key}: []`);
		return;
	}
	lines.push(`      ${key}:`);
	for (const value of values) {
		lines.push(`        - ${renderValue(value, workspaceRoot)}`);
	}
}

function appendEntries(
	lines: string[],
	key: string,
	entries: readonly McpEntry[],
	workspaceRoot: string,
): void {
	if (entries.length === 0) {
		lines.push(`      ${key}: {}`);
		return;
	}
	lines.push(`      ${key}:`);
	for (const entry of entries) {
		lines.push(`        ${quote(entry.name)}: ${renderValue(entry.value, workspaceRoot)}`);
	}
}

function renderValue(value: string, workspaceRoot: string): string {
	const workspaceValue = value.replaceAll(WORKSPACE_FOLDER_VARIABLE, workspaceRoot);
	const parts: string[] = [];
	let cursor = 0;
	for (const match of workspaceValue.matchAll(SECRET_VARIABLE_PATTERN)) {
		const index = match.index;
		if (index === undefined) {
			continue;
		}
		if (index > cursor) {
			parts.push(quote(workspaceValue.slice(cursor, index)));
		}
		const name = match[1];
		if (name === undefined || name.length === 0) {
			continue;
		}
		parts.push(`process.env.${secretEnvironmentName(name)}`);
		cursor = index + match[0].length;
	}
	if (parts.length === 0) {
		return quote(workspaceValue);
	}
	if (cursor < workspaceValue.length) {
		parts.push(quote(workspaceValue.slice(cursor)));
	}
	return `!!js ${quote(parts.length === 1 ? parts[0] : parts.join(' + '))}`;
}

function quote(value: string): string {
	return JSON.stringify(value) ?? '""';
}
