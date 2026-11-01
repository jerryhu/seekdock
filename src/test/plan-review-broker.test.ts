import * as assert from 'node:assert';
import { connect } from 'node:net';
import {
	PlanReviewBroker,
	type PlanReviewQuestion,
} from '../host/plan-review-broker.ts';

const PLAN = '# Add a widget\n\n1. Read the composer\n2. Render the widget';

suite('Plan review broker', () => {
	test('forwards one plan review and answers with the approving option label', async () => {
		const questions: PlanReviewQuestion[] = [];
		const broker = new PlanReviewBroker({
			onQuestion: async (question) => {
				questions.push(question);
				return 'approve';
			},
		});
		await broker.start();
		try {
			const reply = await askBroker(broker.socketPath, {
				sessionId: 'session-1',
				questionId: 'plan-review',
				callId: 'call-1',
				plan: PLAN,
				approveLabel: 'Approve',
			});
			assert.deepStrictEqual(reply, {
				outcome: 'answered',
				answers: [{ id: 'plan-review', selected: ['Approve'] }],
			});
			assert.deepStrictEqual(questions, [{
				sessionId: 'session-1',
				questionId: 'plan-review',
				callId: 'call-1',
				plan: PLAN,
				approveLabel: 'Approve',
			}]);
		} finally {
			await broker.dispose();
		}
	});

	test('ends the reviewed turn when the user asks for plan changes', async () => {
		const broker = new PlanReviewBroker({ onQuestion: async () => 'request-changes' });
		await broker.start();
		try {
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, {
					sessionId: 'session-1',
					questionId: 'plan-review',
					callId: 'call-1',
					plan: PLAN,
					approveLabel: 'Approve',
				}),
				{ outcome: 'cancelled' },
			);
		} finally {
			await broker.dispose();
		}
	});

	test('fails closed for malformed frames, unanswered reviews, and handler errors', async () => {
		const broker = new PlanReviewBroker({
			onQuestion: async question => {
				if (question.callId === 'call-throw') {
					throw new Error('webview gone');
				}
				return undefined;
			},
		});
		await broker.start();
		try {
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, { sessionId: 'session-1', plan: PLAN }),
				{ outcome: 'unavailable' },
			);
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, {
					sessionId: 'session-1',
					questionId: 'plan-review',
					callId: 'call-throw',
					plan: PLAN,
					approveLabel: 'Approve',
				}),
				{ outcome: 'unavailable' },
			);
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, {
					sessionId: 'session-1',
					questionId: 'plan-review',
					callId: 'call-unanswered',
					plan: PLAN,
					approveLabel: 'Approve',
				}),
				{ outcome: 'unavailable' },
			);
		} finally {
			await broker.dispose();
		}
	});
});

function askBroker(
	socketPath: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) {
				reject(error);
				return;
			}
			try {
				resolve(JSON.parse(response) as Record<string, unknown>);
			} catch (parseError) {
				reject(parseError);
			}
		};
		const timer = setTimeout(
			() => finish(new Error('Plan review broker did not answer.')),
			5_000,
		);
		socket.setEncoding('utf8');
		socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', error => finish(error));
		socket.once('end', () => finish());
	});
}
