import * as assert from 'node:assert';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
	SessionId,
	SESSION_FORMAT_VERSION,
	SessionSeq,
	type SessionEvent,
	type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-workspace-changes';
import {
	removeSessionArtifacts,
	SessionHistoryStore,
	summarizeSession,
	transcriptFromSessionEvents,
} from '../host/session-history.ts';
import { LocalizedError } from '../shared/i18n/index.ts';
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

	test('replays recoverable tool failures with their original reason', () => {
		const events: SessionEvent[] = [
			{
				type: 'turn/start',
				seq: SessionSeq(0),
				time: 0,
				data: { turn: 1 },
			},
			userMessage(1, 'Edit the file'),
			{
				type: 'tool/call',
				seq: SessionSeq(2),
				time: 2,
				data: {
					turn: 1,
					step: 1,
					callId: ToolCallId('call-edit'),
					name: 'edit',
					arguments: '{"file_path":"src/app.ts"}',
				},
			},
			{
				type: 'tool/result',
				seq: SessionSeq(3),
				time: 3,
				data: {
					turn: 1,
					step: 1,
					message: {
						id: MessageId('result-3'),
						role: 'tool',
						source: { kind: 'tool', callId: ToolCallId('call-edit') },
						toolCallId: ToolCallId('call-edit'),
						content: [{
							type: 'text',
							text: 'cannot modify "src/app.ts": file has not been read',
						}],
						isError: true,
					},
					error: {
						name: 'FsError',
						code: 'FS_NOT_OBSERVED',
						reason: 'cannot modify "src/app.ts": file has not been read',
					},
				},
				surfaceOp: 'append',
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.ok(messages[1]?.kind === 'assistant');
		assert.deepStrictEqual(messages[1].entries[0], {
			kind: 'tool',
			id: 'history-tool-call-edit',
			call: {
				id: 'call-edit',
				name: 'edit',
				arguments: '{"file_path":"src/app.ts"}',
				status: 'error',
				result: 'cannot modify "src/app.ts": file has not been read',
				error: 'cannot modify "src/app.ts": file has not been read',
				recoverableError: 'file-not-read',
			},
		});
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

	test('replays a submitted plan as a review card instead of a tool row', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Plan the widget'),
			exitPlanModeCall(2, '# Add a widget\n\nRender it above the composer.'),
			exitPlanModeResult(3, false),
			planModeEvent(4, false),
			{
				type: 'turn/end',
				seq: SessionSeq(5),
				time: 5,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.ok(messages[1]?.kind === 'assistant');
		assert.deepStrictEqual(messages[1].entries, [{
			kind: 'plan-review',
			id: 'history-plan-call-plan',
			review: {
				id: 'plan-review:call-plan',
				plan: '# Add a widget\n\nRender it above the composer.',
				decision: 'approved',
			},
		}]);
	});

	test('replays a plan review that asked for changes', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Plan the widget'),
			exitPlanModeCall(2, '# Add a widget'),
			exitPlanModeResult(3, false),
			{
				type: 'turn/end',
				seq: SessionSeq(4),
				time: 4,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.ok(messages[1]?.kind === 'assistant');
		const entry = messages[1].entries.find(item => item.kind === 'plan-review');
		assert.ok(entry?.kind === 'plan-review');
		assert.strictEqual(entry.review.decision, 'changes-requested');
	});

	test('keeps a plan whose review never settled closed', () => {
		const events: SessionEvent[] = [
			{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
			userMessage(1, 'Plan the widget'),
			exitPlanModeCall(2, '# Add a widget'),
			{
				type: 'turn/end',
				seq: SessionSeq(3),
				time: 3,
				data: { turn: 1, reason: { kind: 'interrupted' } },
			},
		];

		const messages = transcriptFromSessionEvents(events);
		assert.ok(messages[1]?.kind === 'assistant');
		const entry = messages[1].entries.find(item => item.kind === 'plan-review');
		assert.ok(entry?.kind === 'plan-review');
		assert.strictEqual(entry.review.decision, 'cancelled');
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
			// A rename is not conversation activity: the row keeps its message time.
			updatedAt: 1,
			messageCount: 1,
		});
	});

	test('keeps the last activity time when a session is reopened', () => {
		const header: SessionHeader = {
			version: SESSION_FORMAT_VERSION,
			id: SessionId('seekdock-reopened'),
			createdAt: 0,
			cwd: '/workspace',
			isSeeded: false,
		};
		const events: SessionEvent[] = [
			userMessage(1, 'Yesterday question'),
			{
				type: 'turn/start',
				seq: SessionSeq(2),
				time: 2,
				data: { turn: 1 },
			},
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
						content: [{ type: 'text', text: 'Yesterday answer' }],
					},
					stream: [],
				},
				surfaceOp: 'append',
			},
			{
				type: 'turn/end',
				seq: SessionSeq(4),
				time: 4,
				data: { turn: 1, reason: { kind: 'completed' } },
			},
			// Resuming the session to read it appends this boundary marker now.
			{
				type: 'session/end-seed',
				seq: SessionSeq(5),
				time: 900,
				data: {},
			},
		];

		assert.deepStrictEqual(summarizeSession(header, events), {
			id: 'seekdock-reopened',
			title: 'Yesterday question',
			createdAt: 0,
			updatedAt: 4,
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

	test('deletes the selected stored session and keeps the others readable', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seekdock-session-store-delete-'));
		const dshHome = join(root, 'dsh-home');
		const sessionsRoot = join(dshHome, 'sessions');

		try {
			await storeSession(sessionsRoot, 'seekdock-target', 'Delete me');
			await storeSession(sessionsRoot, 'seekdock-retained', 'Keep me');
			const store = new SessionHistoryStore({ dshHome, sessionsRoot });

			await store.delete('seekdock-target');

			assert.deepStrictEqual(
				(await store.list()).map(session => session.id),
				['seekdock-retained'],
			);
			const retained = await store.load('seekdock-retained');
			assert.deepStrictEqual(
				retained.messages.map(message => message.kind === 'user' ? message.text : message.kind),
				['Keep me'],
			);
			await assert.rejects(
				store.delete('seekdock-missing'),
				(error: unknown) => error instanceof LocalizedError
					&& error.key === 'hostSessionNotFound',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

/**
 * Persist one complete session through DSH's own JSONL writer, so the history
 * store reads exactly what the runtime would have written.
 *
 * @param sessionsRoot - `<dshHome>/sessions` the runtime uses.
 * @param id - stored session identity.
 * @param text - first human prompt of that session.
 */
async function storeSession(sessionsRoot: string, id: string, text: string): Promise<void> {
	const context = new Context();
	await applyJsonlPersistence(context, { root: sessionsRoot, compression: 'zstd' });
	const persistence = context.get('sessionPersistence');
	assert.ok(persistence !== undefined, 'JSONL session persistence must be registered');
	const handle = await persistence.create({
		version: SESSION_FORMAT_VERSION,
		id: SessionId(id),
		createdAt: 1,
		cwd: '/workspace',
		isSeeded: false,
	});
	try {
		await handle.append([
			{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
			userMessage(1, text),
		]);
		await handle.flush();
	} finally {
		await handle.close();
	}
}

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

function exitPlanModeCall(seq: number, plan: string): SessionEvent {
	return {
		type: 'tool/call',
		seq: SessionSeq(seq),
		time: seq,
		data: {
			turn: 1,
			step: 1,
			callId: ToolCallId('call-plan'),
			name: 'exit_plan_mode',
			arguments: JSON.stringify({ plan }),
		},
	};
}

function exitPlanModeResult(seq: number, isError: boolean): SessionEvent {
	return {
		type: 'tool/result',
		seq: SessionSeq(seq),
		time: seq,
		data: {
			turn: 1,
			step: 1,
			message: {
				id: MessageId(`result-${seq}`),
				role: 'tool',
				source: { kind: 'tool', callId: ToolCallId('call-plan') },
				toolCallId: ToolCallId('call-plan'),
				content: [{
					type: 'text',
					text: isError
						? 'The user chose to keep planning; revise the plan and present it again.'
						: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
				}],
				isError,
			},
		},
		surfaceOp: 'append',
	};
}

/**
 * Build a `plan/mode` event without the plan-mode package's session augmentation.
 *
 * SeekDock does not depend on that package, so the event is cast to the base
 * session-event shape the history projection reads.
 */
function planModeEvent(seq: number, active: boolean): SessionEvent {
	return {
		type: 'plan/mode',
		seq: SessionSeq(seq),
		time: seq,
		data: { active },
	} as unknown as SessionEvent;
}
