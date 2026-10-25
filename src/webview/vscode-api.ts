import type { ComposerFile, WebviewToHostMessage } from '../shared/rpc.ts';

export interface WebviewState {
	draft?: string;
	files?: readonly ComposerFile[];
}

export interface VsCodeApi {
	getState(): WebviewState | undefined;
	postMessage(message: WebviewToHostMessage): void;
	setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
