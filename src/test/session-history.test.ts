import * as assert from 'node:assert';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SessionId,
	SESSION_FORMAT_VERSION,
	SessionSeq,
	type SessionEvent,
	type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-workspace-changes';
import {
	removeSessionArtifacts,
	summarizeSession,
	transcriptFromSessionEvents,
} from '../host/session-history.ts';
import type { WorkspaceChangeSet } from '../shared/workspace-changes.ts';

const storedChanges: WorkspaceChangeSet = {
	sessionId: 'seekdock-session',
	seq: 3,
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
};

suite('Session history', () => {
	test('replays human prompts, assistant content, and tool results', () => {
		const events: SessionEvent[] = [
			{
				type: 'turn/start',
				seq: SessionSeq(0),
				time: 0,
				data: { turn: 1 },
			},
			userMessage(1, 'Explain this file'),
			userMessage(2, 'Injected runtime context', 'system-prompt'),
			{
				type: 'assistant/message',
				seq: SessionSeq(3),
				time: 3,
				data: {
					turn: 1,
					step: 1,
					message: {
						id: MessageId('assistant-3'),
						role: 'assistant',
						source: {
							kind: 'model',
							provider: 'deepseek-official',
							model: 'deepseek-v4-flash',
						},
						content: [
							{ type: 'reasoning', text: 'Need to inspect it.' },
							{
								type: 'tool-call',
								id: ToolCallId('call-1'),
								name: 'read',
								arguments: '{"path":"a.ts"}',
							},
						],
					},
					stream: [],
				},
				surfaceOp: 'append',
			},
			{
				type: 'tool/call',
				seq: SessionSeq(4),
				time: 4,
				data: {
					turn: 1,
					step: 1,
					callId: ToolCallId('call-1'),
					name: 'read',
					arguments: '{"path":"a.ts"}',
				},
			},
			{
				type: 'tool/result',
				seq: SessionSeq(5),
				time: 5,
				data: {
					turn: 1,
					step: 1,
					message: {
						id: MessageId('result-5'),
						role: 'tool',
						source: { kind: 'tool', callId: ToolCallId('call-1') },
						toolCallId: ToolCallId('call-1'),
						content: [{ type: 'text', text: 'file contents' }],
						isError: false,
					},
				},
				surfaceOp: 'append',
			},
			{
				type: 'assistant/message',
				seq: SessionSeq(6),
				time: 6,
				data: {
					turn: 1,
					step: 2,
					message: {
						id: MessageId('assistant-6'),
						role: 'assistant',
						source: {
							kind: 'model',
							provider: 'deepseek-official',
							model: 'deepseek-v4-flash',
						},
						content: [{ type: 'text', text: 'It parses the file.' }],
					},
					stream: [],
				},
				surfaceOp: 'append',
			},
			{
				type: 'turn/end',
				seq: SessionSeq(7),
				time: 7,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.deepStrictEqual(messages.map(message => message.kind), ['user', 'assistant']);
		assert.ok(messages[0]?.kind === 'user');
		assert.strictEqual(messages[0].text, 'Explain this file');
		assert.ok(messages[1]?.kind === 'assistant');
		assert.strictEqual(messages[1].durationMs, 7);
		assert.deepStrictEqual(messages[1].entries, [{
			kind: 'reasoning',
			id: 'history-reasoning-3-0',
			text: 'Need to inspect it.',
		}, {
			kind: 'tool',
			id: 'history-tool-call-1',
			call: {
				id: 'call-1',
				name: 'read',
				arguments: '{"path":"a.ts"}',
				status: 'completed',
				result: 'file contents',
			},
		}, {
			kind: 'text',
			id: 'history-text-6-0',
			text: 'It parses the file.',
		}]);
	});

	test('attaches a stored changed-file card to the turn that recorded it', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Change the value'),
			assistantText(2, 2, 'Done.'),
			{
				type: 'workspace/changes',
				seq: SessionSeq(3),
				time: 3,
				data: { turn: 1 },
			},
			{
				type: 'turn/end',
				seq: SessionSeq(4),
				time: 4,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
		];

		const messages = transcriptFromSessionEvents(events, new Map([[3, storedChanges]]));
		assert.ok(messages[1]?.kind === 'assistant');
		assert.deepStrictEqual(messages[1].changes, storedChanges);
		assert.strictEqual(messages[1].durationMs, 4);
	});

	test('keeps a changed-file card recorded after the turn ended', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Change the value'),
			assistantText(2, 2, 'Done.'),
			{
				type: 'turn/end',
				seq: SessionSeq(3),
				time: 3,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
			{
				type: 'workspace/changes',
				seq: SessionSeq(4),
				time: 4,
				data: { turn: 1 },
			},
		];

		const changes: WorkspaceChangeSet = { ...storedChanges, seq: 4 };
		const messages = transcriptFromSessionEvents(events, new Map([[4, changes]]));
		assert.ok(messages[1]?.kind === 'assistant');
		assert.deepStrictEqual(messages[1].changes, changes);
	});

	test('omits cards whose stored summary is unavailable', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Change the value'),
			assistantText(2, 2, 'Done.'),
			{
				type: 'workspace/changes',
				seq: SessionSeq(3),
				time: 3,
				data: { turn: 1 },
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.ok(messages[1]?.kind === 'assistant');
		assert.strictEqual(messages[1].changes, undefined);
	});

	test('summarizes persisted metadata and counts only human messages', () => {
		const header: SessionHeader = {
			version: SESSION_FORMAT_VERSION,
			id: SessionId('seekdock-session'),
			createdAt: 0,
			cwd: '/workspace',
			isSeeded: false,
		};
		const events: SessionEvent[] = [
			userMessage(1, 'First question'),
			userMessage(2, 'Injected context', 'system-prompt'),
			userMessage(3, 'Follow-up'),
		];

		assert.deepStrictEqual(summarizeSession(header, events), {
			id: 'seekdock-session',
			title: 'First question',
			createdAt: 0,
			updatedAt: 3,
			messageCount: 2,
		});
	});

	test('uses the latest user-owned title event in session summaries', () => {
		const header: SessionHeader = {
			version: SESSION_FORMAT_VERSION,
			id: SessionId('seekdock-renamed'),
			createdAt: 0,
			cwd: '/workspace',
			isSeeded: false,
		};
		const events: SessionEvent[] = [
			userMessage(1, 'Original prompt'),
			{
				type: 'session/title',
				seq: SessionSeq(2),
				time: 12,
				data: {
					title: 'Renamed by user',
					messageSeqs: [],
					source: { kind: 'user' },
				},
			},
		];

		assert.deepStrictEqual(summarizeSession(header, events), {
			id: 'seekdock-renamed',
			title: 'Renamed by user',
			createdAt: 0,
			updatedAt: 12,
			messageCount: 1,
		});
	});

	test('removes only the selected session log and projection cache', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-session-delete-'));
		const dshHome = join(root, 'dsh-home');
		const sessionsRoot = join(dshHome, 'sessions');
		const project = join(sessionsRoot, '--workspace--');
		const target = join(project, 'seekdock-target');
		const retained = join(project, 'seekdock-retained');
		const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions');
		const targetCache = join(cacheRoot, 'seekdock-target.json');
		const retainedCache = join(cacheRoot, 'seekdock-retained.json');
		await mkdir(target, { recursive: true });
		await mkdir(retained, { recursive: true });
		await mkdir(cacheRoot, { recursive: true });
		await writeFile(join(target, 'session.v4.jsonl.zstd'), 'target');
		await writeFile(join(retained, 'session.v4.jsonl.zstd'), 'retained');
		await writeFile(targetCache, '{}');
		await writeFile(retainedCache, '{}');

		try {
			await removeSessionArtifacts({ dshHome, sessionsRoot }, 'seekdock-target');
			await assert.rejects(access(target));
			await assert.rejects(access(targetCache));
			await access(join(retained, 'session.v4.jsonl.zstd'));
			await access(retainedCache);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function assistantText(seq: number, step: number, text: string): SessionEvent {
	return {
		type: 'assistant/message',
		seq: SessionSeq(seq),
		time: seq,
		data: {
			turn: 1,
			step,
			message: {
				id: MessageId(`assistant-${seq}`),
				role: 'assistant',
				source: {
					kind: 'model',
					provider: 'deepseek-official',
					model: 'deepseek-v4-flash',
				},
				content: [{ type: 'text', text }],
			},
			stream: [],
		},
		surfaceOp: 'append',
	};
}

function userMessage(
	seq: number,
	text: string,
	source: 'user' | 'system-prompt' = 'user',
): SessionEvent {	return {
		type: 'user/message',
		seq: SessionSeq(seq),
		time: seq,
		data: {
			id: MessageId(`user-${seq}`),
			role: 'user',
			source: source === 'user'
				? { kind: 'user' }
				: { kind: 'system-prompt' },
			content: [{ type: 'text', text }],
		},
		surfaceOp: 'append',
	};
}
