import * as assert from 'node:assert';
import type { AssistantStreamDelta } from '../shared/rpc.ts';
import { StreamDeltaBatcher } from '../host/stream-delta-batcher.ts';

suite('Stream delta batcher', () => {
	test('coalesces adjacent deltas and preserves kind and block boundaries', async () => {
		const sent: AssistantStreamDelta[][] = [];
		const batcher = new StreamDeltaBatcher(async deltas => {
			sent.push([...deltas]);
		}, 5);
		batcher.push(delta('reasoning', 'check', 0));
		batcher.push(delta('reasoning', 'ing', 0));
		batcher.push(delta('text', 'answer', 1));
		await batcher.flush();
		assert.deepStrictEqual(sent, [[
			delta('reasoning', 'checking', 0),
			delta('text', 'answer', 1),
		]]);
		batcher.push(delta('text', ' next', 1));
		await batcher.close();
		assert.deepStrictEqual(sent[1], [delta('text', ' next', 1)]);
		batcher.push(delta('text', 'ignored', 1));
		await batcher.flush();
		assert.strictEqual(sent.length, 2);
	});

	test('flushes automatically after the batching window', async () => {
		const sent: AssistantStreamDelta[][] = [];
		const batcher = new StreamDeltaBatcher(async deltas => {
			sent.push([...deltas]);
		}, 5);
		batcher.push(delta('tool', 'read_file', 0));
		await new Promise(resolve => setTimeout(resolve, 25));
		assert.deepStrictEqual(sent, [[delta('tool', 'read_file', 0)]]);
		await batcher.close();
	});
});

function delta(
	kind: AssistantStreamDelta['kind'],
	text: string,
	blockIndex: number,
): AssistantStreamDelta {
	return {
		attemptId: 'attempt-1',
		turn: 1,
		step: 1,
		blockIndex,
		kind,
		text,
	};
}
