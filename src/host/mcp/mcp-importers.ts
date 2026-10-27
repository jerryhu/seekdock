import { createHash } from 'node:crypto';
import {
	collectMcpSecretNames,
	MCP_SERVER_NAME_PATTERN,
	validateMcpServer,
	type McpEntry,
	type McpHttpServer,
	type McpImportServerPreview,
	type McpImportSource,
	type McpImportSourceId,
	type McpServer,
	type McpStdioServer,
} from '../../shared/mcp-servers.ts';
import { isRecord } from '../../shared/value-validation.ts';

interface ExternalMcpServer {
	name: string;
	transport?: string;
	command?: string;
	args: readonly string[];
	env: readonly McpEntry[];
	cwd?: string;
	url?: string;
	headers: readonly McpEntry[];
	enabled: boolean;
}

export interface ParsedMcpImport {
	servers: readonly McpServer[];
	previews: readonly McpImportServerPreview[];
}

/**
 * Mirror DSH ACP's import normalization so imported names remain valid and
 * deterministic while hand-authored invalid names stay rejected.
 *
 * @param name - human-readable name from an external MCP configuration.
 * @returns a DSH-safe namespace.
 */
export function normalizeImportedServerName(name: string): string {
	if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new Error('MCP server name is empty or contains control characters.');
	}
	if (MCP_SERVER_NAME_PATTERN.test(name)) {
		return name;
	}
	const slug = name.normalize('NFKD')
		.replace(/[^A-Za-z0-9_-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 20) || 'server';
	const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
	return `${slug}_${hash}`.slice(0, 32);
}

/** @returns a preview-only source for a file that does not exist. */
export function missingMcpImportSource(id: McpImportSourceId, path: string): McpImportSource {
	return { id, path, available: false, servers: [] };
}

/**
 * Parse one supported external configuration format without writing it back.
 *
 * @param sourceId - known read-only import source.
 * @param path - absolute source path shown in the settings UI.
 * @param text - complete file contents.
 * @returns validated servers plus metadata-only previews for every declaration.
 */
export function parseMcpImport(
	sourceId: McpImportSourceId,
	path: string,
	text: string,
): McpImportSource {
	const externalServers = sourceId === 'codex'
		? parseCodexToml(text)
		: parseJsonMcpConfig(sourceId, text);
	const parsed = convertExternalServers(sourceId, externalServers);
	return {
		id: sourceId,
		path,
		available: true,
		servers: parsed.previews,
	};
}

/** @returns validated source metadata for a parser failure without exposing file contents. */
export function invalidMcpImportSource(
	id: McpImportSourceId,
	path: string,
): McpImportSource {
	return {
		id,
		path,
		available: true,
		servers: [],
		error: 'invalidConfiguration',
	};
}

/**
 * Select and validate declarations from a parsed source for import.
 *
 * @param parsed - parsed external source.
 * @param names - original names selected in the preview.
 * @returns valid declarations in source order.
 */
export function selectImportedMcpServers(
	parsed: ParsedMcpImport,
	names: readonly string[],
): readonly McpServer[] {
	const selected = new Set(names);
	return parsed.servers.filter((server) => (
		server.originalName !== undefined && selected.has(server.originalName)
	));
}

export function parseMcpImportServers(
	sourceId: McpImportSourceId,
	text: string,
): ParsedMcpImport {
	return convertExternalServers(
		sourceId,
		sourceId === 'codex' ? parseCodexToml(text) : parseJsonMcpConfig(sourceId, text),
	);
}

