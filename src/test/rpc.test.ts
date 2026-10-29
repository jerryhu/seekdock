import * as assert from 'node:assert';
import {
	isHostToWebviewMessage,
	isWebviewToHostMessage,
} from '../shared/rpc.ts';

suite('RPC contract', () => {
	test('accepts Webview requests and rejects malformed messages', () => {
		assert.ok(isWebviewToHostMessage({
			type: 'chat',
			requestId: 'request-1',
			text: 'hello',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'cancel',
			requestId: 'cancel-1',
			targetRequestId: 'request-1',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'chat',
			requestId: '',
			text: 'hello',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'openExternal',
			requestId: 'request-2',
			url: 'https://example.com',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'saveSystemPrompt',
			requestId: 'request-3',
			prompt: 'You are SeekDock.',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'resetSystemPrompt',
			requestId: 'request-4',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'retryRuntime',
			requestId: 'request-4-retry',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'openSettings',
			requestId: 'request-settings',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'openSettings',
			requestId: '',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'newChat',
			requestId: 'request-5',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'requestSessionHistory',
			requestId: 'request-6',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'requestSkills',
			requestId: 'request-6-skills',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'openSkill',
			requestId: 'request-6-open-skill',
			name: 'pdf',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'openSkill',
			requestId: 'request-6-open-skill',
			name: '',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'loadSession',
			requestId: 'request-7',
			sessionId: 'seekdock-session',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'deleteSession',
			requestId: 'request-8',
			sessionId: 'seekdock-session',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'renameSession',
			requestId: 'request-8-rename',
			sessionId: 'seekdock-session',
			title: 'Renamed session',
		}));
		assert.ok(!isWebviewToHostMessage({ type: 'unknown' }));
		assert.ok(!isWebviewToHostMessage({
			type: 'cancel',
			requestId: 'cancel-1',
			targetRequestId: '',
		}));
		assert.ok(!isWebviewToHostMessage({ type: 'openExternal', requestId: '', url: '' }));
		assert.ok(!isWebviewToHostMessage({ type: 'saveSystemPrompt', requestId: '', prompt: 'x' }));
		assert.ok(!isWebviewToHostMessage({ type: 'saveSystemPrompt', requestId: 'request-3', prompt: 1 }));
		assert.ok(!isWebviewToHostMessage({ type: 'loadSession', requestId: 'request-7', sessionId: '' }));
		assert.ok(!isWebviewToHostMessage({ type: 'deleteSession', requestId: 'request-8', sessionId: '' }));
		assert.ok(!isWebviewToHostMessage({
			type: 'renameSession',
			requestId: 'request-8-rename',
			sessionId: '',
			title: 'Renamed session',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'renameSession',
			requestId: 'request-8-rename',
			sessionId: 'seekdock-session',
			title: 1,
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'setPermission',
			requestId: 'request-9',
			preset: 'auto',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'setPermission',
			requestId: 'request-9',
			preset: '',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'setPlanMode',
			requestId: 'request-9-plan',
			active: true,
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'setPlanMode',
			requestId: 'request-9-plan',
			active: 'yes',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'pickFiles',
			requestId: 'request-9-files',
		}));
		assert.ok(!isWebviewToHostMessage({ type: 'pickFiles', requestId: '' }));
		assert.ok(isWebviewToHostMessage({
			type: 'setModelSelection',
			requestId: 'request-9-model',
			model: 'deepseek-flash',
			reasoningEffort: 'low',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'setModelSelection',
			requestId: 'request-9-model',
			model: '',
			reasoningEffort: 'low',
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'approvalResponse',
			requestId: 'request-10',
			approvalId: 'approval-1',
			toolCallId: 'call-1',
			decision: 'allow',
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'approvalResponse',
			requestId: 'request-10',
			approvalId: 'approval-1',
			decision: 'maybe',
		}));
	});

	test('accepts API key errors and the typed response event stream', () => {
		assert.ok(isHostToWebviewMessage({ type: 'apiKeyError', message: 'invalid' }));
		assert.ok(isHostToWebviewMessage({
			type: 'state',
			hasApiKey: true,
			busy: false,
			systemPrompt: 'You are SeekDock.',
			systemPromptIsDefault: true,
			runtimeStatus: 'ready',
			activeSessionId: 'seekdock-session',
			modelSelection: { model: 'deepseek-flash', reasoningEffort: 'low' },
			language: 'zh-cn',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'state',
			hasApiKey: true,
			busy: false,
			systemPrompt: 'You are SeekDock.',
			systemPromptIsDefault: true,
			runtimeStatus: 'error',
			runtimeError: 'failed to start',
			modelSelection: { model: 'deepseek-v4-pro', reasoningEffort: 'max' },
			language: 'en',
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'state',
			hasApiKey: true,
			busy: false,
			systemPrompt: 'You are SeekDock.',
			systemPromptIsDefault: true,
			runtimeStatus: 'ready',
			modelSelection: { model: 'deepseek-flash', reasoningEffort: 'low' },
			language: 'it',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'systemPromptSaved',
			requestId: 'prompt-1',
			isDefault: false,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'systemPromptError',
			requestId: 'prompt-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionHistory',
			total: 1,
			activeSessionId: 'seekdock-session',
			sessions: [{
				id: 'seekdock-session',
				title: 'Session title',
				createdAt: 1,
				updatedAt: 2,
				messageCount: 1,
			}],
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'skillCatalog',
			requestId: 'skills-1',
			skills: [{
				name: 'pdf',
				description: 'Read and create PDF files',
				source: 'user',
			}],
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'skillCatalog',
			requestId: 'skills-1',
			skills: [{
				name: 'pdf',
				description: 'Read and create PDF files',
				source: 'unknown',
			}],
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'skillCatalogError',
			requestId: 'skills-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'skillOpenError',
			requestId: 'skill-open-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionLoaded',
			requestId: 'load-1',
			sessionId: 'seekdock-session',
			title: 'Session title',
			messages: [{
				kind: 'user',
				id: 'user-1',
				text: 'hello',
				createdAt: 1,
			}, {
				kind: 'assistant',
				id: 'assistant-1',
				createdAt: 2,
				durationMs: 1_500,
				entries: [{
					kind: 'text',
					id: 'text-1',
					text: 'hi',
				}],
				changes: {
					sessionId: 'seekdock-session',
					seq: 7,
					turn: 1,
					files: [{
						path: 'src/app.ts',
						display: 'src/app.ts',
						added: 1,
						deleted: 1,
					}],
					total: 1,
					added: 1,
					deleted: 1,
				},
			}],
		}));
			assert.ok(!isHostToWebviewMessage({
				type: 'sessionLoaded',
				requestId: 'load-1',
				sessionId: 'seekdock-session',
				title: 'Session title',
				messages: [{
					kind: 'assistant',
					id: 'assistant-1',
					createdAt: 2,
					durationMs: -1,
					entries: [],
				}],
			}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionLoadError',
			requestId: 'load-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionHistoryError',
			requestId: 'history-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionDeleted',
			requestId: 'delete-1',
			sessionId: 'seekdock-session',
			wasActive: true,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionDeleteError',
			requestId: 'delete-1',
			message: 'failed',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionRenamed',
			requestId: 'rename-1',
			sessionId: 'seekdock-session',
			title: 'Renamed session',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'sessionRenameError',
			requestId: 'rename-1',
			message: 'failed',
		}));
		const stream = [
			{ type: 'responseStart', requestId: 'request-1' },
			{
				type: 'assistantStreamStart',
				requestId: 'request-1',
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
			},
			{
				type: 'assistantStreamDelta',
				requestId: 'request-1',
				deltas: [{
					attemptId: 'attempt-1',
					turn: 1,
					step: 1,
					blockIndex: 0,
					kind: 'reasoning',
					text: 'thinking',
				}],
			},
			{ type: 'assistantStreamEnd', requestId: 'request-1', attemptId: 'attempt-1' },
			{
				type: 'assistantMessage',
				requestId: 'request-1',
				turn: 1,
				step: 1,
				blocks: [
					{ kind: 'reasoning', text: 'thinking' },
					{ kind: 'text', text: 'answer' },
				],
			},
			{
				type: 'toolCallStart',
				requestId: 'request-1',
				call: {
					id: 'call-1',
					name: 'read_file',
					arguments: '{"path":"README.md"}',
					status: 'running',
				},
			},
			{
				type: 'toolCallUpdate',
				requestId: 'request-1',
				call: {
					id: 'call-1',
					name: 'read_file',
					arguments: '{"path":"README.md"}',
					status: 'completed',
					result: 'contents',
				},
			},
			{
				type: 'approvalRequest',
				requestId: 'request-1',
				approval: { id: 'approval-1', toolName: 'bash', reason: 'Run tests' },
			},
			{
				type: 'approvalResolved',
				approvalId: 'approval-1',
				toolCallId: 'call-1',
				decision: 'allowed',
			},
			{
				type: 'permissionState',
				catalog: {
					options: [
						{ value: 'workspace-write', name: 'workspace-write' },
						{ value: 'auto', name: 'auto' },
					],
					defaultOptions: [{ value: 'workspace-write', name: 'workspace-write' }],
					defaultPreset: 'workspace-write',
				},
				current: 'auto',
			},
			{ type: 'responseEnd', requestId: 'request-1' },
			{
				type: 'planModeState',
				active: true,
				pending: false,
			},
			{
				type: 'filesSelected',
				requestId: 'files-1',
				files: [{
					id: '@src/app.ts',
					name: 'app.ts',
					path: 'src/app.ts',
					mention: '@src/app.ts',
				}],
			},
			{
				type: 'filesSelectionError',
				requestId: 'files-2',
				message: 'failed',
			},
			{
				type: 'modelSelectionState',
				current: { model: 'deepseek-v4-pro', reasoningEffort: 'high' },
			},
		] as const;
		for (const message of stream) {
			assert.ok(isHostToWebviewMessage(message), `rejected ${message.type}`);
		}
		assert.ok(isHostToWebviewMessage({
			type: 'permissionState',
			catalog: null,
			error: 'runtime unavailable',
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'permissionState',
			catalog: { options: [], defaultOptions: [], defaultPreset: '' },
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'planModeState',
			active: 'on',
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'filesSelected',
			requestId: 'files-1',
			files: [{ id: '', name: 'app.ts', path: 'src/app.ts', mention: '@src/app.ts' }],
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'approvalResolved',
			approvalId: 'approval-1',
			decision: 'granted',
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'responseEnd',
			requestId: 'request-1',
			interrupted: true,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'cancelResult',
			requestId: 'cancel-1',
			accepted: true,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'error',
			requestId: 'request-1',
			message: 'failed',
		}));
	});

	test('validates workspace change requests and responses', () => {
		assert.ok(isWebviewToHostMessage({
			type: 'requestWorkspaceFileDiff',
			requestId: 'diff-request-1',
			sessionId: 'session-1',
			seq: 12,
			index: 0,
		}));
		assert.ok(isWebviewToHostMessage({
			type: 'openWorkspaceFileDiff',
			requestId: 'diff-open-1',
			sessionId: 'session-1',
			seq: 12,
			index: 0,
		}));
		assert.ok(!isWebviewToHostMessage({
			type: 'requestWorkspaceFileDiff',
			requestId: 'diff-request-1',
			sessionId: 'session-1',
			seq: -1,
			index: 0,
		}));
		const changes = {
			sessionId: 'session-1',
			seq: 12,
			turn: 2,
			files: [{
				path: 'src/app.ts',
				display: 'src/app.ts',
				added: 1,
				deleted: 1,
			}],
			total: 1,
			added: 1,
			deleted: 1,
		};
		assert.ok(isHostToWebviewMessage({
			type: 'workspaceChanges',
			requestId: 'request-1',
			changes,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'workspaceFileDiff',
			requestId: 'diff-request-1',
			diff: {
				kind: 'text',
				path: 'src/app.ts',
				display: 'src/app.ts',
				before: true,
				after: true,
				hunks: [{
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					lines: ['-old', '+new'],
				}],
				coarse: false,
			},
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'workspaceFileDiff',
			requestId: 'diff-request-1',
			diff: null,
		}));
		assert.ok(isHostToWebviewMessage({
			type: 'workspaceFileDiffError',
			requestId: 'diff-request-1',
			message: 'missing',
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'workspaceChanges',
			requestId: 'request-1',
			changes: { ...changes, total: 0 },
		}));
	});

	test('rejects malformed tool calls and missing request ids', () => {
		assert.ok(!isHostToWebviewMessage({
			type: 'assistantStreamStart',
			requestId: '',
			attemptId: 'attempt-1',
			turn: 1,
			step: 1,
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'responseEnd',
			requestId: 'request-1',
			interrupted: false,
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'cancelResult',
			requestId: '',
			accepted: true,
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'toolCallStart',
			requestId: 'request-1',
			call: { id: 'call', name: 'bash', arguments: '{}', status: 'unknown' },
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'assistantStreamDelta',
			requestId: 'request-1',
			deltas: [{
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				blockIndex: -1,
				kind: 'text',
				text: 'answer',
			}],
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'assistantMessage',
			requestId: 'request-1',
			turn: 1,
			step: 1,
			blocks: [{ kind: 'tool', text: 'not displayable' }],
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'state',
			hasApiKey: true,
			busy: false,
			systemPrompt: '',
			runtimeStatus: 'ready',
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'systemPromptSaved',
			requestId: '',
			isDefault: false,
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'sessionHistory',
			total: 1,
			sessions: [{
				id: '',
				title: '',
				createdAt: 1,
				updatedAt: 2,
				messageCount: 1,
			}],
		}));
		assert.ok(!isHostToWebviewMessage({
			type: 'sessionDeleted',
			requestId: 'delete-1',
			sessionId: 'seekdock-session',
		}));
	});
});
