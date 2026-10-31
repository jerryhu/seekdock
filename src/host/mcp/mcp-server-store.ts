import { randomUUID } from 'node:crypto';
import {
	readFile,
	mkdir,
	rename,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	isMcpServer,
	validateMcpServer,
	type McpImportResult,
	type McpImportSource,
	type McpImportSourceId,
	type McpServer,
	type McpValidationIssue,
} from '../../shared/mcp-servers.ts';
import { isRecord } from '../../shared/value-validation.ts';
import {
	invalidMcpImportSource,
	missingMcpImportSource,
	parseMcpImport,
	parseMcpImportServers,
	selectImportedMcpServers,
} from './mcp-importers.ts';
import {
	buildMcpRuntimePatch,
	resolveMcpRuntimeSecrets,
} from './mcp-runtime-patch.ts';

const SERVERS_FILE_VERSION = 1;
const IMPORT_SOURCE_IDS: readonly McpImportSourceId[] = [
	'vscode',
	'codex',
	'claude',
	'cursor',
];

/** Generated runtime environment for enabled MCP servers. */
export interface McpRuntimeEnvironment {
	patchPath: string;
	env: Readonly<Record<string, string>>;
}

/** A configuration or persistence failure with a host-localizable code. */
export class McpServerStoreError extends Error {
	constructor(
		readonly code:
			| 'duplicateName'
			| 'invalidServer'
			| 'notFound'
			| 'missingSecret'
			| 'invalidFile',
		readonly detail?: string,
		readonly issues?: readonly McpValidationIssue[],
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = 'McpServerStoreError';
	}
}

/** Persists MCP declarations and projects enabled rows into a DSH patch. */
export class McpServerStore {
	readonly serversPath: string;
	readonly patchPath: string;
	private operation: Promise<void> = Promise.resolve();

	constructor(
		dataRootPath: string,
		private readonly getWorkspaceRoot: () => string,
		private readonly getHomePath: () => string = homedir,
	) {
		const directory = join(dataRootPath, 'mcp');
		this.serversPath = join(directory, 'servers.json');
		this.patchPath = join(directory, 'dsh.patch.yml');
	}

	/** @returns the complete persisted list in stable order. */
	async list(): Promise<readonly McpServer[]> {
		await this.operation;
		return this.readServers();
	}

	/**
	 * Add or replace one manually authored server.
	 *
	 * @param server - validated candidate.
	 * @param previousServerName - old key when renaming an existing server.
	 */
	async save(server: McpServer, previousServerName?: string): Promise<void> {
		await this.mutate(async (servers) => {
			const issues = validateMcpServer(server);
			if (issues.length > 0) {
				throw new McpServerStoreError('invalidServer', undefined, issues);
			}
			const withoutPrevious = servers.filter(item => (
				item.serverName !== server.serverName
				&& item.serverName !== previousServerName
			));
			if (servers.some(item => (
				item.serverName === server.serverName
				&& item.serverName !== previousServerName
			))) {
				throw new McpServerStoreError('duplicateName', server.serverName);
			}
			return [...withoutPrevious, server];
		});
	}

	/** Enable or disable one existing server without changing its remaining fields. */
	async setEnabled(serverName: string, enabled: boolean): Promise<void> {
		await this.mutate(async (servers) => {
			const index = servers.findIndex(server => server.serverName === serverName);
			if (index < 0) {
				throw new McpServerStoreError('notFound', serverName);
			}
			return servers.map((server, current) => (
				current === index ? { ...server, enabled } : server
			));
		});
	}

	/** Delete one persisted server. */
	async remove(serverName: string): Promise<void> {
		await this.mutate(async (servers) => {
			if (!servers.some(server => server.serverName === serverName)) {
				throw new McpServerStoreError('notFound', serverName);
			}
			return servers.filter(server => server.serverName !== serverName);
		});
	}

	/** @returns metadata-only previews for all supported read-only sources. */
	async importSources(): Promise<readonly McpImportSource[]> {
		const paths = this.importPaths();
		return Promise.all(IMPORT_SOURCE_IDS.map(async id => {
			const path = paths[id];
			let text: string;
			try {
				text = await readFile(path, 'utf8');
			} catch (error) {
				if (isMissingFileError(error)) {
					return missingMcpImportSource(id, path);
				}
				console.error(`SeekDock: failed to read MCP import source ${path}`, error);
				return invalidMcpImportSource(id, path);
			}
			try {
				return parseMcpImport(id, path, text);
			} catch {
				// Parser errors can quote configuration values, so log only the source.
				console.error(`SeekDock: failed to parse MCP import source ${path}`);
				return invalidMcpImportSource(id, path);
			}
		}));
	}

