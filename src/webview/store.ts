import type {
	Approval,
	ApprovalDecision,
	AssistantContentBlock,
	AssistantStreamDelta,
	HostToWebviewMessage,
	ToolCall,
	TranscriptMessage,
} from '../shared/rpc.ts';

export type MessageId = string;

export interface UserMessage {
	kind: 'user';
	id: MessageId;
	text: string;
	createdAt: number;
}

export type AssistantEntry =
	| { kind: 'text'; id: string; text: string }
	| { kind: 'reasoning'; id: string; text: string }
	| { kind: 'tool'; id: string; call: ToolCall }
	| { kind: 'approval'; id: string; approval: Approval };

export interface AssistantLiveBlock {
	blockIndex: number;
	kind: 'text' | 'reasoning';
	text: string;
}

export interface AssistantLive {
	attemptId: string;
	turn: number;
	step: number;
	phase: 'thinking' | 'writing' | 'tool';
	toolName?: string;
	blocks: readonly AssistantLiveBlock[];
}

export interface AssistantMessage {
	kind: 'assistant';
	id: MessageId;
	requestId: string;
	entries: readonly AssistantEntry[];
	status: 'streaming' | 'complete' | 'cancelled' | 'error';
	error?: string;
	live?: AssistantLive;
	createdAt: number;
	durationMs?: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

/**
 * Small observable conversation store. Text updates notify only the affected
 * assistant message, so Preact does not reconcile every historical message
 * while a response is streaming.
 */
export class ConversationStore {
	private readonly messages = new Map<MessageId, ChatMessage>();
	private readonly assistantByRequest = new Map<string, MessageId>();
	private readonly messageListeners = new Map<MessageId, Set<() => void>>();
	private readonly orderListeners = new Set<() => void>();
	private order: readonly MessageId[] = [];
	private activeRequestId: string | undefined;
	private nextEntryId = 0;

	getOrder(): readonly MessageId[] {
		return this.order;
	}

	getMessage(id: MessageId): ChatMessage | undefined {
		return this.messages.get(id);
	}

	subscribeOrder(listener: () => void): () => void {
		this.orderListeners.add(listener);
		return () => {
			this.orderListeners.delete(listener);
		};
	}

	subscribeMessage(id: MessageId, listener: () => void): () => void {
		let listeners = this.messageListeners.get(id);
		if (listeners === undefined) {
			listeners = new Set();
			this.messageListeners.set(id, listeners);
		}
		listeners.add(listener);
		return () => {
			const current = this.messageListeners.get(id);
			current?.delete(listener);
			if (current?.size === 0) {
				this.messageListeners.delete(id);
			}
		};
	}

	/**
	 * Add the user prompt and its empty assistant placeholder immediately.
	 *
	 * @returns false when another request is already active.
	 */
	beginRequest(requestId: string, text: string): boolean {
		if (this.activeRequestId !== undefined) {
			return false;
		}
		const now = Date.now();
		const userId = `${requestId}:user`;
		const assistantId = `${requestId}:assistant`;
		this.activeRequestId = requestId;
		this.assistantByRequest.set(requestId, assistantId);
		this.messages.set(userId, { kind: 'user', id: userId, text, createdAt: now });
		this.messages.set(assistantId, {
			kind: 'assistant',
			id: assistantId,
			requestId,
			entries: [],
			status: 'streaming',
			createdAt: now,
		});
		this.order = [...this.order, userId, assistantId];
		this.notifyOrder();
		return true;
	}

	handleHostMessage(message: HostToWebviewMessage): void {
		// The app forwards every typed host message here; conversation store
		// messages are handled below and unrelated UI state is intentionally ignored.
		switch (message.type) {
			case 'responseStart':
				this.touchAssistant(message.requestId, message => ({ ...message, status: 'streaming' }));
				break;
			case 'assistantStreamStart':
				this.startAssistantStream(message.requestId, message.attemptId, message.turn, message.step);
				break;
			case 'assistantStreamDelta':
				this.appendAssistantDeltas(message.requestId, message.deltas);
				break;
			case 'assistantStreamEnd':
				this.endAssistantStream(message.requestId, message.attemptId);
				break;
			case 'assistantMessage':
				this.addAssistantMessage(
					message.requestId,
					message.turn,
					message.step,
					message.blocks,
				);
				break;
			case 'toolCallStart':
				this.upsertTool(message.requestId, message.call);
				break;
			case 'toolCallUpdate':
				this.upsertTool(message.requestId, message.call);
				break;
			case 'approvalRequest':
				this.addApproval(message.requestId, message.approval);
				break;
			case 'approvalResolved':
				this.resolveApproval(message.approvalId, message.toolCallId, message.decision);
				break;
			case 'responseEnd':
				this.finishRequest(message.requestId, message.interrupted === true);
				break;
			case 'error':
				this.failRequest(message.requestId, message.message);
				break;
			default:
				break;
		}
	}

