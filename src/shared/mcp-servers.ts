import { isRecord } from './value-validation.ts';

/** DSH MCP server namespace contract for model-facing tool names. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Workspace-root placeholder supported in MCP command, path, environment, and header values. */
export const WORKSPACE_FOLDER_VARIABLE = '${workspaceFolder}';
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** @returns whether a value is a supported explicitly named MCP transport. */
export function isMcpTransport(value: unknown): value is McpTransport {
	return value === 'stdio' || value === 'http';
}

/** @returns whether a value identifies a supported read-only import source. */
export function isMcpImportSourceId(value: unknown): value is McpImportSourceId {
	return value === 'vscode'
		|| value === 'codex'
		|| value === 'claude'
		|| value === 'cursor';
}

/** Transport supported by SeekDock's DSH MCP runtime. */
export type McpTransport = 'stdio' | 'http';

/** One ordered environment variable or HTTP header. */
export interface McpEntry {
	name: string;
	value: string;
}

interface McpServerBase {
	serverName: string;
	enabled: boolean;
	/** Original external name retained when import normalization changed it. */
	originalName?: string;
	/** Read-only configuration source used for import provenance. */
	importedFrom?: McpImportSourceId;
}

/** Local MCP process connected through stdio. */
export interface McpStdioServer extends McpServerBase {
	transport: 'stdio';
	command: string;
	args: readonly string[];
	env: readonly McpEntry[];
	/** Missing uses the active workspace root at runtime. */
	cwd?: string;
}

/** Remote MCP service connected through DSH's streamable HTTP transport. */
export interface McpHttpServer extends McpServerBase {
	transport: 'http';
	url: string;
	headers: readonly McpEntry[];
}

export type McpServer = McpStdioServer | McpHttpServer;

export type McpImportSourceId = 'vscode' | 'codex' | 'claude' | 'cursor';

export type McpValidationCode =
	| 'nameRequired'
	| 'nameInvalid'
	| 'commandRequired'
	| 'urlRequired'
	| 'urlInvalid'
	| 'entryNameRequired'
	| 'entryNameDuplicate'
	| 'entryNameInvalid'
	| 'unsupportedVariable';

/** A model validation failure that can be rendered by either side of the RPC boundary. */
export interface McpValidationIssue {
	code: McpValidationCode;
	/** Invalid variable text or duplicate entry name, when applicable. */
	detail?: string;
	/** Collection containing an invalid entry. */
	field?: 'env' | 'headers';
}

/** One server available in an external, read-only import source. */
export interface McpImportServerPreview {
	originalName: string;
	serverName: string;
	transport?: McpTransport;
	secretNames: readonly string[];
	error?: {
		code: McpImportErrorCode;
		detail?: string;
	};
}

export type McpImportErrorCode =
	| 'invalidConfiguration'
	| 'invalidName'
	| 'duplicateName'
	| 'unsupportedTransport'
	| 'unsupportedVariable';

/** Parsed preview of one supported MCP configuration source. */
export interface McpImportSource {
	id: McpImportSourceId;
	path: string;
	available: boolean;
	servers: readonly McpImportServerPreview[];
	error?: McpImportErrorCode;
}

/** Result of importing selected servers from one source. */
export interface McpImportResult {
	imported: number;
	skipped: number;
}

/**
 * Validate one MCP declaration before persistence or runtime projection.
 *
 * @param server - candidate configuration.
 * @returns all independently actionable validation failures.
 */
export function validateMcpServer(server: McpServer): readonly McpValidationIssue[] {
	const issues: McpValidationIssue[] = [];
	if (server.serverName.length === 0) {
		issues.push({ code: 'nameRequired' });
	} else if (!MCP_SERVER_NAME_PATTERN.test(server.serverName)) {
		issues.push({ code: 'nameInvalid' });
	}

	if (server.transport === 'stdio') {
		if (server.command.trim().length === 0) {
			issues.push({ code: 'commandRequired' });
		}
		for (const value of mcpServerValues(server)) {
			issues.push(...validateMcpVariables(value));
		}
		issues.push(...validateEntries(server.env, 'env', false));
		return issues;
	}

	if (server.url.trim().length === 0) {
		issues.push({ code: 'urlRequired' });
	} else if (!isHttpUrlTemplate(server.url)) {
		issues.push({ code: 'urlInvalid' });
	}
	for (const value of mcpServerValues(server)) {
		issues.push(...validateMcpVariables(value));
	}
	issues.push(...validateEntries(server.headers, 'headers', true));
	return issues;
}

