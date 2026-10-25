import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import {
	isApprovalDecision,
	type Approval,
	type ApprovalDecision,
	type AssistantContentBlock,
	type AssistantStreamDelta,
	type ToolCall,
} from '../shared/rpc.ts';
import {
	isNonNegativeInteger,
	isPositiveInteger,
} from '../shared/value-validation.ts';

/** One UI-relevant activity distilled from a DSH session notification. */
export type HarnessActivityEvent =
	| {
		type: 'assistantStreamStart';
		attemptId: string;
		turn: number;
		step: number;
	}
	| { type: 'assistantStreamDelta'; delta: AssistantStreamDelta }
	| { type: 'assistantStreamEnd'; attemptId: string }
	| {
		type: 'assistantMessage';
		turn: number;
		step: number;
		blocks: readonly AssistantContentBlock[];
		interrupted?: boolean;
	}
	| { type: 'toolCallStart'; call: ToolCall }
	| { type: 'toolCallUpdate'; call: ToolCall }
	| { type: 'approvalRequest'; approval: Approval }
	| {
		type: 'approvalResolved';
		approvalId: string;
		toolCallId?: string;
		decision: ApprovalDecision;
	}
	| { type: 'permissionChanged' }
	| { type: 'planModeChanged' }
	| { type: 'turnError'; message: string };

/**
 * Translates root-session DSH notifications into the small event vocabulary
 * consumed by the extension host. Child-session activity is ignored here
 * because the current UI renders only the answer of the root agent.
 */
export class HarnessEventTranslator {
	private readonly calls = new Map<string, ToolCall>();
	private readonly approvals = new Map<string, string>();

	constructor(private readonly sessionId: string) { }

	/**
	 * Translate one SDK notification without throwing on unknown or malformed
	 * events. Protocol validation remains the SDK's responsibility.
	 *
	 * @param notification - Notification emitted by the DSH SDK.
	 * @returns Zero or more UI activity events.
	 */
	translate(notification: HarnessNotification): HarnessActivityEvent[] {
		if (notification.method === 'seekdock/assistant-stream') {
			return this.assistantStream(notification.params);
		}
		if (notification.method !== 'session.event') {
			return [];
		}
		const params = asRecord(notification.params);
		if (params?.sessionId !== this.sessionId) {
			return [];
		}
		const event = asRecord(params.event);
		if (event === undefined || typeof event.type !== 'string') {
			return [];
		}
		const data = asRecord(event.data);
		if (data === undefined) {
			return [];
		}

		switch (event.type) {
			case 'assistant/message':
				return this.assistantMessage(data);
			case 'tool/call':
				return this.toolCall(data);
			case 'tool/result':
				return this.toolResult(data);
			case 'approval/asked':
				return this.approvalRequest(data);
			case 'approval/decided':
				return this.approvalResolved(data);
			case 'permission/preset':
			case 'sandbox/mode':
			case 'approval/policy':
				return [{ type: 'permissionChanged' }];
			case 'plan/mode':
				return [{ type: 'planModeChanged' }];
			case 'turn/end': {
				const reason = asRecord(data.reason);
				if (reason?.kind !== 'error') {
					return [];
				}
				const error = asRecord(reason.error);
				const message = typeof error?.message === 'string'
					? error.message
					: 'DeepSeek Harness ended the turn with an error.';
				return [{ type: 'turnError', message }];
			}
			default:
				return [];
		}
	}

	private assistantStream(params: Record<string, unknown>): HarnessActivityEvent[] {
		if (params.sessionId !== this.sessionId) {
			return [];
		}
		const frame = asRecord(params.frame);
		if (frame === undefined || typeof frame.attemptId !== 'string') {
			return [];
		}
		switch (frame.type) {
			case 'start':
				if (!isPositiveInteger(frame.turn) || !isPositiveInteger(frame.step)) {
					return [];
				}
				return [{
					type: 'assistantStreamStart',
					attemptId: frame.attemptId,
					turn: frame.turn,
					step: frame.step,
				}];
			case 'chunk': {
				const chunk = asRecord(frame.chunk);
				if (chunk === undefined
					|| !isPositiveInteger(frame.turn)
					|| !isPositiveInteger(frame.step)
					|| !isNonNegativeInteger(chunk.index)) {
					return [];
				}
				let delta: AssistantStreamDelta | undefined;
				switch (chunk.type) {
					case 'text-delta':
						if (typeof chunk.text === 'string') {
							delta = this.streamDelta(frame, chunk.index, 'text', chunk.text);
						}
						break;
					case 'reasoning-delta':
						if (typeof chunk.text === 'string') {
							delta = this.streamDelta(frame, chunk.index, 'reasoning', chunk.text);
						}
						break;
					case 'tool-call-delta':
						if (typeof chunk.name === 'string' && chunk.name.length > 0) {
							delta = this.streamDelta(frame, chunk.index, 'tool', chunk.name);
						}
						break;
				}
				return delta === undefined ? [] : [{ type: 'assistantStreamDelta', delta }];
			}
			case 'end':
				return [{ type: 'assistantStreamEnd', attemptId: frame.attemptId }];
			default:
				return [];
		}
	}

