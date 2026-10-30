<h1 align="center">SeekDock</h1>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-Hans.md">简体中文</a>
</p>

<strong>SeekDock 是一个基于 DeepSeek Harness 构建的 VS Code 扩展</strong>

**开箱即用：** SeekDock 已内置 DeepSeek Harness 运行时。安装扩展后无需额外安装或启动
DeepSeek Harness，配置 DeepSeek API Key 后即可使用。

## 运行与兼容性

- **开箱即用**：每个平台 VSIX 均内置对应目标的 DeepSeek Harness 运行时，用户无需另行
  安装、下载或启动 DeepSeek Harness。
- **平台支持**：支持 Linux x64/arm64、macOS x64/arm64 与 Windows x64。
- **兼容锁定**：使用官方完整 SDK profile（`dsh-base + sdk-app`），并附加实时助手流和
  提示词注入补丁；SDK 与 Python runtime 精确锁定，兼容矩阵记录在 `package.json` 的
  `dshCompatibility` 字段中。
- **会话恢复**：会话日志由 DSH 的 JSONL persistence 管理，位于扩展全局存储目录下的
  `dsh-home/sessions/`；SeekDock 只读历史并通过 `session/resume` 恢复，不另建会话数据库。

## 开发与打包

安装依赖并执行严格检查：

```bash
npm install
npm run check-types
npm run lint
npm run test
```

构建全部平台安装包：

```bash
npm run package:all
```

也可以单独构建某个目标：

```bash
npm run package:linux-x64
npm run package:linux-arm64
npm run package:mac-arm64
npm run package:mac-x64
npm run package:win-x64
```

产物命名为 `seekdock-<vscode-target>-<version>.vsix`，例如
`seekdock-darwin-arm64-0.1.0.vsix` 和 `seekdock-win32-x64-0.1.0.vsix`。
`npm run package` 会执行类型检查、lint、目标 runtime 下载与校验、esbuild 和
SDK 握手 smoke test；非当前主机的目标会验证完整载荷，但跳过只能在该系统执行的启动测试。
平台打包脚本通过 `vscode:prepublish` 完成同一套准备流程，并移除其他目标的二进制，
避免 VSIX 夹带无关运行时。

离线构建可将五个 wheel 放入同一目录，再设置
`SEEKDOCK_RUNTIME_ASSET_DIR=/absolute/wheel/directory`。文件名必须与 manifest 一致。

### 运行时载荷

运行时来自 Python SDK 的同版本 per-platform wheel
`deepseek-harness-runtime-bin==0.2.1rc2`，与 TypeScript SDK `0.2.1-rc.2`
精确锁定。`npm run prepare-runtime` 会从官方 PyPI 下载当前目标或
`SEEKDOCK_RUNTIME_TARGET` 指定的 wheel，校验大小与 SHA-256 后解出运行时文件和许可证，
再由 VSIX 一并打包。最终用户安装后无需额外下载运行时；只有构建机器首次打包需要访问 PyPI。

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

### 设置

设置页在聊天 Webview 内切换显示，采用侧栏分类导航。API Key 通过 VS Code `SecretStorage` 保存，
不会回传到 Webview；提示词保存在 `ExtensionContext.globalState`，默认文本来自
`resources/default-system-prompt.md`。

启动 DSH runtime 前，扩展会把当前生效提示词同步到全局存储目录，并通过
`SEEKDOCK_SYSTEM_PROMPT_PATH` 传给
`resources/dsh/seekdock-system-prompt.mjs`。该插件通过 DSH
`ctx.systemPrompt.section()` 注册 persona 前置段，工具执行和系统提示组装仍由
DeepSeek Harness 负责。

### MCP 服务器

设置页新增 MCP 服务器页签，运行时由 `@deepseek-ai/dsh-mcp-client` 提供。服务器声明保存在
`<globalStorageUri>/mcp/servers.json`；设置变化后会重新生成 DSH 补丁，并在下次使用 runtime
时重启加载。stdio 服务器的工作目录默认使用工作区根目录，仅支持 `stdio` 和 DSH 的
Streamable HTTP 传输。

`${secret:name}` 的值保存在 VS Code `SecretStorage` 中，仅在启动 runtime 时注入进程环境；
`${workspaceFolder}` 会解析为当前工作区根目录，其他 `${...}` 变量会直接校验失败。导入功能
只读读取 `.vscode/mcp.json`、`~/.codex/config.toml`、`~/.claude.json` 和
`~/.cursor/mcp.json`。不符合 DSH 服务器名规则的导入名称会按 DSH ACP 相同的
slug + 8 位 hash 策略规范化，并在 UI 中同时显示原名称与映射名称；SSE 声明会明确提示不支持。
