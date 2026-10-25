import * as vscode from 'vscode';
import {
	LocalizedError,
	translate,
	type Language,
} from '../shared/i18n/index.ts';
import {
	isSettingsToHostMessage,
	type HostToSettingsMessage,
	type SettingsSaveKind,
	type SettingsSkillCatalog,
	type SettingsState,
	type SettingsToHostMessage,
} from '../shared/settings-rpc.ts';
import { formatErrorMessage } from './error-format.ts';
import { createWebviewDocument } from './webview-document.ts';

/**
 * Operations owned by the extension host and exposed to the standalone
 * settings Webview.
 */
export interface SettingsHost {
	prewarmRuntime(): void;
	getSettingsState(): Promise<SettingsState>;
	getLanguage(): Language;
	setLanguage(language: Language): Promise<void>;
	setApiKey(apiKey: string): Promise<void>;
	saveSystemPrompt(prompt: string): Promise<void>;
	resetSystemPrompt(): Promise<void>;
	getSkillCatalog(): Promise<SettingsSkillCatalog>;
	setSkillEnabled(name: string, enabled: boolean): Promise<void>;
	openSkill(name: string): Promise<void>;
}

interface SettingsAction {
	requestId: string;
	action: () => Promise<void>;
	/** Follow-up message omitted when the action already posted its result. */
	onSuccess?: () => Promise<void>;
	/** Value to redact if the operation fails after seeing a credential. */
	sensitiveValue?: string;
}

/**
 * Owns the standalone settings panel and its typed Webview lifecycle.
 *
 * Chat state stays in `ChatViewProvider`; this panel only forwards settings
 * operations to that host and translates failures into the panel protocol.
 */
export class SettingsWebviewPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly host: SettingsHost,
		private readonly onDispose: () => void,
	) {
		this.create();
	}

	reveal(): void {
		if (this.panel === undefined) {
			this.create();
		}
		this.panel?.reveal(undefined, false);
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	async postState(state: SettingsState): Promise<void> {
		if (this.panel !== undefined) {
			this.panel.title = translate(state.language, 'hostSettingsTitle');
		}
		await this.post({ type: 'state', state });
	}

	private create(): void {
		const panel = vscode.window.createWebviewPanel(
			'seekdock.settings',
			translate(this.host.getLanguage(), 'hostSettingsTitle'),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri],
			},
		);
		this.panel = panel;
		panel.webview.onDidReceiveMessage((message: unknown) => {
			if (isSettingsToHostMessage(message)) {
				void this.handleMessage(message);
			}
		});
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
				this.onDispose();
			}
		});
		const language = this.host.getLanguage();
		panel.webview.html = createWebviewDocument({
			extensionUri: this.extensionUri,
			webview: panel.webview,
			language,
			title: translate(language, 'hostSettingsTitle'),
			scriptFileName: 'settings-webview.js',
			bodyClass: 'settings-panel-body',
		});
	}

	private async handleMessage(message: SettingsToHostMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.postState(await this.host.getSettingsState());
				this.host.prewarmRuntime();
				break;
			case 'saveApiKey': {
				const apiKey = message.apiKey.trim();
				await this.runAction({
					requestId: message.requestId,
					sensitiveValue: message.apiKey,
					action: async () => {
						if (apiKey.length === 0) {
							throw new LocalizedError('hostApiKeyRequired');
						}
						await this.host.setApiKey(apiKey);
						await this.postState(await this.host.getSettingsState());
					},
					onSuccess: () => this.postSaved(message.requestId, 'apiKey'),
				});
				break;
			}
			case 'saveSystemPrompt':
				await this.runAction({
					requestId: message.requestId,
					action: () => this.host.saveSystemPrompt(message.prompt),
					onSuccess: () => this.postSaved(message.requestId, 'systemPrompt'),
				});
				break;
			case 'resetSystemPrompt':
				await this.runAction({
					requestId: message.requestId,
					action: () => this.host.resetSystemPrompt(),
					onSuccess: () => this.postSaved(message.requestId, 'resetSystemPrompt'),
				});
				break;
			case 'requestSkills':
				await this.runAction({
					requestId: message.requestId,
					action: async () => {
						const catalog = await this.host.getSkillCatalog();
						await this.post({
							type: 'skillCatalog',
							requestId: message.requestId,
							roots: catalog.roots,
							skills: catalog.skills,
						});
					},
				});
				break;
			case 'setSkillEnabled':
				await this.runAction({
					requestId: message.requestId,
					action: () => this.host.setSkillEnabled(message.name, message.enabled),
					onSuccess: () => this.postSaved(message.requestId, 'skill'),
				});
				break;
			case 'openSkill':
				await this.runAction({
					requestId: message.requestId,
					action: () => this.host.openSkill(message.name),
					onSuccess: () => this.postSaved(message.requestId, 'openSkill'),
				});
				break;
			case 'setLanguage':
				await this.runAction({
					requestId: message.requestId,
					action: () => this.host.setLanguage(message.language),
					onSuccess: () => this.postSaved(message.requestId, 'language'),
				});
				break;
		}
	}

	private async runAction(options: SettingsAction): Promise<void> {
		try {
			await options.action();
			await options.onSuccess?.();
		} catch (error) {
			// All settings failures use one response shape; the Webview restores
			// the optimistic state associated with the failed request id.
			await this.post({
				type: 'error',
				requestId: options.requestId,
				message: formatErrorMessage(
					error,
					options.sensitiveValue ?? '',
					this.host.getLanguage(),
				),
			});
		}
	}

	private postSaved(requestId: string, kind: SettingsSaveKind): Promise<void> {
		return this.post({ type: 'saved', requestId, kind });
	}

	private async post(message: HostToSettingsMessage): Promise<void> {
		try {
			await this.panel?.webview.postMessage(message);
		} catch (error) {
			console.error('SeekDock: failed to post a settings Webview message', error);
		}
	}
}
