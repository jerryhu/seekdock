import * as vscode from 'vscode';
import { intlLocale, type Language } from '../shared/i18n/index.ts';

/** Minimal VS Code Webview surface used to build a document. */
export interface WebviewDocumentHost {
	readonly cspSource: string;
	asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

interface WebviewDocumentOptions {
	extensionUri: vscode.Uri;
	webview: WebviewDocumentHost;
	language: Language;
	title: string;
	scriptFileName: 'webview.js' | 'settings-webview.js';
	bodyClass?: string;
}

/**
 * Build the shared HTML shell for all SeekDock Webviews.
 *
 * Keeping the CSP in one place ensures new panels cannot accidentally relax
 * script, style, or font sources. A fresh nonce is generated per render so a
 * script from an earlier document cannot satisfy the current policy.
 */
export function createWebviewDocument(options: WebviewDocumentOptions): string {
	const nonce = createWebviewNonce();
	const styleUri = options.webview.asWebviewUri(
		vscode.Uri.joinPath(options.extensionUri, 'resources', 'main.css')
	);
	const scriptUri = options.webview.asWebviewUri(
		vscode.Uri.joinPath(options.extensionUri, 'dist', options.scriptFileName)
	);
	const bodyClass = options.bodyClass === undefined
		? ''
		: ` class="${options.bodyClass}"`;
	return /* html */ `<!DOCTYPE html>
<html lang="${intlLocale(options.language)}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${options.webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>${options.title}</title>
</head>
<body${bodyClass}>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createWebviewNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let index = 0; index < 32; index += 1) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