	reset(): void {
		this.messages.clear();
		this.assistantByRequest.clear();
		this.activeRequestId = undefined;
		this.order = [];
		this.nextEntryId = 0;
		this.notifyOrder();
	}

	/** Replace the current transcript with a session loaded from DSH history. */
	loadTranscript(messages: readonly TranscriptMessage[]): void {
		this.reset();
		const order: MessageId[] = [];
		for (const message of messages) {
			const chatMessage: ChatMessage = message.kind === 'user'
				? message
				: {
					kind: 'assistant',
					id: message.id,
					requestId: `history:${message.id}`,
					entries: message.entries,
					status: 'complete',
					createdAt: message.createdAt,
					...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
				};
			this.messages.set(message.id, chatMessage);
			order.push(message.id);
		}
		this.order = order;
		this.notifyOrder();
	}

	private startAssistantStream(
		requestId: string,
		attemptId: string,
		turn: number,
		step: number,
	): void {
		this.touchAssistant(requestId, message => ({
			...message,
			live: {
				attemptId,
				turn,
				step,
				phase: 'thinking',
				blocks: [],
			},
		}));
	}

	private appendAssistantDeltas(
		requestId: string,
		deltas: readonly AssistantStreamDelta[],
	): void {
		if (deltas.length === 0) {
			return;
		}
		this.touchAssistant(requestId, (message) => {
			let live = message.live;
			for (const delta of deltas) {
				// A late delta from a previous attempt must start a fresh live view
				// instead of appending text to the current attempt.
				if (live === undefined || live.attemptId !== delta.attemptId) {
					live = {
						attemptId: delta.attemptId,
						turn: delta.turn,
						step: delta.step,
						phase: 'thinking',
						blocks: [],
					};
				}
				if (delta.kind === 'tool') {
					live = {
						...live,
						phase: 'tool',
						...(delta.text.length === 0 ? {} : { toolName: delta.text }),
					};
					continue;
				}
				if (delta.text.length === 0) {
					continue;
				}
				const blocks = [...live.blocks];
				const index = blocks.findIndex(block => block.blockIndex === delta.blockIndex);
				if (index === -1) {
					blocks.push({
						blockIndex: delta.blockIndex,
						kind: delta.kind,
						text: delta.text,
					});
				} else {
					const previous = blocks[index];
					// DSH may reuse a block index with a different kind after a
					// reasoning-to-text transition, so the newer kind wins.
					blocks[index] = previous?.kind === delta.kind
						? { ...previous, text: previous.text + delta.text }
						: { blockIndex: delta.blockIndex, kind: delta.kind, text: delta.text };
				}
				blocks.sort((left, right) => left.blockIndex - right.blockIndex);
				live = {
					...live,
					phase: delta.kind === 'reasoning' ? 'thinking' : 'writing',
					blocks,
				};
			}
			return { ...message, live };
		});
	}

	private endAssistantStream(requestId: string, attemptId: string): void {
		this.touchAssistant(requestId, message => (
			message.live?.attemptId === attemptId
				? { ...message, live: undefined }
				: message
		));
	}

	private addAssistantMessage(
		requestId: string,
		turn: number,
		step: number,
		blocks: readonly AssistantContentBlock[],
	): void {
		this.touchAssistant(requestId, (message) => {
			const entries = [...message.entries];
			blocks.forEach((block, index) => {
				if (block.text.length === 0) {
					return;
				}
				entries.push({
					kind: block.kind,
					id: `assistant-${turn}-${step}-${index}`,
					text: block.text,
				});
			});
			return {
				...message,
				entries,
				live: message.live?.turn === turn && message.live.step === step
					? undefined
					: message.live,
			};
		});
	}

