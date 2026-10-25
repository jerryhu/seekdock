import * as assert from 'node:assert';
import { connect } from 'node:net';
import { ApprovalBroker, type ApprovalQuestion } from '../host/approval-broker.ts';

suite('Approval broker', () => {
	test('forwards one tool question and answers with the pending decision', async () => {
		const questions: ApprovalQuestion[] = [];
		const broker = new ApprovalBroker({
			onQuestion: async (question) => {
				questions.push(question);
				return 'allowed-once';
			},
		});
		await broker.start();
		try {
			const reply = await askBroker(broker.socketPath, {
				toolName: 'bash',
				toolCallId: 'call-1',
				sessionId: 'session-1',
				reason: 'Auto review denied this call',
				displayReason: { en: 'Auto review denied this call', zh: '自动审查拒绝了此调用' },
			});
			assert.deepStrictEqual(reply, { outcome: 'allowed-once' });
			assert.deepStrictEqual(questions, [{
				sessionId: 'session-1',
				toolCallId: 'call-1',
				toolName: 'bash',
				reason: 'Auto review denied this call',
				displayReason: '自动审查拒绝了此调用',
			}]);
		} finally {
			await broker.dispose();
		}
	});

	test('accepts the legacy callId field and fails closed for malformed frames', async () => {
		const broker = new ApprovalBroker({
			onQuestion: async question => question.toolCallId === 'call-legacy'
				? 'rejected'
				: 'allowed-once',
		});
		await broker.start();
		try {
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, {
					toolName: 'bash',
					callId: 'call-legacy',
					sessionId: 'session-1',
				}),
				{ outcome: 'rejected' },
			);
			assert.deepStrictEqual(
				await askBroker(broker.socketPath, { toolName: 'bash' }),
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
): Promise<{ outcome: string }> {
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
				resolve(JSON.parse(response) as { outcome: string });
			} catch (parseError) {
				reject(parseError);
			}
		};
		const timer = setTimeout(() => finish(new Error('Approval broker did not answer.')), 5_000);
		socket.setEncoding('utf8');
		socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on('data', chunk => {
			response += chunk;
		});
		socket.once('error', error => finish(error));
		socket.once('end', () => finish());
	});
}
