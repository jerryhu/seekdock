import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
	SessionId,
	type SessionEvent,
	type SessionHeader,
} from '@deepseek-ai/dsh-session';
import type {
	SessionHandle,
	SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence';
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
// Loads the `workspace/changes` event augmentation this projection switches on.
import type {} from '@deepseek-ai/dsh-workspace-changes';
import type {
	SessionSummary,
	ToolCall,
	TranscriptEntry,
	TranscriptMessage,
} from '../shared/rpc.ts';
import type { WorkspaceChangeSet } from '../shared/workspace-changes.ts';
import { LocalizedError } from '../shared/i18n/index.ts';

/** Session list plus the complete replayable transcript requested by the Webview. */
export interface LoadedSession {
	sessionId: string;
	title: string;
	messages: readonly TranscriptMessage[];
}

interface SessionHistoryOptions {
	sessionsRoot: string;
	dshHome: string;
	defaultSessionTitle?: () => string;
}

interface SessionScan {
	summary: SessionSummary;
	events: readonly SessionEvent[];
}

interface SessionHistoryPersistence {
	list(): Promise<readonly SessionPersistenceSnapshot[]>;
	open(id: SessionId, access: 'read'): Promise<SessionHandle>;
}

/**
 * Read-only projection of DSH's JSONL session store.
 *
 * The backend owns format migration and validation, so the extension never
 * duplicates DSH's on-disk session format.
 */
export class SessionHistoryStore {
	private initialization: Promise<SessionHistoryPersistence> | undefined;

	constructor(private readonly options: SessionHistoryOptions) { }

	/** @returns every top-level SeekDock session, newest activity first. */
	async list(): Promise<readonly SessionSummary[]> {
		const scans = await this.scanSessions();
		return scans
			.filter((scan): scan is SessionScan => scan.summary.messageCount > 0)
			.map(scan => scan.summary)
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	/**
	 * Read and replay one stored session without making it live.
	 *
	 * @param id - DSH session id selected from the history list.
	 * @param changesBySeq - SeekDock's stored changed-file cards keyed by event sequence.
	 * @returns a title and the messages rendered in the chat transcript.
	 */
	async load(
		id: string,
		changesBySeq: ReadonlyMap<number, WorkspaceChangeSet> = new Map(),
	): Promise<LoadedSession> {
		const persistence = await this.ensurePersistence();
		const handle = await persistence.open(SessionId(id), 'read');
		try {
			const snapshot = await handle.read();
			const title = sessionTitle(
				snapshot.events,
				this.options.defaultSessionTitle?.() ?? 'New session',
			);
			return {
				sessionId: id,
				title,
				messages: transcriptFromSessionEvents(snapshot.events, changesBySeq),
			};
		} finally {
			await handle.close();
		}
	}

	/**
	 * Permanently remove one persisted session and its derived projection cache.
	 * The caller must stop the DSH runtime first so its write lease is released.
	 *
	 * @param id - session id selected from the current history list.
	 */
	async delete(id: string): Promise<void> {
		const sessions = await this.list();
		if (!sessions.some(session => session.id === id)) {
			throw new LocalizedError('hostSessionNotFound');
		}
		await removeSessionArtifacts(this.options, id);
	}

	private async scanSessions(): Promise<readonly SessionScan[]> {
		const persistence = await this.ensurePersistence();
		const snapshots = await persistence.list();
		const candidates = snapshots.filter(snapshot => snapshot.header.origin !== 'subagent');
		return mapWithConcurrency(candidates, 4, async (snapshot) => {
			const handle = await persistence.open(snapshot.header.id, 'read');
			try {
				const result = await handle.read();
				return {
					summary: summarizeSession(
						snapshot.header,
						result.events,
						this.options.defaultSessionTitle?.() ?? 'New session',
					),
					events: result.events,
				};
			} finally {
				await handle.close();
			}
		});
	}

	private async ensurePersistence(): Promise<SessionHistoryPersistence> {
		this.initialization ??= this.initializePersistence();
		return this.initialization;
	}

	private async initializePersistence(): Promise<SessionHistoryPersistence> {
		const context = new Context();
		await applyJsonlPersistence(context, {
			root: this.options.sessionsRoot,
			compression: 'zstd',
		});
		const persistence: unknown = context.get('sessionPersistence');
		if (!isSessionHistoryPersistence(persistence)) {
			throw new LocalizedError('hostSessionPersistenceMissing');
		}
		return persistence;
	}
}

/**
 * Remove one session's DSH-owned files without touching other sessions.
 *
 * DSH has no deletion service yet, so this is the documented out-of-band
 * maintenance path for its JSONL store and derived projection cache.
 *
 * @param options - DSH home and session roots.
 * @param id - persisted session identity.
 */
export async function removeSessionArtifacts(
	options: SessionHistoryOptions,
	id: string,
): Promise<void> {
	assertSafeSessionId(id);
	const sessionDirectory = await findSessionDirectory(options.sessionsRoot, id);
	if (sessionDirectory === undefined) {
		throw new LocalizedError('hostSessionDirectoryMissing');
	}
	await rm(
		join(options.dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
		{ force: true },
	);
	await rm(sessionDirectory, { recursive: true });
}

async function findSessionDirectory(
	sessionsRoot: string,
	id: string,
): Promise<string | undefined> {
	let projects;
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		const code = error instanceof Error && 'code' in error ? error.code : undefined;
		if (code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	for (const project of projects) {
		if (!project.isDirectory()) {
			continue;
		}
		const candidate = join(sessionsRoot, project.name, id);
		try {
			const entries = await readdir(candidate, { withFileTypes: true });
			if (entries.some(entry => entry.isFile() || entry.isDirectory())) {
				return candidate;
			}
		} catch (error) {
			const code = error instanceof Error && 'code' in error ? error.code : undefined;
			if (code !== 'ENOENT') {
				throw error;
			}
		}
	}
	return undefined;
}

/**
 * Reject session ids that could escape the directory holding extension-owned artifacts.
 *
 * @param id - session identity taken from a Webview request or DSH snapshot.
 */
export function assertSafeSessionId(id: string): void {
	if (id.length === 0
		|| id === '.'
		|| id === '..'
		|| basename(id) !== id
		|| id.includes('\\')) {
		throw new LocalizedError('hostInvalidSessionId');
	}
}

function isSessionHistoryPersistence(value: unknown): value is SessionHistoryPersistence {
	return typeof value === 'object'
		&& value !== null
		&& 'list' in value
		&& typeof value.list === 'function'
		&& 'open' in value
		&& typeof value.open === 'function';
}

/**
 * Convert DSH's event log into the compact transcript rendered by the Webview.
 * Only human-authored user messages appear; injected runtime context stays out
 * of the conversation history.
 *
 * @param events - complete persisted session log.
 * @param changesBySeq - changed-file cards SeekDock stored for this session.
 * @returns historical user and assistant messages in log order.
 */
export function transcriptFromSessionEvents(
	events: readonly SessionEvent[],
	changesBySeq: ReadonlyMap<number, WorkspaceChangeSet> = new Map(),
): readonly TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	let assistant: {
		id: string;
		createdAt: number;
		entries: TranscriptEntry[];
		changes?: WorkspaceChangeSet;
	} | undefined;
	let turnStartedAt: number | undefined;

	const ensureAssistant = (time: number, seq: number): NonNullable<typeof assistant> => {
		assistant ??= {
			id: `history-assistant-${seq}`,
			createdAt: time,
			entries: [],
		};
		return assistant;
	};
	const flushAssistant = (durationMs?: number): void => {
		if (assistant !== undefined && assistant.entries.length > 0) {
			messages.push({
				kind: 'assistant',
				id: assistant.id,
				entries: assistant.entries,
				createdAt: assistant.createdAt,
				...(durationMs === undefined ? {} : { durationMs }),
				...(assistant.changes === undefined ? {} : { changes: assistant.changes }),
			});
		}
		assistant = undefined;
	};

	for (const event of events) {
		switch (event.type) {
			case 'turn/start':
				flushAssistant();
				turnStartedAt = event.time;
				break;
			case 'user/message': {
				if (event.data.source.kind !== 'user') {
					break;
				}
				const text = contentText(event.data.content).trim();
				if (text.length === 0) {
					break;
				}
				flushAssistant();
				messages.push({
					kind: 'user',
					id: `history-user-${event.seq}`,
					text,
					createdAt: event.time,
				});
				break;
			}
			case 'assistant/message': {
				const message = ensureAssistant(event.time, event.seq);
				for (const [index, block] of event.data.message.content.entries()) {
					if (block.type === 'text' || block.type === 'reasoning') {
						if (block.text.length === 0) {
							continue;
						}
						message.entries.push({
							kind: block.type,
							id: `history-${block.type}-${event.seq}-${index}`,
							text: block.text,
						});
					}
				}
				break;
			}
			case 'tool/call': {
				const message = ensureAssistant(event.time, event.seq);
				message.entries.push({
					kind: 'tool',
					id: `history-tool-${event.data.callId}`,
					call: {
						id: event.data.callId,
						name: event.data.name,
						arguments: event.data.arguments,
						status: 'running',
					},
				});
				break;
			}
			case 'tool/result': {
				const message = ensureAssistant(event.time, event.seq);
				const callId = event.data.message.source.callId;
				const result = contentText(event.data.message.content);
				const status = event.data.message.isError === true || event.data.error !== undefined
					? 'error'
					: 'completed';
				const toolId = `history-tool-${callId}`;
				const index = message.entries.findIndex(
					entry => entry.kind === 'tool' && entry.id === toolId,
				);
				if (index === -1) {
					message.entries.push({
						kind: 'tool',
						id: toolId,
						call: {
							id: callId,
							name: 'tool',
							arguments: '{}',
							status,
							result,
							...(event.data.error === undefined
								? {}
								: { error: event.data.error.name }),
						},
					});
				} else {
					const entry = message.entries[index];
					if (entry.kind === 'tool') {
						message.entries[index] = {
							...entry,
							call: {
								...entry.call,
								status,
								result,
								...(event.data.error === undefined
									? {}
									: { error: event.data.error.name }),
							} satisfies ToolCall,
						};
					}
				}
				break;
			}
			case 'workspace/changes': {
				const changes = changesBySeq.get(event.seq);
				if (changes === undefined) {
					break;
				}
				if (assistant !== undefined) {
					assistant.changes = changes;
					break;
				}
				// An interrupted turn may record its summary after `turn/end`
				// flushed the assistant message; keep the card on that message.
				const last = messages.at(-1);
				if (last?.kind === 'assistant') {
					messages[messages.length - 1] = { ...last, changes };
				}
				break;
			}
			case 'turn/end': {
				const startedAt = turnStartedAt ?? assistant?.createdAt;
				flushAssistant(
					startedAt === undefined
						? undefined
						: Math.max(0, event.time - startedAt),
				);
				turnStartedAt = undefined;
				break;
			}
			default:
				break;
		}
	}
	flushAssistant();
	return messages;
}

/**
 * Build a stable history row from immutable metadata and its event log.
 *
 * @param header - persisted session header.
 * @param events - complete persisted session log.
 * @returns summary metadata used by the recent and full history views.
 */
export function summarizeSession(
	header: SessionHeader,
	events: readonly SessionEvent[],
	defaultTitle = 'New session',
): SessionSummary {
	const humanMessages = events.filter(
		event => event.type === 'user/message'
			&& event.data.source.kind === 'user'
			&& contentText(event.data.content).trim().length > 0,
	);
	const latestTime = events.reduce(
		(maximum, event) => Math.max(maximum, event.time),
		header.createdAt,
	);
	return {
		id: header.id,
		title: sessionTitle(events, defaultTitle),
		createdAt: header.createdAt,
		updatedAt: latestTime,
		messageCount: humanMessages.length,
	};
}

function sessionTitle(events: readonly SessionEvent[], defaultTitle: string): string {
	const logged = foldSessionTitle(events)?.title.trim();
	if (logged !== undefined && logged.length > 0) {
		return logged;
	}
	const firstPrompt = events.find(
		event => event.type === 'user/message' && event.data.source.kind === 'user',
	);
	if (firstPrompt?.type === 'user/message') {
		const text = contentText(firstPrompt.data.content).replace(/\s+/g, ' ').trim();
		if (text.length > 0) {
			return text.length > 80 ? `${text.slice(0, 79)}…` : text;
		}
	}
	return defaultTitle;
}

function contentText(
	content: readonly {
		readonly type: string;
		readonly text?: string;
		readonly content?: readonly unknown[];
	}[],
): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.join('\n');
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await mapper(items[index]!);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
	);
	return results;
}
