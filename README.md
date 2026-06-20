<p align="center">
  <h1 align="center">otak-usage</h1>
  <p align="center">See what your AI pair programmers would cost - Claude Code and OpenAI Codex CLI usage as API-equivalent dollars, right in the VS Code status bar.</p>
</p>

---

## Usage

1. Install the extension - a cost readout appears on the right side of the status bar:

   `$18.01` (Claude Code + Codex CLI total)

2. Hover for a per-model breakdown of today and the current month
3. Click to toggle the displayed period between **Today** and **This Month**

> **Disclaimer**: The amounts shown are *API-equivalent estimates* computed from your local session logs and public per-token API prices. If you use a subscription plan (Claude Pro/Max, ChatGPT Plus/Pro), this is **not** what you actually pay - it is what the same usage would have cost via the API.

## Features

otak-usage is a lightweight VS Code extension that reads the local session logs of AI coding CLIs and turns token counts into dollars. No accounts, no API keys, no network calls.

### Key Features

- **Two providers, one glance**:
  - Claude Code (`~/.claude/projects/**/*.jsonl`)
  - OpenAI Codex CLI (`~/.codex/sessions/**/rollout-*.jsonl`)
  - The status bar shows the combined API-equivalent cost for the selected period; either one alone works fine

- **RTK token savings** (optional):
  - If the [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) CLI is installed, the tooltip adds a Token Savings table - Input / Output / Saved / Rate for Today, This Month, and All Time (data comes from `rtk gain --daily --format json`)
  - The section appears only when `rtk` is found - without it, nothing changes

- **Daily cost alert**:
  - Shows a VS Code notification when today's combined Claude + Codex API-equivalent cost reaches the configured daily threshold
  - Default threshold is `$10.00`; set `otakUsage.dailyAlertThresholdUsd` to `0` to disable alerts
  - Runtime notifications and extension settings are localized for G20 major locales: English, Arabic, German, Spanish, French, Hindi, Indonesian, Italian, Japanese, Korean, Brazilian Portuguese, Russian, Turkish, Simplified Chinese, Traditional Chinese, plus Vietnamese

- **Accurate cost model**:
  - Per-model pricing tables (Claude Fable 5 / Opus / Sonnet / Haiku, GPT-5.x / Codex families)
  - Claude cache writes (5m and 1h) and cache reads priced at their real multipliers
  - Claude fast mode (`/fast`) responses detected and billed at the fast-mode premium
  - Codex cached input priced at the cached-input rate
  - Duplicate transcript records deduplicated, session-cumulative counters handled correctly
  - Unknown models count as $0 (shown as `n/a` per model) - add prices via `otakUsage.pricingOverrides`

- **Fast and incremental**:
  - Only files modified in the current month are considered; only new bytes are streamed from each file
  - JSONL scanning avoids retaining whole unread files or line lists in memory
  - Scan state persists across VS Code restarts, so refreshes reuse cached offsets after the initial scan
  - Steady-state refresh takes milliseconds even with gigabytes of logs
  - Polling slows down automatically when the window is unfocused

- **Remote-ready**:
  - Runs in the workspace extension host, so it reads the logs of the machine where your CLIs actually run - including GitHub Codespaces, Dev Containers, and Remote-SSH
  - Windows, macOS, and Linux

## Commands

| Command | Description |
|---------|-------------|
| `Otak Usage: Toggle Period (Today / This Month)` | Switch the status bar between today's and this month's cost (also bound to clicking the status bar item) |
| `Otak Usage: Refresh Usage (Clear Cache and Rescan)` | Drop the incremental scan cache and rebuild from the logs |
| `Otak Usage: Copy Usage Summary` | Copy a plain-text per-model breakdown to the clipboard (also available as the "Copy Summary" link in the tooltip) |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `otakUsage.period` | `today` | Aggregation period shown in the status bar (`today` / `month`) |
| `otakUsage.updateIntervalSeconds` | `60` | How often to rescan the logs (minimum 10) |
| `otakUsage.dailyAlertThresholdUsd` | `10` | Daily combined Claude + Codex cost threshold in USD. A notification appears when today's total reaches this amount; set to `0` to disable |
| `otakUsage.showClaude` | `true` | Include Claude Code usage in the status bar total, tooltip, and copied summary |
| `otakUsage.showCodex` | `true` | Include Codex CLI usage in the status bar total, tooltip, and copied summary |
| `otakUsage.showRtk` | `true` | Show the RTK token-savings tooltip table (auto-hidden when the `rtk` CLI is not installed) |
| `otakUsage.rtkPath` | `""` | Path to the rtk executable (empty = `rtk` on PATH) |
| `otakUsage.pricingOverrides` | `{}` | Per-model price overrides in USD per million tokens, e.g. `{"gpt-6": {"input": 5, "cachedInput": 0.5, "output": 30}}` |
| `otakUsage.claudeConfigDir` | `""` | Claude Code config dir (empty = `$CLAUDE_CONFIG_DIR` or `~/.claude`) |
| `otakUsage.codexHome` | `""` | Codex home dir (empty = `$CODEX_HOME` or `~/.codex`) |

## How costs are computed

- **Claude Code**: each assistant message records `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and a 5m/1h cache-write breakdown. Cost = input × base + cache reads × 0.1 × base + 5m writes × 1.25 × base + 1h writes × 2 × base + output × output price. Fast-mode responses (`usage.speed: "fast"`) are tracked as `<model>-fast` and billed at the fast-mode premium, with the cache multipliers stacking on the fast price.
- **Codex CLI**: each turn records `last_token_usage`. Cost = (input − cached) × base + cached × cached-input price + output × output price. Reasoning tokens are already included in output tokens.
- Prices were verified against the official Anthropic and OpenAI pricing pages. Dated model ids (`claude-opus-4-8-20250915`) and variants (`gpt-5.3-codex-spark`) resolve to their base model by longest-prefix match.

## Privacy

Everything stays on your machine. The extension reads token-count metadata from local log files; it never reads your prompts' content, never writes to the log directories, and never touches the network or credential files. The optional RTK integration runs the local `rtk gain` command and reads only its aggregate numbers.

## Requirements

- VS Code 1.90.0 or higher
- At least one of [Claude Code](https://claude.com/claude-code) or [OpenAI Codex CLI](https://developers.openai.com/codex) with existing local session logs

## Related Extensions

Check out the other [otak-series extensions](https://marketplace.visualstudio.com/search?term=odangoo&target=VSCode):

- [otak-monitor](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor) - System monitoring in the status bar
- [otak-clock](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock) - Dual time-zone clocks
- [otak-committer](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer) - AI-powered commit messages

## License

MIT License - see the [LICENSE](LICENSE) file for details.

---

For more information, visit the [GitHub repository](https://github.com/tsuyoshi-otake/otak-usage).