/**
 * Validate the only variable forms supported by SeekDock MCP declarations.
 *
 * @param value - arbitrary command, argument, path, URL, environment, or header value.
 * @returns unsupported or malformed variable occurrences.
 */
export function validateMcpVariables(value: string): readonly McpValidationIssue[] {
	const issues: McpValidationIssue[] = [];
	let cursor = 0;
	while (cursor < value.length) {
		const start = value.indexOf('${', cursor);
		if (start < 0) {
			break;
		}
		const end = value.indexOf('}', start + 2);
		if (end < 0) {
			issues.push({
				code: 'unsupportedVariable',
				detail: value.slice(start),
			});
			break;
		}
		const token = value.slice(start, end + 1);
		if (token !== WORKSPACE_FOLDER_VARIABLE && !isSecretVariable(token)) {
			issues.push({ code: 'unsupportedVariable', detail: token });
		}
		cursor = end + 1;
	}
	return issues;
}

/**
 * Collect every SecretStorage key referenced by an MCP server.
 *
 * @param server - validated or candidate MCP declaration.
 * @returns sorted unique secret names.
 */
export function collectMcpSecretNames(server: McpServer): readonly string[] {
	const names = new Set<string>();
	for (const value of mcpServerValues(server)) {
		for (const match of value.matchAll(/\$\{secret:([^}]+)\}/g)) {
			const name = match[1];
			if (name !== undefined && name.length > 0) {
				names.add(name);
			}
		}
	}
	return [...names].sort();
}

/** @returns whether a value has the complete MCP server shape without validating values. */
export function isMcpServerShape(value: unknown): value is McpServer {
	if (!isRecord(value)
		|| typeof value.serverName !== 'string'
		|| typeof value.enabled !== 'boolean'
		|| !isMcpTransport(value.transport)
		|| (value.originalName !== undefined && typeof value.originalName !== 'string')
		|| (value.importedFrom !== undefined && !isMcpImportSourceId(value.importedFrom))) {
		return false;
	}
	if (value.transport === 'stdio') {
		if (!(typeof value.command === 'string'
			&& isStringArray(value.args)
			&& isMcpEntries(value.env)
			&& (value.cwd === undefined || typeof value.cwd === 'string'))) {
			return false;
		}
		return true;
	}
	return typeof value.url === 'string' && isMcpEntries(value.headers);
}

/** @returns whether a value is a complete and DSH-valid MCP server. */
export function isMcpServer(value: unknown): value is McpServer {
	return isMcpServerShape(value) && validateMcpServer(value).length === 0;
}

/** @returns every user-controlled string that may contain supported variables. */
export function mcpServerValues(server: McpServer): readonly string[] {
	if (server.transport === 'stdio') {
		return [
			server.command,
			...server.args,
			...(server.cwd === undefined ? [] : [server.cwd]),
			...server.env.map(entry => entry.value),
		];
	}
	return [server.url, ...server.headers.map(entry => entry.value)];
}

function validateEntries(
	entries: readonly McpEntry[],
	field: 'env' | 'headers',
	isHeader: boolean,
): readonly McpValidationIssue[] {
	const issues: McpValidationIssue[] = [];
	const names = new Set<string>();
	for (const entry of entries) {
		if (entry.name.length === 0) {
			issues.push({ code: 'entryNameRequired', field });
			continue;
		}
		const identity = isHeader ? entry.name.toLowerCase() : entry.name;
		if (names.has(identity)) {
			issues.push({ code: 'entryNameDuplicate', field, detail: entry.name });
		}
		names.add(identity);
		if ((isHeader && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.name))
			|| (!isHeader && /[=\0]/.test(entry.name))) {
			issues.push({ code: 'entryNameInvalid', field, detail: entry.name });
		}
	}
	return issues;
}

function isHttpUrlTemplate(value: string): boolean {
	if (!value.startsWith('http://') && !value.startsWith('https://')) {
		return false;
	}
	try {
		new URL(value.replaceAll(/\$\{[^}]+\}/g, 'placeholder'));
		return true;
	} catch {
		return false;
	}
}

function isSecretVariable(value: string): boolean {
	const match = /^\$\{secret:([^}]+)\}$/.exec(value);
	return match?.[1] !== undefined && SECRET_NAME_PATTERN.test(match[1]);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isMcpEntries(value: unknown): value is readonly McpEntry[] {
	return Array.isArray(value)
		&& value.every(entry => isRecord(entry)
			&& typeof entry.name === 'string'
			&& typeof entry.value === 'string');
}
