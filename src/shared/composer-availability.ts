import type { RuntimeStatus } from './rpc.ts';

/** Runtime and conversation facts that decide what the composer accepts. */
export interface ComposerAvailability {
	/** An API key is stored, so a turn can eventually run. */
	configured: boolean;
	/** A turn is already running. */
	busy: boolean;
	/** Lifecycle state of the DSH runtime behind the composer. */
	runtimeStatus: RuntimeStatus;
}

/** What the composer currently accepts. */
export interface ComposerDecisions {
	/** Whether the prompt box takes text. */
	editable: boolean;
	/** Whether sending starts a turn now, or queues it behind runtime startup. */
	sendable: boolean;
}

/**
 * Decide composer input from runtime state. Typing never depends on the
 * runtime: a working-directory switch replaces the runtime process for about a
 * second, and locking the draft during it is the longest wait a user can hit
 * while nothing else requires attention. Sending during `initializing` is
 * allowed because the host queues the prompt behind the runtime handshake
 * instead of running it on the outgoing process.
 *
 * @param state - Configured, busy, and runtime lifecycle flags.
 * @returns whether the draft is editable and whether sending is accepted.
 */
export function composerDecisions(state: ComposerAvailability): ComposerDecisions {
	return {
		editable: state.configured,
		sendable: state.configured
			&& !state.busy
			&& (state.runtimeStatus === 'ready' || state.runtimeStatus === 'initializing'),
	};
}
