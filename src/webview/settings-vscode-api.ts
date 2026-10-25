import type { SettingsToHostMessage } from '../shared/settings-rpc.ts';

export interface SettingsVsCodeApi {
	postMessage(message: SettingsToHostMessage): void;
}

declare function acquireVsCodeApi(): SettingsVsCodeApi;

export const settingsVsCodeApi = acquireVsCodeApi();