	private upsertTool(requestId: string, call: ToolCall): void {
		this.touchAssistant(requestId, (message) => {
			const entries = [...message.entries];
			const index = entries.findIndex(entry => entry.kind === 'tool' && entry.call.id === call.id);
			if (index === -1) {
				entries.push({ kind: 'tool', id: this.entryId(`tool-${call.id}`), call });
			} else {
				const entry = entries[index];
				if (entry?.kind === 'tool') {
					entries[index] = { ...entry, call };
				}
			}
			return {
				...message,
				entries,
				...(call.status === 'running' ? { live: undefined } : {}),
			};
		});
	}

	private addApproval(requestId: string, approval: Approval): void {
		this.touchAssistant(requestId, (message) => {
			const entries = [...message.entries];
			if (approval.toolCallId !== undefined) {
				const index = entries.findIndex(
					entry => entry.kind === 'tool' && entry.call.id === approval.toolCallId,
				);
				if (index !== -1) {
					const entry = entries[index];
					if (entry.kind === 'tool' && entry.call.status !== 'awaiting-approval') {
						entries[index] = {
							...entry,
							call: { ...entry.call, status: 'awaiting-approval' },
						};
					}
				}
			}
			// The bridge question and the durable audit event describe the same
			// tool call; keep one card and let the later source fill its fields.
			const existingIndex = entries.findIndex((entry) => entry.kind === 'approval'
				&& ((approval.toolCallId !== undefined
					&& entry.approval.toolCallId === approval.toolCallId)
					|| entry.approval.id === approval.id));
			if (existingIndex === -1) {
				entries.push({
					kind: 'approval',
					id: this.entryId(`approval-${approval.id}`),
					approval,
				});
			} else {
				const entry = entries[existingIndex];
				if (entry.kind === 'approval') {
					entries[existingIndex] = {
						...entry,
						approval: {
							...entry.approval,
							...approval,
							id: entry.approval.id,
							decision: entry.approval.decision ?? approval.decision,
						},
					};
				}
			}
			return { ...message, entries };
		});
	}

	/** Mark one approval card with the closed outcome DSH committed. */
	private resolveApproval(
		approvalId: string,
		toolCallId: string | undefined,
		decision: ApprovalDecision,
	): void {
		for (const id of this.assistantByRequest.values()) {
			const message = this.messages.get(id);
			if (message?.kind !== 'assistant') {
				continue;
			}
			let changed = false;
			const entries = message.entries.map((entry) => {
				if (entry.kind !== 'approval') {
					return entry;
				}
				const matches = (toolCallId !== undefined && entry.approval.toolCallId === toolCallId)
					|| entry.approval.id === approvalId;
				if (!matches) {
					return entry;
				}
				changed = true;
				return { ...entry, approval: { ...entry.approval, decision } };
			});
			if (!changed) {
				continue;
			}
			this.messages.set(id, { ...message, entries });
			this.notifyMessage(id);
		}
	}

	private finishRequest(requestId: string, interrupted: boolean): void {
		this.touchAssistant(requestId, message => ({
			...message,
			status: message.status === 'error'
				? 'error'
				: interrupted ? 'cancelled' : 'complete',
			live: undefined,
			durationMs: message.durationMs ?? Math.max(0, Date.now() - message.createdAt),
		}));
		if (this.activeRequestId === requestId) {
			this.activeRequestId = undefined;
		}
	}

	private failRequest(requestId: string, error: string): void {
		this.touchAssistant(requestId, message => ({
			...message,
			status: 'error',
			error,
			live: undefined,
			durationMs: message.durationMs ?? Math.max(0, Date.now() - message.createdAt),
		}));
		if (this.activeRequestId === requestId) {
			this.activeRequestId = undefined;
		}
	}

	private touchAssistant(
		requestId: string,
		update: (message: AssistantMessage) => AssistantMessage,
	): void {
		const id = this.assistantByRequest.get(requestId);
		if (id === undefined) {
			return;
		}
		const message = this.messages.get(id);
		if (message?.kind !== 'assistant') {
			return;
		}
		const next = update(message);
		this.messages.set(id, next);
		this.notifyMessage(id);
	}

	private notifyMessage(id: MessageId): void {
		for (const listener of this.messageListeners.get(id) ?? []) {
			listener();
		}
	}

	private notifyOrder(): void {
		for (const listener of this.orderListeners) {
			listener();
		}
	}

	private entryId(prefix: string): string {
		this.nextEntryId += 1;
		return `${prefix}:${this.nextEntryId}`;
	}
}
