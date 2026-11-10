# Change Log


## 0.2.0 (2026-11-10)
#### New feature
- Working-directory picker above the composer
- Plan review cards with Markdown preview; submitted plans are replayed from session history
- Durable data moved to `~/.seekdock`, so sessions survive extension updates and uninstalls
#### Bug fix
- Session history stays clickable while a response is running and shows a busy hint instead of ignoring input
- Composer draft, attachments and skill chips are kept across navigation, runtime restart and session deletion
- Resuming or renaming a session no longer moves it to the top of the session list
- Long first prompts get a model-generated title instead of the truncated fallback (first-prompt title cap 4 KiB -> 32 KiB)

## 0.1.1 (2026-10-31)
- Bug fix -> "DeepSeek Harness returned an invalid plan-mode response"

## 0.1.0 (2026-10-29)
- Initial release