function convertExternalServers(
	sourceId: McpImportSourceId,
	externalServers: readonly ExternalMcpServer[],
): ParsedMcpImport {
	const usedNames = new Set<string>();
	const servers: McpServer[] = [];
	const previews: McpImportServerPreview[] = [];
	for (const external of externalServers) {
		let serverName: string;
		try {
			serverName = normalizeImportedServerName(external.name);
		} catch {
			previews.push({
				originalName: external.name,
				serverName: '',
				secretNames: [],
				error: { code: 'invalidName' },
			});
			continue;
		}
		if (usedNames.has(serverName)) {
			previews.push({
				originalName: external.name,
				serverName,
				secretNames: [],
				error: { code: 'duplicateName', detail: serverName },
			});
			continue;
		}
		usedNames.add(serverName);

		if (external.transport === 'sse') {
			previews.push({
				originalName: external.name,
				serverName,
				secretNames: [],
				error: { code: 'unsupportedTransport', detail: 'sse' },
			});
			continue;
		}

		const server = toMcpServer(sourceId, external, serverName);
		if (server === undefined) {
			previews.push({
				originalName: external.name,
				serverName,
				secretNames: [],
				error: { code: 'invalidConfiguration' },
			});
			continue;
		}
		const issues = validateMcpServer(server);
		const unsupported = issues.find(issue => issue.code === 'unsupportedVariable');
		if (unsupported !== undefined) {
			previews.push({
				originalName: external.name,
				serverName,
				transport: server.transport,
				secretNames: collectMcpSecretNames(server),
				error: {
					code: 'unsupportedVariable',
					...(unsupported.detail === undefined ? {} : { detail: unsupported.detail }),
				},
			});
			continue;
		}
		if (issues.length > 0) {
			previews.push({
				originalName: external.name,
				serverName,
				transport: server.transport,
				secretNames: collectMcpSecretNames(server),
				error: { code: 'invalidConfiguration' },
			});
			continue;
		}
		servers.push(server);
		previews.push({
			originalName: external.name,
			serverName,
			transport: server.transport,
			secretNames: collectMcpSecretNames(server),
		});
	}
	return { servers, previews };
}

function toMcpServer(
	sourceId: McpImportSourceId,
	external: ExternalMcpServer,
	serverName: string,
): McpServer | undefined {
	const provenance = {
		originalName: external.name,
		importedFrom: sourceId,
	};
	if (external.transport === undefined
		&& external.command !== undefined
		&& external.url !== undefined) {
		return undefined;
	}
	const transport = external.transport
		?? (external.command !== undefined ? 'stdio' : external.url !== undefined ? 'http' : undefined);
	if (transport === 'stdio') {
		if (external.command === undefined) {
			return undefined;
		}
		const server: McpStdioServer = {
			serverName,
			transport: 'stdio',
			enabled: external.enabled,
			command: external.command,
			args: external.args,
			env: external.env,
			...(external.cwd === undefined ? {} : { cwd: external.cwd }),
			...provenance,
		};
		return server;
	}
	if (transport === 'http' || transport === 'streamable-http') {
		if (external.url === undefined) {
			return undefined;
		}
		const server: McpHttpServer = {
			serverName,
			transport: 'http',
			enabled: external.enabled,
			url: external.url,
			headers: external.headers,
			...provenance,
		};
		return server;
	}
	return undefined;
}

function parseJsonMcpConfig(
	sourceId: Exclude<McpImportSourceId, 'codex'>,
	text: string,
): readonly ExternalMcpServer[] {
	const root: unknown = JSON.parse(text);
	if (!isRecord(root)) {
		throw new Error('MCP configuration root must be an object.');
	}
	const collectionKey = sourceId === 'vscode' ? 'servers' : 'mcpServers';
	const collection = root[collectionKey];
	if (!isRecord(collection)) {
		throw new Error(`MCP configuration must contain a "${collectionKey}" object.`);
	}
	return Object.entries(collection).map(([name, value]) => (
		parseExternalJsonServer(name, value)
	));
}

function parseExternalJsonServer(name: string, value: unknown): ExternalMcpServer {
	if (!isRecord(value)) {
		throw new Error(`MCP server "${name}" must be an object.`);
	}
	const type = readOptionalString(value.type, `MCP server "${name}" type`);
	const transport = type ?? readOptionalString(
		value.transport,
		`MCP server "${name}" transport`,
	);
	const command = readOptionalString(value.command, `MCP server "${name}" command`);
	const args = readStringArray(value.args, `MCP server "${name}" arguments`);
	const env = readEntries(value.env, `MCP server "${name}" environment`);
	const cwd = readOptionalString(value.cwd, `MCP server "${name}" cwd`);
	const url = readOptionalString(value.url, `MCP server "${name}" url`);
	const headers = readEntries(value.headers ?? value.http_headers, `MCP server "${name}" headers`);
	const disabled = readOptionalBoolean(value.disabled, `MCP server "${name}" disabled`);
	const enabled = disabled === true
		? false
		: readOptionalBoolean(value.enabled, `MCP server "${name}" enabled`) ?? true;
	return {
		name,
		...(transport === undefined ? {} : { transport }),
		...(command === undefined ? {} : { command }),
		args,
		env,
		...(cwd === undefined ? {} : { cwd }),
		...(url === undefined ? {} : { url }),
		headers,
		enabled,
	};
}

