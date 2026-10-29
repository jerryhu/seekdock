import * as assert from 'node:assert';
import { ConversationStore } from '../webview/store.ts';

suite('Conversation store', () => {
	test('streams reasoning and text, then replaces the live attempt with committed blocks', () => {
		const store = new ConversationStore();
		assert.strictEqual(store.beginRequest('request-1', 'hello'), true);
		let assistantUpdates = 0;
		let userUpdates = 0;
		let orderUpdates = 0;
		store.subscribeMessage('request-1:assistant', () => { assistantUpdates += 1; });
		store.subscribeMessage('request-1:user', () => { userUpdates += 1; });
		store.subscribeOrder(() => { orderUpdates += 1; });

		store.handleHostMessage({
			type: 'assistantStreamStart',
			requestId: 'request-1',
			attemptId: 'attempt-1',
			turn: 1,
			step: 1,
		});
		store.handleHostMessage({
			type: 'assistantStreamDelta',
			requestId: 'request-1',
			deltas: [{
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				blockIndex: 0,
				kind: 'reasoning',
				text: 'checking',
			}],
		});
		store.handleHostMessage({
			type: 'assistantStreamDelta',
			requestId: 'request-1',
			deltas: [{
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				blockIndex: 1,
				kind: 'text',
				text: 'one two',
			}],
		});

		assert.strictEqual(assistantUpdates, 3);
		assert.strictEqual(userUpdates, 0);
		assert.strictEqual(orderUpdates, 0);
		const liveMessage = store.getMessage('request-1:assistant');
		assert.ok(liveMessage?.kind === 'assistant');
		assert.deepStrictEqual(liveMessage.live, {
			attemptId: 'attempt-1',
			turn: 1,
			step: 1,
			phase: 'writing',
			blocks: [
				{ blockIndex: 0, kind: 'reasoning', text: 'checking' },
				{ blockIndex: 1, kind: 'text', text: 'one two' },
			],
		});

		store.handleHostMessage({
			type: 'assistantMessage',
			requestId: 'request-1',
			turn: 1,
			step: 1,
			blocks: [
				{ kind: 'reasoning', text: 'checking' },
				{ kind: 'text', text: 'one two' },
			],
		});
		store.handleHostMessage({
			type: 'assistantStreamEnd',
			requestId: 'request-1',
			attemptId: 'attempt-1',
		});

		const message = store.getMessage('request-1:assistant');
		assert.ok(message?.kind === 'assistant');
		assert.strictEqual(message.live, undefined);
		assert.deepStrictEqual(message.entries, [{
			kind: 'reasoning',
			id: 'assistant-1-1-0',
			text: 'checking',
		}, {
			kind: 'text',
			id: 'assistant-1-1-1',
			text: 'one two',
		}]);
	});

	test('keeps tool updates, errors, completion, and reset consistent', () => {
		const store = new ConversationStore();
		store.beginRequest('request-1', 'hello');
		const call = {
			id: 'call-1',
			name: 'bash',
			arguments: '{"command":"npm test"}',
			status: 'running' as const,
		};
		store.handleHostMessage({ type: 'toolCallStart', requestId: 'request-1', call });
		store.handleHostMessage({
			type: 'toolCallUpdate',
			requestId: 'request-1',
			call: { ...call, status: 'completed', result: 'ok' },
		});
		store.handleHostMessage({ type: 'responseEnd', requestId: 'request-1' });

		const message = store.getMessage('request-1:assistant');
		assert.ok(message?.kind === 'assistant');
		assert.strictEqual(message.status, 'complete');
		assert.ok(message.durationMs !== undefined && message.durationMs >= 0);
		assert.ok(message.entries[0]?.kind === 'tool');
		assert.strictEqual(message.entries[0].call.status, 'completed');

		assert.strictEqual(store.beginRequest('request-2', 'next'), true);
		store.handleHostMessage({
			type: 'error',
			requestId: 'request-2',
			message: 'failed',
		});
		const failed = store.getMessage('request-2:assistant');
		assert.ok(failed?.kind === 'assistant');
		assert.strictEqual(failed.status, 'error');
		assert.strictEqual(failed.error, 'failed');
		assert.ok(failed.durationMs !== undefined && failed.durationMs >= 0);

		store.reset();
		assert.deepStrictEqual(store.getOrder(), []);
		assert.strictEqual(store.getMessage('request-1:assistant'), undefined);
	});

	test('marks a stopped response as cancelled and removes its live attempt', () => {
		const store = new ConversationStore();
		store.beginRequest('request-1', 'keep working');
		store.handleHostMessage({
			type: 'assistantStreamStart',
			requestId: 'request-1',
			attemptId: 'attempt-1',
			turn: 1,
			step: 1,
		});
		store.handleHostMessage({
			type: 'assistantStreamDelta',
			requestId: 'request-1',
			deltas: [{
				attemptId: 'attempt-1',
				turn: 1,
				step: 1,
				blockIndex: 0,
				kind: 'text',
				text: 'partial answer',
			}],
		});
		store.handleHostMessage({
			type: 'responseEnd',
			requestId: 'request-1',
			interrupted: true,
		});

		const message = store.getMessage('request-1:assistant');
		assert.ok(message?.kind === 'assistant');
		assert.strictEqual(message.status, 'cancelled');
		assert.strictEqual(message.live, undefined);
	});

	test('attaches a workspace summary before or after the response settles', () => {
		const store = new ConversationStore();
		const changes = {
			sessionId: 'session-1',
			seq: 9,
			turn: 1,
			files: [{
				path: 'src/app.ts',
				display: 'src/app.ts',
				added: 2,
				deleted: 1,
			}],
			total: 1,
			added: 2,
			deleted: 1,
		} as const;

		store.beginRequest('request-1', 'edit it');
		store.handleHostMessage({ type: 'workspaceChanges', requestId: 'request-1', changes });
		store.handleHostMessage({ type: 'responseEnd', requestId: 'request-1' });
		const completed = store.getMessage('request-1:assistant');
		assert.ok(completed?.kind === 'assistant');
		assert.strictEqual(completed.status, 'complete');
		assert.deepStrictEqual(completed.changes, changes);

		store.beginRequest('request-2', 'edit again');
		store.handleHostMessage({ type: 'responseEnd', requestId: 'request-2' });
		store.handleHostMessage({ type: 'workspaceChanges', requestId: 'request-2', changes: {
			...changes,
			seq: 15,
			turn: 2,
		} });
		const late = store.getMessage('request-2:assistant');
		assert.ok(late?.kind === 'assistant');
		assert.strictEqual(late.changes?.seq, 15);
		assert.strictEqual(completed.changes?.seq, 9);
	});

	test('deduplicates the bridge and audit approval cards and records the outcome', () => {
		const store = new ConversationStore();
		store.beginRequest('request-1', 'run it');
		store.handleHostMessage({
			type: 'toolCallStart',
			requestId: 'request-1',
			call: {
				id: 'call-1',
				name: 'bash',
				arguments: '{"command":"echo hi"}',
				status: 'running',
			},
		});
		store.handleHostMessage({
			type: 'approvalRequest',
			requestId: 'request-1',
			approval: {
				id: 'audit-1',
				toolCallId: 'call-1',
				toolName: 'bash',
				reason: 'Auto review denied this call',
			},
		});
		store.handleHostMessage({
			type: 'approvalRequest',
			requestId: 'request-1',
			approval: {
				id: 'bridge:call-1',
				toolCallId: 'call-1',
				toolName: 'bash',
				displayReason: '自动审查拒绝了此调用',
			},
		});

		const message = store.getMessage('request-1:assistant');
		assert.ok(message?.kind === 'assistant');
		assert.strictEqual(message.entries.filter(entry => entry.kind === 'approval').length, 1);
		const approval = message.entries.find(entry => entry.kind === 'approval');
		assert.ok(approval?.kind === 'approval');
		assert.strictEqual(approval.approval.id, 'audit-1');
		assert.strictEqual(approval.approval.displayReason, '自动审查拒绝了此调用');
		assert.strictEqual(approval.approval.decision, undefined);
		const tool = message.entries.find(entry => entry.kind === 'tool');
		assert.ok(tool?.kind === 'tool');
		assert.strictEqual(tool.call.status, 'awaiting-approval');

		store.handleHostMessage({
			type: 'approvalResolved',
			approvalId: 'audit-1',
			toolCallId: 'call-1',
			decision: 'allowed',
		});

		const resolved = store.getMessage('request-1:assistant');
		assert.ok(resolved?.kind === 'assistant');
		const resolvedApproval = resolved.entries.find(entry => entry.kind === 'approval');
		assert.ok(resolvedApproval?.kind === 'approval');
		assert.strictEqual(resolvedApproval.approval.decision, 'allowed');
	});

	test('loads a persisted transcript as completed chat messages', () => {
		const store = new ConversationStore();
		store.beginRequest('request-1', 'old prompt');
		const changes = {
			sessionId: 'session-1',
			seq: 9,
			turn: 1,
			files: [{
				path: 'src/app.ts',
				display: 'src/app.ts',
				added: 2,
				deleted: 1,
			}],
			total: 1,
			added: 2,
			deleted: 1,
		} as const;

		store.loadTranscript([{
			kind: 'user',
			id: 'history-user-1',
			text: 'hello',
			createdAt: 1,
		}, {
			kind: 'assistant',
			id: 'history-assistant-2',
			createdAt: 2,
			entries: [{
				kind: 'text',
				id: 'history-text-2',
				text: 'world',
			}],
			changes,
		}]);

		assert.deepStrictEqual(store.getOrder(), ['history-user-1', 'history-assistant-2']);
		assert.strictEqual(store.getMessage('request-1:assistant'), undefined);
		const assistant = store.getMessage('history-assistant-2');
		assert.ok(assistant?.kind === 'assistant');
		assert.strictEqual(assistant.status, 'complete');
		assert.strictEqual(assistant.requestId, 'history:history-assistant-2');
		assert.deepStrictEqual(assistant.changes, changes);
		assert.deepStrictEqual(assistant.entries, [{
			kind: 'text',
			id: 'history-text-2',
			text: 'world',
		}]);
	});
});