	/**
	 * Re-read a source and return selected declarations before persistence.
	 *
	 * @param sourceId - source selected in the settings UI.
	 * @param originalNames - original server names selected from the preview.
	 */
	async selectForImport(
		sourceId: McpImportSourceId,
		originalNames: readonly string[],
	): Promise<readonly McpServer[]> {
		const text = await readFile(this.importPaths()[sourceId], 'utf8');
		return selectImportedMcpServers(
			parseMcpImportServers(sourceId, text),
			originalNames,
		);
	}

	/** Persist selected imported servers, skipping names that already exist. */
	async addImported(servers: readonly McpServer[]): Promise<McpImportResult> {
		let imported = 0;
		let skipped = 0;
		await this.mutate(async (current) => {
			const names = new Set(current.map(server => server.serverName));
			const next = [...current];
			for (const server of servers) {
				if (names.has(server.serverName)) {
					skipped += 1;
					continue;
				}
				names.add(server.serverName);
				next.push(server);
				imported += 1;
			}
			return next;
		});
		return { imported, skipped };
	}

	/**
	 * Write the DSH patch for currently enabled servers and resolve its secrets
	 * into child-process environment entries.
	 *
	 * @param readSecret - VS Code SecretStorage lookup.
	 * @returns patch path plus secret environment entries.
	 */
	async writeRuntimePatch(
		readSecret: (name: string) => PromiseLike<string | undefined>,
	): Promise<McpRuntimeEnvironment> {
		await this.operation;
		const patch = buildMcpRuntimePatch(await this.readServers(), this.getWorkspaceRoot());
		let env: Readonly<Record<string, string>>;
		try {
			env = await resolveMcpRuntimeSecrets(patch.secretNames, readSecret);
		} catch (error) {
			const name = error instanceof Error
				? error.message.replace('MCP secret is not configured: ', '')
				: 'unknown';
			throw new McpServerStoreError('missingSecret', name, undefined, { cause: error });
		}
		await writeAtomic(this.patchPath, patch.yaml);
		return { patchPath: this.patchPath, env };
	}

	private async mutate(
		update: (servers: readonly McpServer[]) => Promise<readonly McpServer[]>,
	): Promise<void> {
		const task = this.operation.then(async () => {
			const next = await update(await this.readServers());
			await this.writeServers(next);
		});
		this.operation = task.catch(() => undefined);
		await task;
	}

	private async readServers(): Promise<readonly McpServer[]> {
		let text: string;
		try {
			text = await readFile(this.serversPath, 'utf8');
		} catch (error) {
			if (isMissingFileError(error)) {
				return [];
			}
			throw new McpServerStoreError('invalidFile', this.serversPath, undefined, {
				cause: error,
			});
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new McpServerStoreError('invalidFile', this.serversPath, undefined, {
				cause: error,
			});
		}
		if (!isRecord(value)
			|| value.version !== SERVERS_FILE_VERSION
			|| !Array.isArray(value.servers)
			|| !value.servers.every(server => isPersistedMcpServer(server))) {
			throw new McpServerStoreError('invalidFile', this.serversPath);
		}
		return value.servers;
	}

	private async writeServers(servers: readonly McpServer[]): Promise<void> {
		await writeAtomic(
			this.serversPath,
			`${JSON.stringify({
				version: SERVERS_FILE_VERSION,
				servers,
			}, null, 2)}\n`,
		);
	}

	private importPaths(): Readonly<Record<McpImportSourceId, string>> {
		const home = this.getHomePath();
		return {
			vscode: join(this.getWorkspaceRoot(), '.vscode', 'mcp.json'),
			codex: join(home, '.codex', 'config.toml'),
			claude: join(home, '.claude.json'),
			cursor: join(home, '.cursor', 'mcp.json'),
		};
	}
}

/** @returns the SecretStorage key owned by one `${secret:name}` MCP variable. */
export function mcpSecretStorageKey(name: string): string {
	return `seekdock.mcpSecret.${name}`;
}

function isPersistedMcpServer(value: unknown): value is McpServer {
	return isMcpServer(value);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, contents, {
		encoding: 'utf8',
		mode: 0o600,
	});
	await rename(temporaryPath, path);
}

function isMissingFileError(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT';
}
