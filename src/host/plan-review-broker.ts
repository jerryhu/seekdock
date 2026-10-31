import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One plan review forwarded from the DSH runtime. */
export interface PlanReviewQuestion {
	sessionId: string;
	/** Question id DSH echoes back in the answer batch. */
	questionId: string;
	/** Reviewed `exit_plan_mode` call, when DSH logged one. */
	callId?: string;
	plan: string;
	/** Option label that approves the plan. */
	approveLabel: string;
	/** Option label that keeps planning, when the request offered one. */
	declineLabel?: string;
}

/** The user's decision for one plan review, before DSH's answer encoding. */
export interface PlanReviewVerdict {
	approved: boolean;
	/** Free-text revision request, only meaningful when the plan was declined. */
	feedback?: string;
}

export interface PlanReviewBrokerOptions {
	/** Resolve one review with the user's decision, or `undefined` when nobody can answer. */
	onQuestion: (question: PlanReviewQuestion) => Promise<PlanReviewVerdict | undefined>;
	/** Upper bound for a review that never receives an answer. */
	questionTimeoutMs?: number;
}

const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Host end of the plan-review round trip. The runtime's plan-review bridge
 * opens one short-lived connection per review; this broker validates the
 * frame, waits for the Webview, and writes DSH's answer batch back. It never
 * answers by itself: a missing handler, timeout, or malformed frame is
 * `unavailable`, which leaves DSH's fail-closed NO_PROVIDER path in place.
 */
export class PlanReviewBroker {
	/** Private socket the runtime's plan-review bridge connects to. */
	readonly socketPath = process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-plan-review-${process.pid}-${randomUUID()}`
		: join(tmpdir(), `seekdock-plan-review-${process.pid}-${randomUUID().slice(0, 12)}.sock`);

	private server: Server | undefined;
	private starting: Promise<void> | undefined;
	private disposed = false;
	private readonly sockets = new Set<Socket>();

	constructor(private readonly options: PlanReviewBrokerOptions) { }

	/** Bind the socket; repeated calls share one server. */
	start(): Promise<void> {
		this.starting ??= this.listen().catch((error: unknown) => {
			this.starting = undefined;
			throw error;
		});
		return this.starting;
	}

	/** Stop listening and fail any in-flight review closed. */
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
			throw new Error('SeekDock plan-review broker has been disposed.');
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
		const question = parseQuestion(raw);
		const reply = question === undefined
			? { outcome: 'unavailable' }
			: await this.decide(question);
		if (!socket.destroyed) {
			socket.end(`${JSON.stringify(reply)}\n`);
		}
	}

	private async decide(question: PlanReviewQuestion): Promise<Record<string, unknown>> {
		const timeoutMs = this.options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		try {
			const verdict = await Promise.race([
				this.options.onQuestion(question),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), timeoutMs);
				}),
			]);
			return verdict === undefined
				? { outcome: 'unavailable' }
				: { outcome: 'answered', answers: encodeAnswer(question, verdict) };
		} catch {
			return { outcome: 'unavailable' };
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}
}

/**
 * Translate the Webview's decision into DSH's answer batch. A declined review
 * carries free text as the question's `custom` answer, because that is the
 * value `exit_plan_mode` forwards to the model as revision feedback.
 */
function encodeAnswer(
	question: PlanReviewQuestion,
	answer: PlanReviewVerdict,
): readonly Record<string, unknown>[] {
	if (answer.approved) {
		return [{ id: question.questionId, selected: [question.approveLabel] }];
	}
	if (answer.feedback !== undefined && answer.feedback.trim().length > 0) {
		return [{ id: question.questionId, selected: [], custom: answer.feedback }];
	}
	return [{
		id: question.questionId,
		selected: question.declineLabel === undefined ? [] : [question.declineLabel],
	}];
}

function parseQuestion(raw: string): PlanReviewQuestion | undefined {
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
	if (typeof record.sessionId !== 'string' || record.sessionId.length === 0
		|| typeof record.questionId !== 'string' || record.questionId.length === 0
		|| typeof record.plan !== 'string' || record.plan.trim().length === 0
		|| typeof record.approveLabel !== 'string' || record.approveLabel.length === 0) {
		return undefined;
	}
	const callId = readOptionalText(record.callId);
	const declineLabel = readOptionalText(record.declineLabel);
	return {
		sessionId: record.sessionId,
		questionId: record.questionId,
		plan: record.plan,
		approveLabel: record.approveLabel,
		...(callId === undefined ? {} : { callId }),
		...(declineLabel === undefined ? {} : { declineLabel }),
	};
}

function readOptionalText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
