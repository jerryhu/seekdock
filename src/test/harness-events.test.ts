import * as assert from 'node:assert';
import { HarnessEventTranslator } from '../host/harness-events.ts';

suite('Harness event translation', () => {
	test('extracts committed reasoning and text blocks for the transcript', () => {
		const translator = new HarnessEventTranslator('root');
		const events = translator.translate(notification('root', 'assistant/message', {
			turn: 1,
			step: 1,
			message: {
				content: [
					{ type: 'reasoning', text: 'visible reasoning' },
					{ type: 'text', text: 'Answer ' },
					{ type: 'text', text: 'text' },
					{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
				],
			},
		}));
		assert.deepStrictEqual(events, [{
			type: 'assistantMessage',
			turn: 1,
			step: 1,
			blocks: [
				{ kind: 'reasoning', text: 'visible reasoning' },
				{ kind: 'text', text: 'Answer ' },
				{ kind: 'text', text: 'text' },
			],
		}]);
	});

	test('forwards process-local assistant stream frames for the root session', () => {
		const translator = new HarnessEventTranslator('root');
		assert.deepStrictEqual(
			translator.translate(streamNotification('root', {
				type: 'start',
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
			})),
			[{
				type: 'assistantStreamStart',
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
			}],
		);
		assert.deepStrictEqual(
			translator.translate(streamNotification('root', {
				type: 'chunk',
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				chunk: { type: 'reasoning-delta', index: 0, text: 'checking' },
			})),
			[{
				type: 'assistantStreamDelta',
				delta: {
					attemptId: 'attempt-1',
					turn: 1,
					step: 1,
					blockIndex: 0,
					kind: 'reasoning',
					text: 'checking',
				},
			}],
		);
		assert.deepStrictEqual(
			translator.translate(streamNotification('root', {
				type: 'chunk',
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				chunk: {
					type: 'tool-call-delta',
					index: 1,
					id: 'call-1',
					name: 'read_file',
					argumentsDelta: '',
				},
			})),
			[{
				type: 'assistantStreamDelta',
				delta: {
					attemptId: 'attempt-1',
					turn: 1,
					step: 1,
					blockIndex: 1,
					kind: 'tool',
					text: 'read_file',
				},
			}],
		);
		assert.deepStrictEqual(
			translator.translate(streamNotification('root', {
				type: 'end',
				attemptId: 'attempt-1',
				revision: 4,
				index: 2,
				outcome: { kind: 'abandoned' },
			})),
			[{ type: 'assistantStreamEnd', attemptId: 'attempt-1' }],
		);
		assert.deepStrictEqual(
			translator.translate(streamNotification('child', {
				type: 'start',
				attemptId: 'attempt-child',
				turn: 1,
				step: 1,
			})),
			[],
		);
	});

	test('pairs tool calls with their completed result', () => {
		const translator = new HarnessEventTranslator('root');
		assert.deepStrictEqual(
			translator.translate(notification('root', 'tool/call', {
				callId: 'call-1',
				name: 'read_file',
				arguments: '{"path":"README.md"}',
			})),
			[{
				type: 'toolCallStart',
				call: {
					id: 'call-1',
					name: 'read_file',
					arguments: '{"path":"README.md"}',
					status: 'running',
				},
			}],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'tool/result', {
				message: {
					toolCallId: 'call-1',
					isError: false,
					content: [{ type: 'text', text: 'file contents' }],
				},
			})),
			[{
				type: 'toolCallUpdate',
				call: {
					id: 'call-1',
					name: 'read_file',
					arguments: '{"path":"README.md"}',
					status: 'completed',
					result: 'file contents',
				},
			}],
		);
	});

	test('classifies recoverable filesystem failures', () => {
		const translator = new HarnessEventTranslator('root');
		translator.translate(notification('root', 'tool/call', {
			callId: 'call-edit',
			name: 'edit',
			arguments: '{"file_path":"src/app.ts"}',
		}));
		assert.deepStrictEqual(
			translator.translate(notification('root', 'tool/result', {
				message: {
					toolCallId: 'call-edit',
					isError: true,
					content: [{
						type: 'text',
						text: 'cannot modify "src/app.ts": file has not been read',
					}],
				},
				error: {
					name: 'FsError',
					code: 'FS_NOT_OBSERVED',
					reason: 'cannot modify "src/app.ts": file has not been read',
				},
			})),
			[{
				type: 'toolCallUpdate',
				call: {
					id: 'call-edit',
					name: 'edit',
					arguments: '{"file_path":"src/app.ts"}',
					status: 'error',
					result: 'cannot modify "src/app.ts": file has not been read',
					error: 'cannot modify "src/app.ts": file has not been read',
					recoverableError: 'file-not-read',
				},
			}],
		);
	});

	test('ignores child sessions and surfaces approvals and turn errors', () => {
		const translator = new HarnessEventTranslator('root');
		assert.deepStrictEqual(
			translator.translate(notification('child', 'assistant/message', {
				message: { content: [{ type: 'text', text: 'child' }] },
			})),
			[],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'approval/asked', {
				id: 'approval-1',
				toolName: 'bash',
				callId: 'call-1',
				reason: 'Run tests',
			})),
			[{
				type: 'approvalRequest',
				approval: {
					id: 'approval-1',
					toolName: 'bash',
					toolCallId: 'call-1',
					reason: 'Run tests',
				},
			}],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'approval/decided', {
				id: 'approval-1',
				outcome: 'allowed-once',
			})),
			[{
				type: 'approvalResolved',
				approvalId: 'approval-1',
				toolCallId: 'call-1',
				decision: 'allowed',
			}],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'approval/decided', {
				id: 'unknown-approval',
				outcome: 'rejected',
			})),
			[{
				type: 'approvalResolved',
				approvalId: 'unknown-approval',
				decision: 'rejected',
			}],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'permission/preset', { preset: 'auto' })),
			[{ type: 'permissionChanged' }],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'sandbox/mode', { mode: 'danger-full-access' })),
			[{ type: 'permissionChanged' }],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'plan/mode', { active: true })),
			[{ type: 'planModeChanged' }],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'turn/end', {
				reason: { kind: 'error', error: { message: 'provider failed' } },
			})),
			[{ type: 'turnError', message: 'provider failed' }],
		);
	});

	test('surfaces the sequence of a workspace change announcement', () => {
		const translator = new HarnessEventTranslator('root');
		assert.deepStrictEqual(
			translator.translate(notification('root', 'workspace/changes', { turn: 3 }, 42)),
			[{ type: 'workspaceChanges', turn: 3, seq: 42 }],
		);
		assert.deepStrictEqual(
			translator.translate(notification('root', 'workspace/changes', { turn: 0 }, 43)),
			[],
		);
	});
});

function notification(sessionId: string, type: string, data: object, seq = 0) {
	return {
		method: 'session.event',
		params: {
			sessionId,
			event: { type, data, seq },
		},
	};
}

function streamNotification(sessionId: string, frame: object) {
	return {
		method: 'seekdock/assistant-stream',
		params: { sessionId, frame },
	};
}
