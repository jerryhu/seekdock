import * as assert from 'node:assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { resolveDshRuntime } from '../host/dsh-runtime.ts';

const VIEW_ID = 'seekdock.chatView';
const CONTAINER_COMMAND_ID = 'workbench.view.extension.seekdockChat';

/** Polls until the predicate holds, waiting at most timeoutMs. */
async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 10000,
	intervalMs = 200
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	return false;
}

interface Diagnostics {
	chatViewResolved?: boolean;
	settingsPanelResolved?: boolean;
	openPath?: 'none' | 'focusView' | 'containerFallback';
}

/** Reads the state of the running extension instance (the module imported here is not the instance loaded by the host). */
async function readDiagnostics(): Promise<Diagnostics> {
	try {
		const result = await vscode.commands.executeCommand<Diagnostics>('seekdock._diagnostics');
		return result ?? {};
	} catch {
		return {};
	}
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('extension can be activated', async () => {
		// package.json declares no publisher, so look the extension up by package name instead of hardcoding an ID.
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, 'seekdock extension not found; make sure it is loaded as a development extension');
		await extension.activate();
		assert.ok(extension.isActive, 'extension failed to activate');
	});

	test('sidebar view and container command are registered', async () => {
		const commands = await vscode.commands.getCommands(true);

		// The view ID itself is not a command, but VS Code generates `<viewId>.focus` for every view.
		assert.ok(
			commands.includes(`${VIEW_ID}.focus`),
			`view focus command ${VIEW_ID}.focus was not generated; check that contributes.views declares this view`
		);
		assert.ok(
			commands.includes(CONTAINER_COMMAND_ID),
			`container open command ${CONTAINER_COMMAND_ID} is not registered; check contributes.viewsContainers`
		);
		assert.ok(
			commands.includes('seekdock.openSidebar'),
			'open-sidebar command is not registered'
		);
		assert.ok(
			commands.includes('seekdock.newChat'),
			'new-chat command is not registered'
		);
		assert.ok(
			commands.includes('seekdock.openSettings'),
			'open-settings command is not registered'
		);
	});

	test('extension icon and editor title bar icon resources are complete', async () => {
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, 'seekdock extension not found');

		const extensionIcon = extension.packageJSON?.icon;
		assert.strictEqual(
			extensionIcon,
			'resources/seekdock-icon.png',
			'extension icon does not point to resources/seekdock-icon.png',
		);

		type MenuEntry = { command?: string };
		const menus = (extension.packageJSON?.contributes?.menus ?? {}) as Record<string, MenuEntry[]>;
		const titleEntries = menus['editor/title'] ?? [];
		const viewTitleEntries = menus['view/title'] ?? [];
		assert.ok(
			titleEntries.some(entry => entry.command === 'seekdock.openSidebar'),
			'contributes.menus["editor/title"] does not declare seekdock.openSidebar, so no entry icon appears in the tab bar'
		);
		assert.ok(
			!viewTitleEntries.some(entry => entry.command === 'seekdock.openSettings'),
			'the extension-level view title bar still declares a settings entry; settings should only be opened from the Webview header icon'
		);
		const commands = (extension.packageJSON?.contributes?.commands ?? []) as Array<{
			command?: string;
			icon?: string;
		}>;
		assert.deepStrictEqual(
			commands.find(entry => entry.command === 'seekdock.openSettings')?.icon,
			'$(settings-gear)',
			'settings entry does not use the settings-gear icon',
		);

		const iconPaths = [
			extensionIcon,
			'resources/seekdock.svg',
			'resources/seekdock-light.svg',
			'resources/seekdock-dark.svg',
		];
		for (const iconPath of iconPaths) {
			const stat = await vscode.workspace.fs.stat(
				vscode.Uri.joinPath(extension.extensionUri, iconPath)
			);
			assert.ok(stat.size > 0, `${iconPath} is missing or empty`);
		}
	});

	test('running the open command actually creates the sidebar view', async () => {
		// The view may not be instantiated before it is opened.
		await vscode.commands.executeCommand('seekdock.openSidebar');

		const resolved = await waitFor(async () => {
			const diagnostics = await readDiagnostics();
			return diagnostics.chatViewResolved === true;
		});

		assert.ok(
			resolved,
			'WebviewViewProvider was not called after running seekdock.openSidebar; the sidebar view did not actually open'
		);

		// The primary path (focusing the view) should be used, not the container fallback.
		const diagnostics = await readDiagnostics();
		assert.strictEqual(
			diagnostics.openPath,
			'focusView',
			`opening the sidebar took an unexpected branch: ${diagnostics.openPath}, which means ${VIEW_ID}.focus failed`
		);
	});

	test('settings command creates a standalone settings panel', async () => {
		await vscode.commands.executeCommand('seekdock.openSettings');

		const resolved = await waitFor(async () => {
			const diagnostics = await readDiagnostics();
			return diagnostics.settingsPanelResolved === true;
		});

		assert.ok(resolved, 'no standalone settings panel was created after running seekdock.openSettings');
	});

	test('macOS arm64 runtime is bundled with the extension and resolvable', async () => {
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, 'seekdock extension not found');

		const runtime = resolveDshRuntime(extension.extensionUri.fsPath, 'darwin', 'arm64');
		assert.strictEqual(runtime.target, 'macos-arm64');
		assert.strictEqual(runtime.version, '0.2.1rc2');
		assert.ok(runtime.executablePath.endsWith('deepseek-harness-sdk-runtime-macos-arm64'));
	});
});
