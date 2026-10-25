# SeekDock

SeekDock 是一款运行在 VS Code 中的 DeepSeek Harness AI 编程助手。它将
DeepSeek Harness 的 Agent、工具调用、Skills、会话历史和权限控制带入编辑器，
并通过独立的辅助侧边栏提供对话界面。

SeekDock 是非官方扩展，与 DeepSeek 官方无隶属或背书关系。

## 主要功能

- **DeepSeek Harness Agent**：使用官方 DSH SDK runtime 完成对话、推理、工具调用和代码修改。
- **右侧辅助侧边栏**：在文件树、编辑器和对话之间保持紧凑的三栏工作流。
- **会话历史**：查看最近 8 个会话或完整历史，跨重启恢复，并支持二次确认删除。
- **Skills**：在输入框中输入 `/` 搜索和选择多个 DSH skills，随消息发送 `/name` 指令。
- **权限模式**：提供只读、工作区写入、完全权限和实验性自动审查四种模式。
- **工具审批**：需要审批的工具调用会显示在工具卡片中，可选择允许一次或拒绝。
- **实时输出**：Agent 运行时可以停止生成，并保留已经显示的回答和思考内容。
- **个性化设置**：在扩展内修改 DeepSeek API Key 和系统提示词，并可恢复默认提示词。
- **密钥安全存储**：API Key 仅保存在 VS Code `SecretStorage` 中，不会回传到 Webview。

## 开始使用

1. 安装 SeekDock。
2. 点击编辑器右上角的 SeekDock 图标，或使用 `Cmd+Alt+L`。
3. 在聊天视图中输入 DeepSeek API Key。
4. 选择权限模式并开始提问。

也可以从命令面板运行 `SeekDock: Open SeekDock` 打开聊天面板。

## 权限模式

| 模式 | 说明 |
| --- | --- |
| 只读 | 只能查看，不允许修改文件。 |
| 工作区写入 | 可在当前工作区内读写；越过工作区边界时请求审批。 |
| 完全权限 | 无沙箱限制。选择前需要确认风险。 |
| 自动审查 `EXP` | 无沙箱限制；每次工具调用前由当前模型审查。选择前需要确认实验性风险。 |

自动审查拒绝的工具调用会进入审批流程。没有可用回答者时，调用保持拒绝状态。

## Skills

在输入框中输入 `/` 即可搜索当前会话可用的 Skills。SeekDock 仅从工作区和用户目录
加载 Skills，并允许一次选择多个 Skill。点击已选择的 Skill 可在编辑器中打开对应的
`SKILL.md`。

常用 Skills 目录：

| 作用范围 | 目录 |
| --- | --- |
| Workspace | `<项目根>/.agents/skills` |
| User | `{用户主目录}/.agents/skills` |

## 环境要求

- VS Code `1.139.0` 或更高版本。
- 当前发布包支持 macOS Apple Silicon（arm64）。
- 使用前需要准备 DeepSeek API Key。

DeepSeek Harness 仍处于 developer preview 阶段，后续版本可能存在兼容性变更。

## 数据与隐私

- API Key 由 VS Code `SecretStorage` 管理，不写入项目设置或代码。
- 对话和工具执行由 DeepSeek Harness 处理。
- 会话历史由 DSH 的 JSONL persistence 管理，保存在扩展全局存储目录。
- 文件修改和终端命令必须经过 DSH 工具管道及当前权限策略。

## 说明

DeepSeek、DeepSeek Harness 及相关名称为其各自权利人的商标或项目名称。
SeekDock 是非官方社区扩展。
