<h1 align="center">SeekDock</h1>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-Hans.md">简体中文</a>
</p>

<strong>SeekDock is a VS Code extension built on DeepSeek Harness.</strong>

**Ready to use out of the box:** SeekDock bundles the DeepSeek Harness runtime. After installing the extension, you do not need to install or launch DeepSeek Harness separately. Simply configure your DeepSeek API key to get started.

## Runtime and Compatibility

- **Ready to use out of the box:** Each platform-specific VSIX bundles the DeepSeek Harness runtime for its target platform. Users do not need to separately install, download, or launch DeepSeek Harness.
- **Platform support:** Linux x64/arm64, macOS x64/arm64, and Windows x64.
- **Pinned compatibility:** Uses the official full SDK profile (`dsh-base + sdk-app`), with additional patches for live assistant streaming and prompt injection. The SDK and Python runtime versions are pinned precisely. The compatibility matrix is recorded in the `dshCompatibility` field in `package.json`.
- **Session recovery:** DSH manages session logs through JSONL persistence under `dsh-home/sessions/` in the extension's global storage directory. SeekDock reads the history and resumes sessions through `session/resume`; it does not create a separate session database.

## Development and Packaging

Install dependencies and run the strict checks:

```bash
npm install
npm run check-types
npm run lint
npm run test
```

Build installation packages for all platforms:

```bash
npm run package:all
```

You can also build for a specific target:

```bash
npm run package:linux-x64
npm run package:linux-arm64
npm run package:mac-arm64
npm run package:mac-x64
npm run package:win-x64
```

The output files are named `seekdock-<vscode-target>-<version>.vsix`, for example, `seekdock-darwin-arm64-0.1.0.vsix` and `seekdock-win32-x64-0.1.0.vsix`.

`npm run package` runs type checking, linting, target-runtime download and verification, esbuild, and an SDK handshake smoke test. For targets other than the current host, it verifies the complete payload but skips startup tests that can only run on the target operating system.

Platform packaging scripts use `vscode:prepublish` to run the same preparation workflow and remove binaries for other targets, preventing unrelated runtimes from being bundled in the VSIX.

For offline builds, place all five wheels in the same directory and set `SEEKDOCK_RUNTIME_ASSET_DIR=/absolute/wheel/directory`. The filenames must match those in the manifest.

### Runtime Payload

The runtime comes from the Python SDK's matching per-platform wheel, `deepseek-harness-runtime-bin==0.2.1rc2`, and is pinned to TypeScript SDK version `0.2.1-rc.2`.

`npm run prepare-runtime` downloads the wheel for the current target or the target specified by `SEEKDOCK_RUNTIME_TARGET` from the official PyPI repository. It verifies the file size and SHA-256 checksum, then extracts the runtime files and licenses for inclusion in the VSIX. End users do not need to download the runtime separately after installation; only the build machine needs PyPI access when packaging for the first time.

## Architecture

### Permission Modes and Auto Review (Experimental)

A permission selector matching the DeepSeek Harness desktop app is available at the bottom of the input box. User-facing descriptions of the modes are provided in `MARKETPLACE_README.md`.

Permission switching is handled by DSH's `permissionPresets` service, so SeekDock does not maintain a second permission table. `resources/dsh/seekdock-permission-bridge.mjs` reads the available presets and current value within the process, then passes the user's selection back to DSH. A new session is created before the first message is sent (without making a model request), allowing the permission mode to be changed before sending.

Auto review is provided by `@deepseek-ai/dsh-experimental-auto-review`. The packaged SDK runtime nests this package inside its own `@deepseek-ai/dsh` installation directory, so the bare package name in the patch cannot be resolved from `resources/dsh`. To address this, `seekdock-auto-review.mjs` imports and mounts the package using the profile base provided by the Cordis loader. If the package is not included in the runtime, the selector automatically falls back to the three built-in modes and records the reason in the runtime log.

Calls rejected by auto review are routed to DSH's `ask` approval policy. `seekdock-approval-bridge.mjs` forwards approval requests to the corresponding tool card, where users can choose **Allow Once** or **Deny**. If no responder is available, the system fails closed and never grants permission by default.

### Skills

Typing `/` in the input box reads the skill directories available to the current DSH session composition and displays them above the input box, grouped by source. When sending a message, SeekDock reconstructs the chips in order as native DSH `/name` text directives. DSH then injects the full skill instructions during the pre-step phase.

Directory scanning and same-name override precedence are handled by `@deepseek-ai/dsh-skill-filesystem`.

SeekDock reads skills only from `.agents/skills` in the current workspace root and `.agents/skills` in the user's home directory. These are displayed in the **Workspace** and **User** groups, respectively. If the runtime uses an isolated HOME directory, user-level skills are still read from the real user home directory.

### Settings

The settings page is displayed within the chat Webview and uses sidebar category navigation. The API key is stored using VS Code `SecretStorage` and is never sent back to the Webview. Prompts are stored in `ExtensionContext.globalState`, and the default prompt text comes from `resources/default-system-prompt.md`.

Before starting the DSH runtime, the extension syncs the currently active prompt to the global storage directory and passes its path through `SEEKDOCK_SYSTEM_PROMPT_PATH` to `resources/dsh/seekdock-system-prompt.mjs`. This plugin registers a persona preamble using DSH's `ctx.systemPrompt.section()`. Tool execution and system-prompt assembly remain the responsibility of DeepSeek Harness.

### MCP servers

The settings page includes an MCP servers tab backed by `@deepseek-ai/dsh-mcp-client`. Server declarations are stored at `<globalStorageUri>/mcp/servers.json`; each settings change regenerates a DSH patch and restarts the runtime on its next use. Stdio servers default their working directory to the workspace root. Only `stdio` and DSH's Streamable HTTP transport are supported.

`${secret:name}` values are kept in VS Code `SecretStorage` and injected into the runtime process environment, while `${workspaceFolder}` resolves to the active workspace root. Any other `${...}` variable is rejected. The import dialog reads `.vscode/mcp.json`, `~/.codex/config.toml`, `~/.claude.json`, and `~/.cursor/mcp.json` without modifying them. Imported names that do not match DSH's server-name contract are normalized with the same slug-and-hash strategy as DSH ACP, and both names are shown in the UI. SSE declarations are reported as unsupported.

## Publishing

For the extension marketplace, use `MARKETPLACE_README.md` rather than the development `README.md`. Explicitly specify the marketplace README when publishing:

```bash
npx --yes @vscode/vsce publish --readme MARKETPLACE_README.md
```

Alternatively, run:

```bash
npm run publish:marketplace
```

This script runs the same publish command with the `--readme MARKETPLACE_README.md` argument.