	private streamDelta(
		frame: Record<string, unknown>,
		blockIndex: number,
		kind: AssistantStreamDelta['kind'],
		text: string,
	): AssistantStreamDelta {
		return {
			attemptId: frame.attemptId as string,
			turn: frame.turn as number,
			step: frame.step as number,
			blockIndex,
			kind,
			text,
		};
	}

	private assistantMessage(data: Record<string, unknown>): HarnessActivityEvent[] {
		if (!isPositiveInteger(data.turn) || !isPositiveInteger(data.step)) {
			return [];
		}
		const message = asRecord(data.message);
		const blocks = assistantContentBlocks(message?.content);
		return [{
			type: 'assistantMessage',
			turn: data.turn,
			step: data.step,
			blocks,
			...(data.interrupted === true ? { interrupted: true } : {}),
		}];
	}

	private toolCall(data: Record<string, unknown>): HarnessActivityEvent[] {
		if (typeof data.callId !== 'string'
			|| typeof data.name !== 'string'
			|| typeof data.arguments !== 'string') {
			return [];
		}
		const call: ToolCall = {
			id: data.callId,
			name: data.name,
			arguments: data.arguments,
			status: 'running',
		};
		this.calls.set(call.id, call);
		return [{ type: 'toolCallStart', call }];
	}

	private toolResult(data: Record<string, unknown>): HarnessActivityEvent[] {
		const message = asRecord(data.message);
		if (typeof message?.toolCallId !== 'string') {
			return [];
		}
		const previous = this.calls.get(message.toolCallId);
		const isError = message.isError === true;
		const error = asRecord(data.error);
		const resultText = contentText(message.content);
		const call: ToolCall = {
			id: message.toolCallId,
			name: previous?.name ?? 'tool',
			arguments: previous?.arguments ?? '',
			status: isError ? 'error' : 'completed',
			...(resultText.length === 0 ? {} : { result: resultText }),
			...(isError
				? { error: stringValue(error?.reason) ?? resultText ?? 'Tool execution failed.' }
				: {}),
		};
		this.calls.set(call.id, call);
		return [{ type: 'toolCallUpdate', call }];
	}

	private approvalRequest(data: Record<string, unknown>): HarnessActivityEvent[] {
		if (typeof data.id !== 'string' || typeof data.toolName !== 'string') {
			return [];
		}
		const approval: Approval = {
			id: data.id,
			toolName: data.toolName,
			...(typeof data.callId === 'string' ? { toolCallId: data.callId } : {}),
			...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
		};
		if (approval.toolCallId !== undefined) {
			this.approvals.set(approval.id, approval.toolCallId);
			const previous = this.calls.get(approval.toolCallId);
			if (previous !== undefined) {
				const call = { ...previous, status: 'awaiting-approval' as const };
				this.calls.set(call.id, call);
			}
		}
		return [{ type: 'approvalRequest', approval }];
	}

	private approvalResolved(data: Record<string, unknown>): HarnessActivityEvent[] {
		if (typeof data.id !== 'string' || !isApprovalOutcome(data.outcome)) {
			return [];
		}
		const toolCallId = this.approvals.get(data.id);
		this.approvals.delete(data.id);
		return [{
			type: 'approvalResolved',
			approvalId: data.id,
			...(toolCallId === undefined ? {} : { toolCallId }),
			decision: data.outcome === 'allowed-once' ? 'allowed' : data.outcome,
		}];
	}
}

function contentText(value: unknown): string {
	if (!Array.isArray(value)) {
		return '';
	}
	return value
		.flatMap((block) => {
			const record = asRecord(block);
			return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
		})
		.join('');
}

function assistantContentBlocks(value: unknown): AssistantContentBlock[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((block): AssistantContentBlock[] => {
		const record = asRecord(block);
		if (record?.type === 'text' && typeof record.text === 'string') {
			return [{ kind: 'text', text: record.text }];
		}
		if (record?.type === 'reasoning' && typeof record.text === 'string') {
			return [{ kind: 'reasoning', text: record.text }];
		}
		return [];
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isApprovalOutcome(value: unknown): value is ApprovalDecision | 'allowed-once' {
	return value === 'allowed-once' || isApprovalDecision(value);
}
