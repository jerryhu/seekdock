import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../resources/dsh/seekdock-plan-review-bridge.mjs';

const PLAN = '# Plan\n\n1. Read the composer';

test('plan-review bridge forwards a plan review and returns the host answer', async (t) => {
	const answers = [{ id: 'plan-review', selected: ['Approve'] }];
	const host = await startHost(t, () => ({ outcome: 'answered', answers }));
	const listener = register(t, host.socketPath);

	const result = await listener(planReviewRequest(), async () => {
		throw new Error('the bridge must not delegate an answered review');
	});

	assert.deepStrictEqual(result, { answers });
	assert.deepStrictEqual(host.frames, [{
		sessionId: 'session-1',
		questionId: 'plan-review',
		callId: 'call-1',
		plan: PLAN,
		approveLabel: 'Approve',
		declineLabel: 'Keep planning',
	}]);
});

test('plan-review bridge delegates reviews it cannot present', async (t) => {
	const host = await startHost(t, () => ({ outcome: 'unavailable' }));
	const listener = register(t, host.socketPath);
	const delegated = { answers: [{ id: 'plan-review', selected: [] }] };

	const plainQuestion = {
		agent: { session: { id: 'session-1' } },
		questions: [{
			id: 'ask-1',
			question: 'Continue?',
			options: [{ label: 'Yes' }, { label: 'No' }],
		}],
	};

	assert.deepStrictEqual(await listener(plainQuestion, async () => delegated), delegated);

	const widerChoice = planReviewRequest();
	widerChoice.questions[0].options.push({ label: 'Ask later' });
	assert.deepStrictEqual(await listener(widerChoice, async () => delegated), delegated);

	const multiSelect = planReviewRequest();
	multiSelect.questions[0].multiSelect = true;
	assert.deepStrictEqual(await listener(multiSelect, async () => delegated), delegated);

	assert.deepStrictEqual(host.frames, []);
});

test('plan-review bridge delegates when the host cannot answer', async (t) => {
	const host = await startHost(t, () => ({ outcome: 'unavailable' }));
	const listener = register(t, host.socketPath);
	const delegated = { answers: [{ id: 'plan-review', selected: [] }] };

	assert.deepStrictEqual(
		await listener(planReviewRequest(), async () => delegated),
		delegated,
	);
	assert.strictEqual(host.frames.length, 1);
});

test('plan-review bridge rejects a malformed host answer instead of answering DSH', async (t) => {
	const host = await startHost(t, () => ({
		outcome: 'answered',
		answers: [{ id: 'plan-review', selected: 'Approve' }],
	}));
	const listener = register(t, host.socketPath);
	const delegated = { answers: [{ id: 'plan-review', selected: [] }] };

	assert.deepStrictEqual(
		await listener(planReviewRequest(), async () => delegated),
		delegated,
	);
});

function planReviewRequest() {
	return {
		agent: { session: { id: 'session-1' } },
		questions: [{
			id: 'plan-review',
			header: 'Plan review',
			question: 'Approve this plan and leave plan mode?',
			detail: PLAN,
			options: [
				{ label: 'Approve' },
				{ label: 'Keep planning' },
			],
			intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
		}],
	};
}

/** Bind the bridge to one fake host socket and return its waterfall listener. */
function register(t, socketPath) {
	const previousSocketPath = process.env.SEEKDOCK_PLAN_REVIEW_SOCKET;
	process.env.SEEKDOCK_PLAN_REVIEW_SOCKET = socketPath;
	t.after(() => {
		if (previousSocketPath === undefined) {
			delete process.env.SEEKDOCK_PLAN_REVIEW_SOCKET;
		} else {
			process.env.SEEKDOCK_PLAN_REVIEW_SOCKET = previousSocketPath;
		}
	});
	let listener;
	apply({
		logger: { warn() {} },
		on(event, handler) {
			if (event === 'user-questions/request') {
				listener = handler;
			}
		},
	});
	assert.ok(listener !== undefined, 'the bridge did not register a user-questions answerer');
	return listener;
}

/** One fake host: record each forwarded frame and reply with `reply(frame)`. */
async function startHost(t, reply) {
	const socketPath = createSocketPath();
	const frames = [];
	const server = createServer(socket => {
		let input = '';
		socket.setEncoding('utf8');
		socket.on('data', chunk => {
			input += chunk;
			const newline = input.indexOf('\n');
			if (newline === -1) {
				return;
			}
			const frame = JSON.parse(input.slice(0, newline));
			frames.push(frame);
			socket.end(`${JSON.stringify(reply(frame))}\n`);
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});
	t.after(() => new Promise(resolve => server.close(() => resolve())));
	return { socketPath, frames };
}

function createSocketPath() {
	return process.platform === 'win32'
		? `\\\\.\\pipe\\seekdock-plan-review-test-${process.pid}-${randomUUID()}`
		: join(
			tmpdir(),
			`seekdock-plan-review-test-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
}
