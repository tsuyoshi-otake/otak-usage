# Change Log

All notable changes to the "otak-usage" extension will be documented in this file.

## [1.10.0] - 2026-07-12

### Added

- Codex context optimization (on by default): `otakUsage.optimizeCodexContext` optimizes Codex's maximum context size to save tokens and ease subscription rate limits by writing `model_context_window` and `model_auto_compact_token_limit` into your Codex `config.toml` (values from `otakUsage.codexContextWindow` / `otakUsage.codexAutoCompactLimit`, defaults 250000 / 230000), rewriting them in place if present. Turning it off removes the two keys again. While the toggle stays off, your existing Codex config is left untouched.
- Tooltip **Optimize** link next to **Settings** that jumps straight to the `otakUsage.optimizeCodexContext` toggle.

## [1.9.0] - 2026-07-11

### Added

- Subscription rate-limit alerts: a notification now appears when a shown Claude or Codex rate-limit window (5-hour or weekly) reaches a configurable utilization, set by `otakUsage.limitAlertThresholdPercent` (default 80%). It fires once per window instance and re-arms when the window resets.
- New `otakUsage.alertMode` setting chooses what triggers desktop notifications: `off`, `cost` (the daily USD total), `limit` (the rate-limit percentage), or `both` (default).

### Fixed

- The tooltip **Settings** link now opens all `otakUsage` settings instead of filtering to just the telemetry group.

## [1.8.5] - 2026-07-11

### Added

- Releases are now published to the Open VSX Registry (`odangoo.otak-usage`) alongside the Visual Studio Marketplace.
- README Quick Start now shows the hover tooltip layout (side-by-side Claude Code / Codex CLI columns plus the RTK savings table).

## [1.8.4] - 2026-07-11

### Changed

- Tooltip brand marks now render as theme-coloured inline SVG images sized independently of the status-bar icon font, so the Claude Code / Codex CLI header icons are larger and no longer tied to the status-bar codicon size. They re-tint on theme changes to stay legible in light and dark themes.

## [1.8.3] - 2026-07-11

### Changed

- Enlarged the OpenAI/Claude brand glyphs one more step (700 → 850 em) so they match the optical size of the native Restart (sync) codicon in the status bar.

## [1.8.2] - 2026-07-11