function parseCodexToml(text: string): readonly ExternalMcpServer[] {
	const servers = new Map<string, {
		command?: string;
		args?: readonly string[];
		env?: readonly McpEntry[];
		cwd?: string;
		url?: string;
		headers?: readonly McpEntry[];
		enabled?: boolean;
		table?: 'env' | 'http_headers' | 'env_http_headers';
	}>();
	let currentName: string | undefined;

	for (const statement of splitTomlStatements(text)) {
		if (statement.startsWith('[')) {
			const path = parseTomlPath(statement.slice(1, -1));
			if (path[0] !== 'mcp_servers' || path[1] === undefined) {
				currentName = undefined;
				continue;
			}
			currentName = path[1];
			const record = servers.get(currentName) ?? {};
			if (path[2] === 'env') {
				record.table = 'env';
				record.env ??= [];
			} else if (path[2] === 'http_headers') {
				record.table = 'http_headers';
				record.headers ??= [];
			} else if (path[2] === 'env_http_headers') {
				record.table = 'env_http_headers';
				record.headers ??= [];
			} else {
				record.table = undefined;
			}
			servers.set(currentName, record);
			continue;
		}
		if (currentName === undefined) {
			continue;
		}
		const separator = findTopLevel(statement, '=');
		if (separator < 0) {
			continue;
		}
		const key = parseTomlKey(statement.slice(0, separator).trim());
		const value = parseTomlValue(statement.slice(separator + 1).trim());
		const record = servers.get(currentName) ?? {};
		if (record.table !== undefined) {
			if (typeof value !== 'string') {
				throw new Error(`MCP server "${currentName}" ${record.table} entry must be a string.`);
			}
			if (record.table === 'env') {
				record.env = [...(record.env ?? []), { name: key, value }];
			} else {
				record.headers = [
					...(record.headers ?? []),
					{
						name: key,
						value: record.table === 'env_http_headers'
							? `\${secret:${value}}`
							: value,
					},
				];
			}
			servers.set(currentName, record);
			continue;
		}
		switch (key) {
			case 'command':
				record.command = requireTomlString(value, `${currentName}.command`);
				break;
			case 'args':
				record.args = requireTomlStringArray(value, `${currentName}.args`);
				break;
			case 'env':
				record.env = requireTomlEntries(value, `${currentName}.env`);
				break;
			case 'cwd':
				record.cwd = requireTomlString(value, `${currentName}.cwd`);
				break;
			case 'url':
				record.url = requireTomlString(value, `${currentName}.url`);
				break;
			case 'http_headers':
			case 'headers':
				record.headers = [
					...(record.headers ?? []),
					...requireTomlEntries(value, `${currentName}.headers`),
				];
				break;
			case 'env_http_headers':
				record.headers = [
					...(record.headers ?? []),
					...requireTomlEntries(value, `${currentName}.env_http_headers`).map(entry => ({
						name: entry.name,
						value: `\${secret:${entry.value}}`,
					})),
				];
				break;
			case 'bearer_token_env_var': {
				const secretName = requireTomlString(value, `${currentName}.bearer_token_env_var`);
				record.headers = [
					...(record.headers ?? []).filter(entry => entry.name.toLowerCase() !== 'authorization'),
					{ name: 'Authorization', value: `Bearer \${secret:${secretName}}` },
				];
				break;
			}
			case 'enabled':
				record.enabled = requireTomlBoolean(value, `${currentName}.enabled`);
				break;
		}
		servers.set(currentName, record);
	}

	return [...servers.entries()].map(([name, record]) => ({
		name,
		transport: record.url === undefined ? 'stdio' : 'http',
		...(record.command === undefined ? {} : { command: record.command }),
		args: record.args ?? [],
		env: record.env ?? [],
		...(record.cwd === undefined ? {} : { cwd: record.cwd }),
		...(record.url === undefined ? {} : { url: record.url }),
		headers: record.headers ?? [],
		enabled: record.enabled ?? true,
	}));
}

