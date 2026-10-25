import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Closed approval outcomes DSH accepts from an answerer. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** One approval question forwarded from the DSH runtime. */
export interface ApprovalQuestion {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	reason?: string;
	displayReason?: string;
}

export interface ApprovalBrokerOptions {
	/** Resolve one question with the user's decision, or a fail-closed outcome. */
	onQuestion: (question: ApprovalQuestion) => Promise<ApprovalOutcome>;
	/** Upper bound for a question that never receives an answer. */
	questionTimeoutMs?: number;
}

const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Host end of the approval round trip. The DSH runtime's approval bridge opens
 * one short-lived connection per question; this broker validates the question,
 * waits for the Webview, and writes the outcome back. It never grants by
 * itself: a missing handler, timeout, or malformed frame is `unavailable`.
 */
export class ApprovalBroker {
	/** Private socket the runtime's approval bridge connects to. */
	readonly socketPath = process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-approval-${process.pid}-${randomUUID()}`
		: join(tmpdir(), `seekdock-approval-${process.pid}-${randomUUID().slice(0, 12)}.sock`);

	private server: Server | undefined;
	private starting: Promise<void> | undefined;
	private disposed = false;
	private readonly sockets = new Set<Socket>();

	constructor(private readonly options: ApprovalBrokerOptions) { }

	/** Bind the socket; repeated calls share one server. */
	start(): Promise<void> {
		this.starting ??= this.listen().catch((error: unknown) => {
			this.starting = undefined;
			throw error;
		});
		return this.starting;
	}

	/** Stop listening and fail any in-flight question closed. */
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server !== undefined) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		if (process.platform !== 'win32') {
			await rm(this.socketPath, { force: true }).catch(() => {});
		}
	}

	private async listen(): Promise<void> {
		if (this.disposed) {
			throw new Error('SeekDock approval broker has been disposed.');
		}
		if (process.platform !== 'win32') {
			await rm(this.socketPath, { force: true }).catch(() => {});
		}
		const server = createServer(socket => {
			let input = '';
			let settled = false;
			this.sockets.add(socket);
			socket.once('close', () => this.sockets.delete(socket));
			socket.setEncoding('utf8');
			socket.on('error', () => {
				socket.destroy();
			});
			socket.on('data', chunk => {
				input += chunk;
				if (!input.includes('\n') || settled) {
					return;
				}
				settled = true;
				void this.answer(socket, input.slice(0, input.indexOf('\n')));
			});
			socket.on('end', () => {
				if (!settled) {
					settled = true;
					if (!socket.destroyed) {
						socket.end(`${JSON.stringify({ outcome: 'unavailable' })}\n`);
					}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		this.server = server;
	}

	private async answer(socket: Socket, raw: string): Promise<void> {
		let outcome: ApprovalOutcome = 'unavailable';
		const question = parseQuestion(raw);
		if (question !== undefined) {
			outcome = await this.ask(question);
		}
		if (!socket.destroyed) {
			socket.end(`${JSON.stringify({ outcome })}\n`);
		}
	}

	private async ask(question: ApprovalQuestion): Promise<ApprovalOutcome> {
		const timeoutMs = this.options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.options.onQuestion(question),
				new Promise<ApprovalOutcome>((resolve) => {
					timer = setTimeout(() => resolve('cancelled'), timeoutMs);
				}),
			]);
		} catch {
			return 'unavailable';
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}
}

function parseQuestion(raw: string): ApprovalQuestion | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const callId = typeof record.toolCallId === 'string'
		? record.toolCallId
		: typeof record.callId === 'string'
			? record.callId
			: undefined;
	if (typeof record.sessionId !== 'string' || record.sessionId.length === 0
		|| callId === undefined || callId.length === 0
		|| typeof record.toolName !== 'string' || record.toolName.length === 0) {
		return undefined;
	}
	const reason = typeof record.reason === 'string' && record.reason.length > 0
		? record.reason
		: undefined;
	const displayReason = readDisplayReason(record.displayReason);
	return {
		sessionId: record.sessionId,
		toolCallId: callId,
		toolName: record.toolName,
		...(reason === undefined ? {} : { reason }),
		...(displayReason === undefined ? {} : { displayReason }),
	};
}

/** Prefer the Simplified Chinese string Desktop would show, then English. */
function readDisplayReason(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.length > 0 ? value : undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ['zh', 'en']) {
		const candidate = record[key];
		if (typeof candidate === 'string' && candidate.length > 0) {
			return candidate;
		}
	}
	for (const candidate of Object.values(record)) {
		if (typeof candidate === 'string' && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}
