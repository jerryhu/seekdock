import type { AssistantStreamDelta } from '../shared/rpc.ts';

/**
 * Coalesces assistant deltas into short batches before crossing the
 * extension-host/Webview boundary. The default window keeps streaming
 * responsive while avoiding a postMessage and render for every token.
 */
export class StreamDeltaBatcher {
	private buffered: AssistantStreamDelta[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sendChain: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly send: (deltas: readonly AssistantStreamDelta[]) => Promise<void>,
		private readonly delayMs = 40,
		private readonly onError: (error: unknown) => void = () => { },
	) { }

	push(delta: AssistantStreamDelta): void {
		if (this.closed || delta.text.length === 0) {
			return;
		}
		const previous = this.buffered.at(-1);
		if (delta.kind !== 'tool'
			&& previous?.kind === delta.kind
			&& previous.attemptId === delta.attemptId
			&& previous.turn === delta.turn
			&& previous.step === delta.step
			&& previous.blockIndex === delta.blockIndex) {
			this.buffered[this.buffered.length - 1] = {
				...previous,
				text: previous.text + delta.text,
			};
		} else {
			this.buffered.push({ ...delta });
		}
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			void this.flush().catch(this.onError);
		}, this.delayMs);
	}

	async flush(): Promise<void> {
		this.clearTimer();
		const deltas = this.buffered;
		this.buffered = [];
		if (deltas.length > 0) {
			this.sendChain = this.sendChain.then(() => this.send(deltas));
		}
		await this.sendChain;
	}

	async close(): Promise<void> {
		await this.flush();
		this.closed = true;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
