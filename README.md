# SeekDock

SeekDock is an unofficial VS Code extension built on DeepSeek Harness. The
user-facing Marketplace listing is maintained separately in
[MARKETPLACE_README.md](MARKETPLACE_README.md).

This README documents development, architecture, packaging, and publishing. For
installation requirements, feature descriptions, and usage instructions shown
to extension users, refer to the Marketplace README.

## 当前状态

- 当前只构建 macOS arm64 安装包；运行时载荷不提交到 Git。
- `resources/runtime/manifest.json` 已列出后续要支持的五个平台目标。
- 使用官方完整 SDK profile（`dsh-base + sdk-app`），并附加实时助手流和提示词注入补丁。
- SDK 与 Python runtime 使用精确版本锁定，兼容矩阵记录在 `package.json` 的
  `dshCompatibility` 字段中。

运行时来自 Python SDK 的同版本 per-platform wheel
`deepseek-harness-runtime-bin==0.2.1rc2`，与 TypeScript SDK `0.2.1-rc.2`
精确锁定。`npm run prepare-runtime` 会从固定 GitHub Release 下载运行时压缩资产，
校验大小与 SHA-256 后解压到 `resources/runtime/<target>/`，再由 VSIX 一并打包。
最终用户安装 VSIX 后不需要额外下载运行时；只有构建机器首次打包需要访问该 Release。

会话日志由 DSH 的 JSONL persistence 管理，位于扩展全局存储目录下的
`dsh-home/sessions/`。SeekDock 只读 DSH 的 session 历史，并通过
`session/resume` 恢复会话，不另建会话数据库。

## 开发与打包

安装依赖并执行严格检查：

```bash
npm install
npm run check-types
npm run lint
npm run test
```

构建 macOS arm64 安装包：

```bash
npm run package:mac-arm64
```

产物为 `seekdock-darwin-arm64-<version>.vsix`。`npm run package` 会执行类型检查、
lint、runtime 下载与校验、esbuild 和一次无模型请求的 SDK 握手 smoke test。
`package:mac-arm64` 通过 `vscode:prepublish` 完成同一套准备流程，只执行一次。

维护 runtime Release 时，先从本地已校验的 runtime 生成可上传资产：

```bash
npm run build-runtime-assets
```

产物位于 `dist/runtime-assets/`，包含三个 gzip 文件、许可证、第三方声明和
`SHA256SUMS`。将这些文件上传到 manifest 中 `release.tag` 对应的 GitHub Release。
离线构建可通过 `SEEKDOCK_RUNTIME_ASSET_DIR=/absolute/asset/directory` 使用本地资产目录。

## 发布

插件市场说明使用 `MARKETPLACE_README.md`，而不是开发用的 `README.md`。发布时显式传入
市场文案：

```bash
npx --yes @vscode/vsce publish --readme MARKETPLACE_README.md
```

也可以运行：

```bash
npm run publish:marketplace
```

该脚本内部执行同一条带 `--readme MARKETPLACE_README.md` 参数的发布命令。

## 架构说明

### 权限模式与自动审查（实验）

输入框底部提供与 DeepSeek Harness 桌面版一致的权限选择器。面向用户的模式说明位于
`MARKETPLACE_README.md`。

权限切换通过 DSH 的 `permissionPresets` 服务完成，SeekDock 不维护第二套权限表。
`resources/dsh/seekdock-permission-bridge.mjs` 只在进程内读取目录与当前值，并把用户选择
交回 DSH。新会话在第一条消息发送前创建（不发起模型请求），因此可以在发送前切换模式。

自动审查由 `@deepseek-ai/dsh-experimental-auto-review` 提供。打包的 SDK runtime 把该包
嵌套在自身 `@deepseek-ai/dsh` 的安装目录下，补丁里的裸包名无法从 `resources/dsh` 解析，
所以 `seekdock-auto-review.mjs` 通过 Cordis loader 的 profile 基准导入并挂载它。运行时
若未携带该包，选择器会自动退回三种内置模式，并在运行时日志中记录原因。

自动审查拒绝的调用会进入 DSH 的 `ask` 审批策略。`seekdock-approval-bridge.mjs` 把审批
问题转发到对应的工具卡片，用户可以「允许一次」或「拒绝」；没有可用回答者时保持
fail-closed，绝不会默认放行。

### Skills

输入框输入 `/` 会读取当前 DSH session composition 可用的技能目录，并在输入框上方按来源
分组显示。发送时 SeekDock 会按 chip 顺序还原为 DSH 原生的 `/name` 文本指令，由 DSH
在 pre-step 阶段注入完整技能说明。

目录扫描和同名覆盖优先级由 `@deepseek-ai/dsh-skill-filesystem` 处理。
SeekDock 仅读取当前项目根目录的 `.agents/skills` 和用户主目录的 `.agents/skills`，
分别显示为 `Workspace` 与 `User` 分组。runtime 使用隔离 HOME 时，用户级技能仍从真实
用户主目录读取。

### 右侧栏（Secondary Side Bar）聊天面板

SeekDock 的聊天视图默认停靠在编辑器的右侧辅助侧边栏中。聊天视图通过
`contributes.viewsContainers.secondarySidebar` 声明式注册，不需要在运行时把视图搬移到
辅助侧边栏，因此用户手动拖动过的布局不会被覆盖。

图标统一使用`seekdock-icon.svg`中的 SeekDock 品牌标志。活动栏需要单色遮罩，
扩展管理页需要 PNG，因此这两处由源 SVG 派生出独立资源，其余界面直接复用完整配色。

| 文件 | 使用位置 | 渲染方式 |
| --- | --- | --- |
| `resources/seekdock.svg` | 右侧栏视图容器图标、视图图标 | VS Code 按遮罩（mask）着色，只取图形、颜色由主题决定，因此使用单色 `currentColor` |
| `resources/seekdock-light.svg` | 编辑器标签栏的 SeekDock 按钮（浅色主题） | VS Code 以 16px 背景图直接渲染、不做遮罩，因此保留完整品牌配色 |
| `resources/seekdock-dark.svg` | 编辑器标签栏的 SeekDock 按钮（深色主题） | 同上 |
| `resources/seekdock-icon.png` | 扩展管理页标题左侧的扩展图标 | 由源 SVG 导出的 128×128 透明 PNG |

完整配色的图标在浅色与深色背景上都保持清晰，因此深浅两套标题栏文件当前内容一致。

### 设置

设置页在聊天 Webview 内切换显示，采用侧栏分类导航。API Key 通过 VS Code `SecretStorage` 保存，
不会回传到 Webview；提示词保存在 `ExtensionContext.globalState`，默认文本来自
`resources/default-system-prompt.md`。

启动 DSH runtime 前，扩展会把当前生效提示词同步到全局存储目录，并通过
`SEEKDOCK_SYSTEM_PROMPT_PATH` 传给
`resources/dsh/seekdock-system-prompt.mjs`。该插件通过 DSH
`ctx.systemPrompt.section()` 注册 persona 前置段，工具执行和系统提示组装仍由
DeepSeek Harness 负责。
