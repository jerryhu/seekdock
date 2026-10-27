import * as assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	collectMcpSecretNames,
	validateMcpServer,
	type McpServer,
} from '../shared/mcp-servers.ts';
import {
	normalizeImportedServerName,
	parseMcpImport,
	parseMcpImportServers,
} from '../host/mcp/mcp-importers.ts';
import { buildMcpRuntimePatch } from '../host/mcp/mcp-runtime-patch.ts';
import {
	McpServerStore,
	McpServerStoreError,
} from '../host/mcp/mcp-server-store.ts';

suite('MCP server configuration', () => {
	test('normalizes imported names with the DSH ACP slug and hash strategy', () => {
		assert.strictEqual(normalizeImportedServerName('github'), 'github');
		assert.strictEqual(
			normalizeImportedServerName('My Server'),
			'My_Server_c2d9a82f',
		);
		assert.match(
			normalizeImportedServerName('a name that is deliberately much too long'),
			/^a_name_that_is_delib_3fc3716c$/,
		);
	});

	test('only allows workspaceFolder and secret variables', () => {
		const server = stdioServer({
			command: '${workspaceFolder}/tools/server',
			args: ['--token=${secret:githubToken}'],
		});
		assert.deepStrictEqual(validateMcpServer(server), []);

		assert.deepStrictEqual(
			validateMcpServer(stdioServer({ args: ['${env:GITHUB_TOKEN}'] })),
			[{ code: 'unsupportedVariable', detail: '${env:GITHUB_TOKEN}' }],
		);
		assert.deepStrictEqual(
			validateMcpServer(stdioServer({ args: ['${input:token'] })),
			[{ code: 'unsupportedVariable', detail: '${input:token' }],
		);
		assert.deepStrictEqual(
			validateMcpServer(stdioServer({ args: ['${secret:${nested}}'] })),
			[{ code: 'unsupportedVariable', detail: '${secret:${nested}' }],
		);
	});

	test('requires DSH-safe manually authored names', () => {
		const issues = validateMcpServer(stdioServer({ serverName: 'bad name' }));
		assert.deepStrictEqual(issues, [{ code: 'nameInvalid' }]);
	});

	test('collects unique secret names across command, arguments, environment, and headers', () => {
		assert.deepStrictEqual(
			collectMcpSecretNames(stdioServer({
				command: '${secret:commandSecret}',
				args: ['${secret:token}', '${secret:token}'],
				env: [{ name: 'API_TOKEN', value: '${secret:envToken}' }],
			})),
			['commandSecret', 'envToken', 'token'],
		);
	});

	test('builds a runtime patch that references secrets through process env', () => {
		const patch = buildMcpRuntimePatch(
			[
				stdioServer({
					serverName: 'local',
					command: 'node',
					args: ['server.js'],
					cwd: '${workspaceFolder}',
					env: [{ name: 'TOKEN', value: 'Bearer ${secret:token}' }],
				}),
				{
					serverName: 'remote',
					transport: 'http',
					enabled: true,
					url: 'https://example.com/mcp',
					headers: [{ name: 'Authorization', value: '${secret:token}' }],
				},
				stdioServer({ serverName: 'disabled', enabled: false }),
			],
			'/workspace/project',
		);

		assert.deepStrictEqual(patch.secretNames, ['token']);
		assert.match(patch.yaml, /name: "@deepseek-ai\/dsh-mcp-client"/);
		assert.match(patch.yaml, /serverName: "local"/);
		assert.match(patch.yaml, /url: "https:\/\/example\.com\/mcp"/);
		assert.match(patch.yaml, /!!js/);
		assert.match(patch.yaml, /cwd: "\/workspace\/project"/);
		assert.doesNotMatch(patch.yaml, /serverName: "disabled"/);
	});

	test('imports VS Code HTTP and reports SSE as unsupported', () => {
		const source = parseMcpImport(
			'vscode',
			'/workspace/.vscode/mcp.json',
			JSON.stringify({
				servers: {
					'My Server': {
						type: 'http',
						url: 'https://example.com/mcp',
						headers: {
							Authorization: 'Bearer ${secret:token}',
						},
					},
					legacy: {
						type: 'sse',
						url: 'https://example.com/sse',
					},
				},
			}),
		);

		assert.deepStrictEqual(source.servers[0], {
			originalName: 'My Server',
			serverName: 'My_Server_c2d9a82f',
			transport: 'http',
			secretNames: ['token'],
		});
		assert.deepStrictEqual(source.servers[1], {
			originalName: 'legacy',
			serverName: 'legacy',
			secretNames: [],
			error: { code: 'unsupportedTransport', detail: 'sse' },
		});
	});

	test('imports Codex TOML stdio and bearer-token HTTP declarations', () => {
		const source = parseMcpImport(
			'codex',
			'/Users/test/.codex/config.toml',
			`
[mcp_servers.local]
command = "node"
args = ["server.js", "--verbose",]
cwd = "\${workspaceFolder}"
enabled = false
env = { TOKEN = "\${secret:localToken}" }

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
env_http_headers = { "X-Trace" = "TRACE_TOKEN" }
`,
		);

		assert.deepStrictEqual(source.servers.map(server => server.serverName), [
			'local',
			'remote',
		]);
		assert.deepStrictEqual(source.servers[0]?.secretNames, ['localToken']);
		assert.deepStrictEqual(source.servers[1]?.secretNames, ['REMOTE_TOKEN', 'TRACE_TOKEN']);
		assert.strictEqual(source.servers[1]?.transport, 'http');
		const parsed = parseMcpImportServers('codex', `
[mcp_servers.local]
command = "node"
`);
		assert.strictEqual(parsed.servers[0]?.serverName, 'local');
		assert.strictEqual(parsed.servers[0]?.originalName, 'local');
	});

	test('persists servers in globalStorage and keeps secret values out of the runtime patch', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-mcp-'));
		try {
			const store = new McpServerStore(root, () => '/workspace/project', () => '/home/test');
			await store.save({
				serverName: 'remote',
				transport: 'http',
				enabled: true,
				url: 'https://example.com/mcp',
				headers: [{ name: 'Authorization', value: '${secret:token}' }],
			});

			assert.strictEqual(
				store.serversPath,
				join(root, 'mcp', 'servers.json'),
			);
			const stored = JSON.parse(await readFile(store.serversPath, 'utf8')) as {
				version: number;
				servers: unknown[];
			};
			assert.strictEqual(stored.version, 1);
			assert.strictEqual(stored.servers.length, 1);

			const runtime = await store.writeRuntimePatch(async name => (
				name === 'token' ? 'secret-value' : undefined
			));
			const patch = await readFile(runtime.patchPath, 'utf8');
			assert.ok(Object.values(runtime.env).includes('secret-value'));
			assert.match(patch, /dsh-mcp-client/);
			assert.doesNotMatch(patch, /secret-value/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('rejects duplicate MCP server names at the persistence boundary', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-mcp-'));
		try {
			const store = new McpServerStore(root, () => '/workspace/project');
			await store.save(stdioServer({ serverName: 'duplicate' }));
			await assert.rejects(
				store.save(stdioServer({ serverName: 'duplicate' })),
				(error: unknown) => error instanceof McpServerStoreError
					&& error.code === 'duplicateName',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function stdioServer(overrides: Partial<{
	serverName: string;
	enabled: boolean;
	command: string;
	args: string[];
	env: { name: string; value: string }[];
	cwd: string;
}> = {}): McpServer {
	return {
		serverName: overrides.serverName ?? 'local',
		transport: 'stdio',
		enabled: overrides.enabled ?? true,
		command: overrides.command ?? 'node',
		args: overrides.args ?? [],
		env: overrides.env ?? [],
		...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
	};
}
