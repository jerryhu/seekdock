# Change Log

All notable changes to the "seekdock" extension will be documented in this file.

## [0.1.0] - 2026-10-27

First public release: the DeepSeek Harness AI coding assistant integrated into VS Code.

### Added

- **DeepSeek Harness Agent**: Conversations, reasoning, tool calling, and code edits are delegated to the bundled DSH SDK runtime (pinned compatibility matrix in the `dshCompatibility` field of `package.json`).
- **Ready to use out of the box**: each platform-specific VSIX bundles the DeepSeek Harness runtime, so no separate install or launch is required. Supported targets: Linux x64/arm64, macOS x64/arm64, and Windows x64.
- **Dedicated chat sidebar**: auxiliary sidebar with a three-column workflow across file explorer, editor, and chat; open it from the editor title icon, `Cmd+Alt+L`, or the `SeekDock: Open DeepSeek` command.
- **Conversation history**: browse previous sessions, restore them after restarting VS Code, and confirm before deleting. History is read from DSH's JSONL session store and resumed through `session/resume`.
- **Skills**: type `/` in the input box to search and select multiple skills, then send `/name` commands together with the message.
- **Permission modes**: Read-only, Workspace Write, Full Access, and experimental Auto Review. Approvals are surfaced in VS Code rather than bypassing DSH's `tools/pre-execute` guard.
- **Real-time output**: assistant responses and reasoning stream as they are generated, and generation can be stopped while keeping what has already been displayed.
- **Personalized settings**: set the DeepSeek API key (stored in `SecretStorage`) and a custom system prompt inside the extension, with one-click restore to the default prompt.
- **Targeted packaging**: per-platform `npm run package:<target>` scripts build the VSIX artifacts, with runtime preparation, verification, and smoke checks in the release pipeline.

### Notes

- DeepSeek Harness is in developer preview and may introduce breaking changes; DSH dependencies are pinned to exact versions.
- Requires VS Code `^1.139.0` and a `DEEPSEEK_API_KEY`.
