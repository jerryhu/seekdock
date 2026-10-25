/**
 * Forward DSH's process-local assistant stream over the SDK's JSON-RPC channel.
 *
 * The shipped SDK server exposes durable session events, while token and
 * reasoning frames are process-local. SeekDock needs those frames to render
 * live activity, so this plugin emits a private notification alongside the
 * normal protocol traffic. It does not participate in model or tool execution.
 */

export const name = 'seekdock-assistant-stream-bridge';

export function apply(ctx) {
	ctx.on('agent/assistant-stream', ({ agent, frame }) => {
		const notification = {
			jsonrpc: '2.0',
			method: 'seekdock/assistant-stream',
			params: {
				sessionId: String(agent.session.id),
				frame,
			},
		};
		process.stdout.write(`${JSON.stringify(notification)}\n`);
	});
}