function splitTomlStatements(text: string): readonly string[] {
	const statements: string[] = [];
	let pending = '';
	for (const sourceLine of text.split(/\r?\n/)) {
		const line = stripTomlComment(sourceLine).trim();
		if (line.length === 0) {
			continue;
		}
		pending = pending.length === 0 ? line : `${pending} ${line}`;
		if (tomlDepth(pending) > 0) {
			continue;
		}
		statements.push(pending);
		pending = '';
	}
	if (pending.length > 0) {
		statements.push(pending);
	}
	return statements;
}

function stripTomlComment(line: string): string {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = quote === undefined ? char : quote === char ? undefined : quote;
			continue;
		}
		if (char === '#' && quote === undefined) {
			return line.slice(0, index);
		}
	}
	return line;
}

function tomlDepth(value: string): number {
	let depth = 0;
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = quote === undefined ? char : quote === char ? undefined : quote;
			continue;
		}
		if (quote !== undefined) {
			continue;
		}
		if (char === '[' || char === '{') {
			depth += 1;
		} else if (char === ']' || char === '}') {
			depth -= 1;
		}
	}
	return depth;
}

function parseTomlPath(value: string): readonly string[] {
	return splitTopLevel(value, '.').map(segment => parseTomlKey(segment.trim()));
}

function parseTomlKey(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return JSON.parse(value) as string;
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}

function parseTomlValue(value: string): unknown {
	if (value.startsWith('"') && value.endsWith('"')) {
		return JSON.parse(value) as unknown;
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	if (value === 'true' || value === 'false') {
		return value === 'true';
	}
	if (value.startsWith('[') && value.endsWith(']')) {
		const body = value.slice(1, -1).trim();
		return body.length === 0
			? []
			: splitTopLevel(body, ',')
				.map(item => item.trim())
				.filter(item => item.length > 0)
				.map(item => parseTomlValue(item));
	}
	if (value.startsWith('{') && value.endsWith('}')) {
		const body = value.slice(1, -1).trim();
		const record: Record<string, unknown> = {};
		if (body.length === 0) {
			return record;
		}
		for (const entry of splitTopLevel(body, ',')
			.map(item => item.trim())
			.filter(item => item.length > 0)) {
			const separator = findTopLevel(entry, '=');
			if (separator < 0) {
				throw new Error('Invalid TOML inline table.');
			}
			record[parseTomlKey(entry.slice(0, separator).trim())] = parseTomlValue(
				entry.slice(separator + 1).trim(),
			);
		}
		return record;
	}
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		return Number(value);
	}
	throw new Error(`Unsupported TOML value: ${value}`);
}

function splitTopLevel(value: string, separator: string): readonly string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = quote === undefined ? char : quote === char ? undefined : quote;
			continue;
		}
		if (quote !== undefined) {
			continue;
		}
		if (char === '[' || char === '{') {
			depth += 1;
		} else if (char === ']' || char === '}') {
			depth -= 1;
		} else if (char === separator && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

function findTopLevel(value: string, separator: string): number {
	const parts = splitTopLevel(value, separator);
	return parts.length === 1 ? -1 : parts[0]?.length ?? -1;
}

function readOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new Error(`${field} must be a string.`);
	}
	return value;
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new Error(`${field} must be a boolean.`);
	}
	return value;
}

function readStringArray(value: unknown, field: string): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
		throw new Error(`${field} must be an array of strings.`);
	}
	return value;
}

function readEntries(value: unknown, field: string): readonly McpEntry[] {
	if (value === undefined) {
		return [];
	}
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object.`);
	}
	return Object.entries(value).map(([name, entryValue]) => {
		if (typeof entryValue !== 'string') {
			throw new Error(`${field} values must be strings.`);
		}
		return { name, value: entryValue };
	});
}

function requireTomlString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`MCP ${field} must be a string.`);
	}
	return value;
}

function requireTomlBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`MCP ${field} must be a boolean.`);
	}
	return value;
}

function requireTomlStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
		throw new Error(`MCP ${field} must be an array of strings.`);
	}
	return value;
}

function requireTomlEntries(value: unknown, field: string): readonly McpEntry[] {
	if (!isRecord(value)) {
		throw new Error(`MCP ${field} must be a table.`);
	}
	return Object.entries(value).map(([name, entryValue]) => ({
		name,
		value: requireTomlString(entryValue, `${field}.${name}`),
	}));
}
