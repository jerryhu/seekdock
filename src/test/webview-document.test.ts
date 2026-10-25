import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
	createWebviewDocument,
	type WebviewDocumentHost,
} from '../host/webview-document.ts';

suite('Webview document', () => {
	const extensionUri = vscode.Uri.file('/extension');
	const webview: WebviewDocumentHost = {
		cspSource: 'vscode-resource:',
		asWebviewUri: uri => uri,
	};

	test('uses one strict CSP for chat and settings documents', () => {
		const chatHtml = createWebviewDocument({
			extensionUri,
			webview,
			language: 'en',
			title: 'SeekDock',
			scriptFileName: 'webview.js',
		});
		const settingsHtml = createWebviewDocument({
			extensionUri,
			webview,
			language: 'zh-cn',
			title: 'Settings',
			scriptFileName: 'settings-webview.js',
			bodyClass: 'settings-panel-body',
		});

		const expectedPolicy = "default-src 'none'; style-src vscode-resource:; script-src 'nonce-";
		assert.ok(chatHtml.includes(expectedPolicy));
		assert.ok(settingsHtml.includes(expectedPolicy));
		assert.ok(settingsHtml.includes('<body class="settings-panel-body">'));
		assert.ok(settingsHtml.includes('settings-webview.js'));
	});
});
