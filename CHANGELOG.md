# Change Log

All notable changes to the "otak-usage" extension will be documented in this file.

## [1.0.0] - 2026-06-10

### Added
- Status bar display of API-equivalent costs for Claude Code and OpenAI Codex CLI (`✦` / `⬡` segments).
- Per-model tooltip breakdown with Today and This Month columns.
- Click-to-toggle between Today and This Month; `otakUsage.period` setting.
- Incremental log scanning with byte-offset cache persisted in `globalState` (one-time full scan only).
- Claude transcript deduplication (`message.id` + `requestId`) and 5m/1h cache-write pricing.
- Codex `last_token_usage` accumulation with `turn_context` model attribution and cached-input pricing.
- Pricing tables for Claude Fable/Opus/Sonnet/Haiku and GPT-5.x/Codex families, with `otakUsage.pricingOverrides` for unknown or future models.
- Remote support (`extensionKind: ["workspace", "ui"]`) for Codespaces, Dev Containers, and Remote-SSH; `CLAUDE_CONFIG_DIR` / `CODEX_HOME` respected.
- Commands: Toggle Period, Refresh Usage.
