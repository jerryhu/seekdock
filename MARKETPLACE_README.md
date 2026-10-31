# SeekDock

SeekDock is a DeepSeek Harness AI coding assistant that runs in VS Code. It brings DeepSeek Harness Agents, tool calling, Skills, conversation history, and permission controls into the editor, with a dedicated auxiliary sidebar for chat.

**Ready to use out of the box:** SeekDock includes the DeepSeek Harness runtime. There is no need to install or launch DeepSeek Harness separately. Simply configure your DeepSeek API key to get started.

## Key Features

- **DeepSeek Harness Agent**: Uses the official DSH SDK runtime for conversations, reasoning, tool calling, and code modifications.
- **Right-side auxiliary sidebar**: Provides a compact three-column workflow across the file explorer, editor, and chat.
- **Conversation history**: Browse previous conversations, restore them after restarting VS Code, and confirm before deleting them. Sessions are stored in `~/.seekdock`, so uninstalling or reinstalling the extension keeps them; builds up to 0.1.0 stored sessions inside VS Code's extension storage and are migrated automatically on first activation.
- **Skills**: Type `/` in the input box to search for and select multiple Skills, then send `/name` commands with your message.
- **Permission modes**: Offers four modes: Read-only, Workspace Write, Full Access, and experimental Auto Review.
- **Real-time output**: Stop generation while the Agent is running, while keeping responses and reasoning content that have already been displayed.
- **Personalized settings**: Change your DeepSeek API key and system prompt within the extension, and restore the default prompt when needed.

## Getting Started

1. Install SeekDock.
2. Click the SeekDock icon in the upper-right corner of the editor, or press `Cmd+Alt+L` on macOS (`Ctrl+Alt+L` on Windows and Linux).
3. Enter your DeepSeek API key in the chat view.
4. Choose a permission mode and start asking questions.

You can also open the chat panel from the Command Palette by running `SeekDock: Open SeekDock`.

## Requirements

- VS Code `1.139.0` or later.
- Supports Linux x64/arm64, macOS x64/arm64, and Windows x64.
- The DeepSeek Harness runtime is built in; no separate installation or launch is required.
- A DeepSeek API key is required before use.

## Data and Privacy

- The API key is managed by VS Code `SecretStorage` and is not written to workspace settings or source code.
- Conversations and tool execution are handled by DeepSeek Harness.
- Conversation history is managed by DeepSeek Harness JSONL persistence and stored in the extension's global storage directory.

## Source Code and Feedback

SeekDock is open source: [github.com/jerryhu/seekdock](https://github.com/jerryhu/seekdock).

Found a bug or have an idea for a new feature? Please open an issue at [github.com/jerryhu/seekdock/issues](https://github.com/jerryhu/seekdock/issues). Issue reports and feature requests are the fastest way to get problems fixed and improvements prioritized; please include your VS Code version, operating system, and reproduction steps.

## Disclaimer

DeepSeek, DeepSeek Harness, and related names are trademarks or project names of their respective owners.
SeekDock is an unofficial community extension.
