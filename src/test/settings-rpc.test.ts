import * as assert from 'node:assert';
import {
	isHostToSettingsMessage,
	isSettingsToHostMessage,
} from '../shared/settings-rpc.ts';

suite('Settings RPC contract', () => {
	test('accepts settings requests and rejects malformed operations', () => {
		assert.ok(isSettingsToHostMessage({ type: 'ready' }));
		assert.ok(isSettingsToHostMessage({
			type: 'saveApiKey',
			requestId: 'key-1',
			apiKey: 'sk-test',
		}));
		assert.ok(isSettingsToHostMessage({
			type: 'setSkillEnabled',
			requestId: 'skill-1',
			name: 'pdf',
			enabled: false,
		}));
		assert.ok(isSettingsToHostMessage({
			type: 'setLanguage',
			requestId: 'language-1',
			language: 'ja',
		}));
		assert.ok(isSettingsToHostMessage({
			type: 'saveMcpServer',
			requestId: 'mcp-1',
			previousServerName: 'old',
			server: {
				serverName: 'local',
				transport: 'stdio',
				enabled: true,
				command: 'node',
				args: ['server.js'],
				env: [],
			},
			secrets: { token: 'shh' },
		}));
		assert.ok(isSettingsToHostMessage({
			type: 'requestMcpImportSources',
			requestId: 'mcp-import-1',
		}));
		// Candidate values reach the host so it can return a localized validation error.
		assert.ok(isSettingsToHostMessage({
			type: 'saveMcpServer',
			requestId: 'mcp-invalid-1',
			server: {
				serverName: 'bad name',
				transport: 'stdio',
				enabled: true,
				command: '',
				args: [],
				env: [],
			},
			secrets: {},
		}));
		assert.ok(!isSettingsToHostMessage({
			type: 'setLanguage',
			requestId: 'language-1',
			language: 'it',
		}));
		assert.ok(!isSettingsToHostMessage({
			type: 'setSkillEnabled',
			requestId: 'skill-1',
			name: 'pdf',
			enabled: 'no',
		}));
		assert.ok(!isSettingsToHostMessage({ type: 'saveApiKey', requestId: '', apiKey: '' }));
		assert.ok(!isSettingsToHostMessage({ type: 'unknown' }));
	});

	test('accepts state, saved, catalog, and error responses', () => {
		assert.ok(isHostToSettingsMessage({
			type: 'state',
			state: {
				hasApiKey: true,
				busy: false,
				systemPrompt: 'You are SeekDock.',
				systemPromptIsDefault: true,
				runtimeStatus: 'ready',
				language: 'zh-cn',
			},
		}));
		assert.ok(!isHostToSettingsMessage({
			type: 'state',
			state: {
				hasApiKey: true,
				busy: false,
				systemPrompt: 'You are SeekDock.',
				systemPromptIsDefault: true,
				runtimeStatus: 'ready',
				language: 'it',
			},
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'saved',
			requestId: 'skill-1',
			kind: 'skill',
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'skillCatalog',
			requestId: 'skills-1',
			roots: {
				workspace: '/workspace/.agents/skills',
				user: '/Users/test/.agents/skills',
			},
			skills: [{
				name: 'pdf',
				description: 'Read and create PDF files',
				source: 'user',
				enabled: false,
			}],
		}));
		assert.ok(!isHostToSettingsMessage({
			type: 'skillCatalog',
			requestId: 'skills-1',
			roots: {
				workspace: '',
				user: '/Users/test/.agents/skills',
			},
			skills: [],
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'error',
			requestId: 'settings-1',
			message: 'failed',
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'mcpServers',
			requestId: 'mcp-1',
			path: '/storage/mcp/servers.json',
			servers: [{
				serverName: 'local',
				transport: 'http',
				enabled: true,
				url: 'https://example.com/mcp',
				headers: [{ name: 'Authorization', value: '${secret:token}' }],
			}],
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'mcpImportSources',
			requestId: 'mcp-import-1',
			sources: [{
				id: 'vscode',
				path: '/workspace/.vscode/mcp.json',
				available: true,
				servers: [{
					originalName: 'My Server',
					serverName: 'My_Server_c2d9a82f',
					transport: 'stdio',
					secretNames: [],
				}],
			}],
		}));
		assert.ok(isHostToSettingsMessage({
			type: 'mcpImported',
			requestId: 'mcp-import-2',
			result: { imported: 1, skipped: 0 },
		}));
	});
});
