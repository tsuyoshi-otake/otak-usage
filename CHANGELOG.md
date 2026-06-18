# Change Log

All notable changes to the "otak-usage" extension will be documented in this file.

## [Unreleased]

### Added
- Daily combined Claude + Codex cost alert (`otakUsage.dailyAlertThresholdUsd`, default `$10.00`). When today's API-equivalent total reaches the threshold, VS Code shows a notification with an action to open the setting; `0` disables the alert.
- Localization for extension settings, commands, and runtime alert/status messages in G20 major locales: English, Arabic, German, Spanish, French, Hindi, Indonesian, Italian, Japanese, Korean, Brazilian Portuguese, Russian, Turkish, Simplified Chinese, Traditional Chinese, plus Vietnamese.

## [1.1.0] - 2026-06-12

### Added
- RTK (Rust Token Killer) integration: when the `rtk` CLI is installed, the tooltip shows a `⚡` Token Savings table (Input / Output / Saved / Rate for Today, This Month, and All Time) and the Copy Summary output gains an `RTK saved:` line. Data comes from `rtk gain --daily --format json`; the section is hidden automatically when rtk is not installed. New settings: `otakUsage.showRtk`, `otakUsage.rtkPath`.

### Removed
- The "Some models have no known pricing" warning in the tooltip. Unknown models still appear with `n/a` costs and can be priced via `otakUsage.pricingOverrides`.

### Fixed
- Claude streaming partials are no longer double-counted: when the final record of a request supersedes an earlier partial snapshot, the earlier contribution is replaced instead of dropped or added twice (scan cache v3, re-ingests the current month).
- Codex turns logged twice are now deduplicated by timestamp + token tuple.

## [1.0.2] - 2026-06-10

### Added
- Claude fast mode (`usage.speed: "fast"`) is now billed at the fast-mode premium and shown as a separate `<model>-fast` row (Opus 4.6/4.7 $30/$150, Opus 4.8 $10/$50; cache multipliers stack on the fast price).
- Pricing for `gpt-5.4-mini` and `gpt-5.4-nano`.

### Fixed
- `gpt-5.4-pro` price corrected to $30/$180 per the official pricing page.
- Codex `cached_input_tokens` is capped at `input_tokens` so a malformed record cannot inflate the cost.
- Scan cache version bumped (v2) to re-ingest the current month, so already-recorded fast-mode usage is repriced automatically.

## [1.0.1] - 2026-06-10

### Added
- "Copy Summary" link in the tooltip and `Otak Usage: Copy Usage Summary` command - copies a plain-text per-model breakdown to the clipboard.
- Pricing for legacy models: Claude 3.x family and pre-GPT-5 Codex CLI models (codex-mini, o3/o4-mini, gpt-4.1, gpt-4o).

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
