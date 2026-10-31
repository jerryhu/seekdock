/**
 * Forward DSH's plan-review question to the SeekDock Webview.
 *
 * `exit_plan_mode` asks `ctx.userQuestions`, which dispatches
 * `user-questions/request` as a waterfall. The SDK profile mounts that service
 * but no answerer, so this bridge claims the plan-review shape, sends it over a
 * private socket, and returns the user's decision. Anything it cannot present is
 * delegated unchanged, and an unanswered request falls through to DSH's
 * fail-closed `NO_PROVIDER` path instead of being answered here.
 */

import { connect } from 'node:net';

export const name = 'seekdock-plan-review-bridge';
export const inject = ['userQuestions'];

const PLAN_REVIEW = 'plan-review';
const REQUEST_TIMEOUT_MS = 10 * 60_000;

export function apply(ctx) {
	const socketPath = process.env.SEEKDOCK_PLAN_REVIEW_SOCKET;
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error('SeekDock: SEEKDOCK_PLAN_REVIEW_SOCKET is not set.');
	}

	ctx.on('user-questions/request', (request, next) => {
		const review = planReviewOf(request);
		if (review === undefined) {
			return next();
		}
		return askHost(ctx, socketPath, review, request.signal).then(
			answers => (answers === undefined ? next() : answers),
		);
	});
}

/**
 * Narrow one request to the single-question plan review the Webview renders.
 *
 * @param request - the waterfall's user-question request.
 * @returns the frame the host understands, or `undefined` to delegate.
 */
function planReviewOf(request) {
	const questions = request?.questions;
	if (!Array.isArray(questions) || questions.length !== 1) {
		return undefined;
	}
	const question = questions[0];
	const intent = question?.intent;
	// The card offers one decision, so a wider choice stays in the generic flow.
	if (intent?.kind !== PLAN_REVIEW
		|| typeof question.id !== 'string' || question.id.length === 0
		|| typeof question.detail !== 'string' || question.detail.trim().length === 0
		|| question.multiSelect === true) {
		return undefined;
	}
	const options = Array.isArray(question.options) ? question.options : [];
	const approve = options.find(option => option?.label === intent.approve);
	if (approve === undefined || options.length > 2) {
		return undefined;
	}
	const decline = options.find(option => option?.label !== intent.approve);
	const sessionId = request.agent?.session?.id;
	if (typeof sessionId !== 'string' || sessionId.length === 0) {
		return undefined;
	}
	return {
		sessionId,
		questionId: question.id,
		...(intent.callId === undefined ? {} : { callId: String(intent.callId) }),
		plan: question.detail,
		approveLabel: approve.label,
		...(decline === undefined ? {} : { declineLabel: decline.label }),
	};
}

/**
 * Send one review to the host and wait for its answer batch.
 *
 * @returns DSH's answer batch, or `undefined` when the host cannot answer, the
 *   review timed out, or the turn was aborted.
 */
function askHost(ctx, socketPath, review, signal) {
	return new Promise(resolve => {
		const socket = connect(socketPath);
		let buffer = '';
		let settled = false;
		let timer;

		const finish = answers => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			socket.destroy();
			resolve(answers);
		};
		const onAbort = () => finish(undefined);

		timer = setTimeout(() => finish(undefined), REQUEST_TIMEOUT_MS);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted === true) {
			finish(undefined);
			return;
		}

		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.write(`${JSON.stringify(review)}\n`);
		});
		socket.on('data', chunk => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline === -1) {
				return;
			}
			try {
				const reply = JSON.parse(buffer.slice(0, newline));
				finish(reply?.outcome === 'answered' ? readAnswers(reply.answers) : undefined);
			} catch {
				finish(undefined);
			}
		});
		socket.once('error', error => {
			ctx.logger.warn(`SeekDock plan-review socket error: ${String(error)}`);
			finish(undefined);
		});
		socket.once('end', () => finish(undefined));
	});
}

/** Validate the host's answer batch before returning it to DSH. */
function readAnswers(value) {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const answers = [];
	for (const item of value) {
		if (typeof item?.id !== 'string' || item.id.length === 0
			|| !Array.isArray(item.selected)
			|| !item.selected.every(label => typeof label === 'string')
			|| (item.custom !== undefined && typeof item.custom !== 'string')) {
			return undefined;
		}
		answers.push({
			id: item.id,
			selected: [...item.selected],
			...(item.custom === undefined ? {} : { custom: item.custom }),
		});
	}
	return { answers };
}