### Changed
- Brand icons back up one step (700/1000 em) — 640 was a touch too small. (#7)
- Claude rate-limit polling relaxed from every minute to every 5 minutes: the usage endpoint returns 429 readily when polled alongside Claude Code's own calls, which showed up as a missing Claude limits row after a window reload. The last snapshot is kept on failure. (#7)

## [1.8.1] - 2026-07-11

### Changed
- Brand icons shrunk another step (640/1000 em, sitting on the baseline) — they were still optically larger than the status-bar text. (#7)

## [1.8.0] - 2026-07-11

### Added
- First-run subscription detection: when a rate-limit snapshot proves a subscription plan (Claude `subscriptionType` or Codex `plan_type`), the status bar defaults to the `limits` view — once. An explicit `statusBarMode` in any settings scope, a disabled `showRateLimits`, or any later change by the user is always respected. (#7)

## [1.7.4] - 2026-07-11

### Changed
- Added a space between each brand icon and its percentage in the status-bar limits view. (#7)

## [1.7.3] - 2026-07-11

### Changed
- Brand icons are drawn at ~76% of the em box (with side bearings) so they match the optical size of the status-bar text instead of towering over it. (#7)
- The combined OpenAI + Claude total is now a single line (`OpenAI + Claude Total: $x / $y`) instead of a two-column table, removing the odd leading gap in the tooltip. (#7)

## [1.7.2] - 2026-07-11

### Changed
- Removed the redundant "Today / This Month" legend line under the provider grid — the `$today / $month` cost format is self-explanatory. (#7)

## [1.7.1] - 2026-07-11

### Changed
- A vertical divider (`│`, sized to the tallest cell of each row) now separates the Claude Code and Codex CLI columns in the tooltip. (#7)

## [1.7.0] - 2026-07-11

### Added
- Claude and OpenAI brand logos, shipped as a bundled icon font (`contributes.icons`), replace the generic `$(sparkle)` / `⬡` glyphs everywhere the providers appear (status bar and tooltip). (#7)

### Changed
- The tooltip now lays Claude Code and Codex CLI out side by side in a two-column grid — limits row, then per-model costs as `today / month` — with RTK savings below. (#7)
- The status-bar limits view shows each provider's **5-hour window** percentage (instead of the most constrained window), so both providers read on the same scale; snapshots without 5-hour data fall back to the weekly window. (#7)

## [1.6.0] - 2026-07-11

### Added
- Clicking the status-bar item now cycles through three views: today's cost → this month's cost → rate limits → back to today's cost (`Otak Usage: Cycle Status Bar View`). Leaving the limits view restores the configured `statusBarMode`, and disabling `otakUsage.showRateLimits` reverts the click to the classic Today/This Month toggle. (#7)
- The tooltip footer hint now reads "Click to switch view" accordingly (all 16 languages).

## [1.5.0] - 2026-07-11

### Added
- Subscription rate-limit display for Claude Code and Codex CLI: the tooltip now shows how much of the 5-hour and weekly windows is used, with reset times and plan type, rendered as one row per window. (#7)
  - Codex limits are read locally from the `rate_limits` snapshots that rollout session logs already contain.
  - Claude Code limits are fetched from the Anthropic usage endpoint (the same source as the CLI's `/usage` command) using the OAuth token Claude Code stores in `.credentials.json`; the token is only read, never refreshed or written. Unavailable when credentials live in the macOS Keychain.
  - `otakUsage.showRateLimits` (default `true`) toggles the feature; disabling it also stops the network request.
  - `otakUsage.statusBarMode` (default `cost`) chooses what the status-bar item shows: `cost`, `limits` (each provider's most constrained percentage instead of cost, e.g. `✦8% ⬡100%`, falling back to cost until a snapshot is available), or `costAndLimits` (e.g. `$18.01  ✦8% ⬡100%`).
  - A window whose reset time has already passed is shown as 0% used instead of a stale percentage.
  - The copied summary includes a per-provider `limits:` block, one line per window.

## [1.3.6] - 2026-07-10

### Changed
- Model breakdowns now use a stable newest-model-first order instead of changing with month-to-date cost; unknown models appear last in name order. (#6)

## [1.3.5] - 2026-07-10

### Added
- GPT-5.6 Sol, Terra, Luna, and `gpt-5.6` alias pricing, including per-turn long-context rates above 272K input tokens. (#5)

### Fixed
- Replayed Codex token-count history that appears before the first model-bearing `turn_context` is no longer ingested as unknown usage. (#5)

## [1.3.4] - 2026-07-02

### Added
- Claude Sonnet 5 pricing support, including the introductory price through 2026-08-31 and the standard price from 2026-09-01. (#4)

## [1.3.2] - 2026-06-24

### Added
- Choose which contents to export as telemetry via individual checkboxes: `otakUsage.telemetry.includeTokenUsage`, `includeCost`, and `includeRtkTokens`. All on by default.
- New `otak_usage.cost.usd` metric (Sum, cumulative, USD) — month-to-date API-equivalent cost per model, labelled `gen_ai.system` / `gen_ai.response.model`. Unknown-priced models are skipped.

## [1.3.1] - 2026-06-24

### Added
- `otakUsage.telemetry.serviceInstanceId` — a free-form source identifier (any string) you set yourself, exported as the OpenTelemetry `service.instance.id` resource attribute so you can tell apart where the telemetry came from. Empty = not sent.

## [1.3.0] - 2026-06-24

### Added
- Optional OpenTelemetry usage telemetry. Enable `otakUsage.telemetry.enabled` to export aggregate metrics to an OTLP/HTTP endpoint (local Collector, Grafana Cloud, Honeycomb, …) as OTLP/JSON — no SDK dependency added. Labels follow the OpenTelemetry GenAI semantic conventions (`gen_ai.client.token.usage` with `gen_ai.system` / `gen_ai.response.model` / `gen_ai.token.type`, plus `otak_usage.rtk.tokens`). Configurable endpoint, custom headers (for auth), and `service.name`. Off by default; only aggregate token counts are sent, never prompt content.
- A **Settings** link in the tooltip that opens the otak-usage telemetry settings.

## [1.2.4] - 2026-06-19

### Added
- The tooltip now shows the combined OpenAI + Claude total for today and this month.
- Runtime tooltip labels are localized across the supported locales, including totals, period labels, table headers, empty/unavailable states, copy-summary text, and RTK table labels.

## [1.2.3] - 2026-06-19

### Added
- Daily combined Claude + Codex cost alert (`otakUsage.dailyAlertThresholdUsd`, default `$10.00`). When today's API-equivalent total reaches the threshold, VS Code shows a notification with an action to open the setting; `0` disables the alert.
- Localization for extension settings, commands, and runtime alert/status messages in G20 major locales: English, Arabic, German, Spanish, French, Hindi, Indonesian, Italian, Japanese, Korean, Brazilian Portuguese, Russian, Turkish, Simplified Chinese, Traditional Chinese, plus Vietnamese.

### Fixed
- The status bar now shows only the selected-period Claude + Codex total. RTK token savings stay in the tooltip and copied summary.

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
