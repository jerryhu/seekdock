import type { ComposerSkill } from '../shared/composer-skills.ts';
import type { ComposerFile, WebviewToHostMessage } from '../shared/rpc.ts';

/** Unsent composer draft, kept when the Webview is remounted. */
export interface WebviewState {
	draft?: string;
	files?: readonly ComposerFile[];
	skills?: readonly ComposerSkill[];
}

export interface VsCodeApi {
	getState(): WebviewState | undefined;
	postMessage(message: WebviewToHostMessage): void;
	setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
