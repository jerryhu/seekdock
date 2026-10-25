import * as assert from 'node:assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { resolveDshRuntime } from '../host/dsh-runtime.ts';

const VIEW_ID = 'seekdock.chatView';
const CONTAINER_COMMAND_ID = 'workbench.view.extension.seekdockChat';

/** 轮询等待条件成立，最长等待 timeoutMs。 */
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

/** 读取正在运行的扩展实例状态（测试内 import 的模块与宿主加载的实例不是同一个）。 */
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

	test('扩展可被激活', async () => {
		// package.json 未声明 publisher，因此按包名动态查找，不硬编码扩展 ID。
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, '未找到 seekdock 扩展，确认已作为开发扩展加载');
		await extension.activate();
		assert.ok(extension.isActive, '扩展激活失败');
	});

	test('右侧栏视图与容器命令均已注册', async () => {
		const commands = await vscode.commands.getCommands(true);

		// 视图 ID 本身不是命令，但 VS Code 会为每个视图自动生成 `<viewId>.focus`。
		assert.ok(
			commands.includes(`${VIEW_ID}.focus`),
			`未生成视图聚焦命令 ${VIEW_ID}.focus，检查 contributes.views 是否声明了该视图`
		);
		assert.ok(
			commands.includes(CONTAINER_COMMAND_ID),
			`容器打开命令 ${CONTAINER_COMMAND_ID} 未注册，检查 contributes.viewsContainers`
		);
		assert.ok(
			commands.includes('seekdock.openSidebar'),
			'打开右侧栏命令未注册'
		);
		assert.ok(
			commands.includes('seekdock.newChat'),
			'新建会话命令未注册'
		);
		assert.ok(
			commands.includes('seekdock.openSettings'),
			'打开设置页面命令未注册'
		);
	});

	test('扩展安装图标与编辑器标题栏图标资源完整', async () => {
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, '未找到 seekdock 扩展');

		const extensionIcon = extension.packageJSON?.icon;
		assert.strictEqual(
			extensionIcon,
			'resources/seekdock-icon.png',
			'扩展安装图标未指向 resources/seekdock-icon.png',
		);

		type MenuEntry = { command?: string };
		const menus = (extension.packageJSON?.contributes?.menus ?? {}) as Record<string, MenuEntry[]>;
		const titleEntries = menus['editor/title'] ?? [];
		const viewTitleEntries = menus['view/title'] ?? [];
		assert.ok(
			titleEntries.some(entry => entry.command === 'seekdock.openSidebar'),
			'contributes.menus["editor/title"] 未声明 seekdock.openSidebar，标签栏不会出现入口图标'
		);
		assert.ok(
			!viewTitleEntries.some(entry => entry.command === 'seekdock.openSettings'),
			'插件级视图标题栏仍声明了设置入口；设置应只由 Webview 顶部的图标打开'
		);
		const commands = (extension.packageJSON?.contributes?.commands ?? []) as Array<{
			command?: string;
			icon?: string;
		}>;
		assert.deepStrictEqual(
			commands.find(entry => entry.command === 'seekdock.openSettings')?.icon,
			'$(settings-gear)',
			'设置入口未使用 settings-gear 图标',
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
			assert.ok(stat.size > 0, `${iconPath} 缺失或为空`);
		}
	});

	test('执行打开命令后右侧栏视图确实被创建', async () => {
		// 打开前视图可能尚未实例化。
		await vscode.commands.executeCommand('seekdock.openSidebar');

		const resolved = await waitFor(async () => {
			const diagnostics = await readDiagnostics();
			return diagnostics.chatViewResolved === true;
		});

		assert.ok(
			resolved,
			'执行 seekdock.openSidebar 后 WebviewViewProvider 未被调用，右侧栏视图未真正打开'
		);

		// 应走主路径（聚焦视图），而不是容器兜底路径。
		const diagnostics = await readDiagnostics();
		assert.strictEqual(
			diagnostics.openPath,
			'focusView',
			`打开右侧栏走了非预期分支：${diagnostics.openPath}，说明 ${VIEW_ID}.focus 执行失败`
		);
	});

	test('设置命令创建独立设置面板', async () => {
		await vscode.commands.executeCommand('seekdock.openSettings');

		const resolved = await waitFor(async () => {
			const diagnostics = await readDiagnostics();
			return diagnostics.settingsPanelResolved === true;
		});

		assert.ok(resolved, '执行 seekdock.openSettings 后未创建独立设置面板');
	});

	test('macOS arm64 runtime 已随扩展打包且可解析', async () => {
		const extension = vscode.extensions.all.find(
			item => item.packageJSON?.name === 'seekdock'
		);
		assert.ok(extension, '未找到 seekdock 扩展');

		const runtime = resolveDshRuntime(extension.extensionUri.fsPath, 'darwin', 'arm64');
		assert.strictEqual(runtime.target, 'macos-arm64');
		assert.strictEqual(runtime.version, '0.2.1rc2');
		assert.ok(runtime.executablePath.endsWith('deepseek-harness-sdk-runtime-macos-arm64'));
	});
});
