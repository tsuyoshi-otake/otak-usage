<div align="center">

# otak-usage

**See what your AI pair programmers would cost, right in the VS Code status bar.**  
otak-usage reads local Claude Code and OpenAI Codex CLI session logs, converts token counts into API-equivalent USD, and can add RTK savings plus optional OpenTelemetry export.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/odangoo.otak-usage?label=Marketplace&color=1d4ed8)](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage)
[![VS Code engine](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007acc)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-otak--usage-24292f)](https://github.com/tsuyoshi-otake/otak-usage)

![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-7c3aed)
![Codex CLI](https://img.shields.io/badge/Codex%20CLI-supported-0f766e)
![RTK savings](https://img.shields.io/badge/RTK%20savings-optional-2563eb)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-opt--in-334155)
![Local by default](https://img.shields.io/badge/data-local%20by%20default-64748b)

[**Install**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage) ·
[**GitHub**](https://github.com/tsuyoshi-otake/otak-usage) ·
[**Report an issue**](https://github.com/tsuyoshi-otake/otak-usage/issues)

</div>

---

AI coding tools leave useful token-count metadata in local session logs, but comparing day-to-day usage across providers usually means opening separate files or tools. **otak-usage turns those logs into one status-bar readout**: today or month-to-date, combined or per provider/model, with configurable alerts and optional metric export when you want dashboards.

## Quick Start

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage).
2. Use Claude Code or OpenAI Codex CLI normally on the machine where VS Code is running.
3. Check the right side of the VS Code status bar:

```text
$18.01
```

Hover the status-bar item for a per-model breakdown of today and the current month. Click it to toggle between **Today** and **This Month**.

> **Disclaimer**: The amounts shown are API-equivalent estimates computed from local session logs and per-token API prices. If you use a subscription plan such as Claude Pro/Max or ChatGPT Plus/Pro, this is not what you actually pay; it is what the same usage would have cost through the API.

## Capabilities

- **Two providers, one glance**: Claude Code (`~/.claude/projects/**/*.jsonl`) and OpenAI Codex CLI (`~/.codex/sessions/**/rollout-*.jsonl`) roll up into one status-bar total. Either provider can be used on its own.
- **Per-model cost breakdowns**: the tooltip and copied summary show token usage and API-equivalent USD by provider, model, and period.
- **RTK token savings**: when [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is available, the tooltip adds Input / Output / Saved / Rate for Today, This Month, and All Time.
- **Daily cost alert**: a VS Code notification appears when today's combined Claude + Codex estimate reaches your configured threshold.
- **OpenTelemetry telemetry**: opt in to export aggregate token and cost metrics to any OTLP/HTTP endpoint, including a local OpenTelemetry Collector, Grafana Cloud, Honeycomb, or Datadog.
- **Fast incremental scanning**: current-month files are streamed, only newly appended bytes are scanned after the first pass, and scan state survives VS Code restarts.
- **Remote-ready**: the extension runs in the workspace extension host, so it reads logs where your CLIs run, including GitHub Codespaces, Dev Containers, and Remote-SSH hosts.
- **Localized interface**: commands, settings, notifications, and status messages follow your VS Code display language.

## How It Works

On each refresh, otak-usage:

1. Resolves the Claude Code config directory and Codex home directory.
2. Streams current-month JSONL logs from the available providers.
3. Deduplicates transcript records and normalizes token counters.
4. Applies built-in pricing plus any `otakUsage.pricingOverrides`.
5. Updates the status bar, tooltip, and copied summary data.
6. Optionally reads RTK aggregate savings and exports OpenTelemetry metrics.

If a provider directory is missing, that provider is skipped without blocking the other one. Unknown-priced models are counted as usage but shown as `n/a` for cost until you add an override.

## Commands

| Command | Description |
| --- | --- |
| `Otak Usage: Toggle Period (Today / This Month)` | Switch the status bar between today's and this month's cost. The status-bar item also runs this command on click. |
| `Otak Usage: Refresh Usage (Clear Cache and Rescan)` | Drop the incremental scan cache and rebuild the usage summary from local logs. |
| `Otak Usage: Copy Usage Summary` | Copy a plain-text per-model breakdown to the clipboard. The tooltip also exposes this action. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `otakUsage.period` | `today` | Aggregation period shown in the status bar: `today` or `month`. |
| `otakUsage.updateIntervalSeconds` | `60` | How often to rescan usage logs, in seconds. Minimum: `10`. |
| `otakUsage.dailyAlertThresholdUsd` | `10` | Daily combined Claude + Codex cost threshold in USD. Set to `0` to disable alerts. |
| `otakUsage.showClaude` | `true` | Include Claude Code usage in the status bar, tooltip, and copied summary. |
| `otakUsage.showCodex` | `true` | Include Codex CLI usage in the status bar, tooltip, and copied summary. |
| `otakUsage.showRtk` | `true` | Show the RTK token-savings tooltip table. It is hidden automatically when `rtk` is unavailable. |
| `otakUsage.rtkPath` | `""` | Path to the `rtk` executable. Empty means `rtk` on `PATH`. |
| `otakUsage.pricingOverrides` | `{}` | Per-model price overrides in USD per million tokens, for example `{"gpt-6": {"input": 5, "cachedInput": 0.5, "output": 30}}`. |
| `otakUsage.claudeConfigDir` | `""` | Claude Code config directory. Empty means `$CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `otakUsage.codexHome` | `""` | Codex home directory. Empty means `$CODEX_HOME` or `~/.codex`. |
| `otakUsage.telemetry.enabled` | `false` | Send usage telemetry to an OpenTelemetry OTLP/HTTP endpoint. Off by default. |
| `otakUsage.telemetry.includeTokenUsage` | `true` | Include per-model token usage (`gen_ai.client.token.usage`) in telemetry. |
| `otakUsage.telemetry.includeCost` | `true` | Include per-model USD cost (`otak_usage.cost.usd`) in telemetry. |
| `otakUsage.telemetry.includeRtkTokens` | `true` | Include RTK token savings (`otak_usage.rtk.tokens`) in telemetry. |
| `otakUsage.telemetry.endpoint` | `http://localhost:4318` | OTLP/HTTP base endpoint. The `/v1/metrics` path is appended automatically. |
| `otakUsage.telemetry.headers` | `{}` | Extra HTTP headers per request, for example `{"Authorization": "Bearer <token>"}` for Grafana Cloud or Honeycomb. |
| `otakUsage.telemetry.serviceName` | `otak-usage` | OpenTelemetry `service.name` resource attribute for exported metrics. |
| `otakUsage.telemetry.serviceInstanceId` | `""` | Optional source identifier exported as `service.instance.id`, useful when multiple machines send metrics. |

## Cost Model

- **Claude Code**: each assistant message records input, output, cache-read, and cache-write token counts. Cost is calculated from input, output, cache reads, 5-minute cache writes, and 1-hour cache writes. Fast-mode responses are tracked as `<model>-fast` and priced separately when a matching table entry exists.
- **Codex CLI**: each turn records `last_token_usage`. Cost is calculated from uncached input, cached input, and output tokens. Reasoning tokens are already included in output tokens.
- **Pricing lookup**: built-in tables cover Claude Fable/Mythos/Opus/Sonnet/Haiku families plus GPT-5.x, Codex, o-series, and GPT-4.x models. Exact match is tried first, then longest-prefix match, so dated model IDs resolve to their base entry.
- **Overrides**: use `otakUsage.pricingOverrides` when a model is missing or a price changes. Unknown models count as $0 and appear as `n/a` per model until configured.

The built-in table records the date it was last checked against official pricing pages. Because provider pricing can change, treat the output as an estimate and configure overrides when exact reporting matters.

## Telemetry

Telemetry is off by default. When `otakUsage.telemetry.enabled` is `true`, every refresh exports aggregate metrics as OTLP/JSON to the configured OTLP/HTTP endpoint. No OpenTelemetry SDK dependency is added; the extension posts plain OTLP/JSON.

Labels follow the OpenTelemetry [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

| Metric | Type | Attributes |
| --- | --- | --- |
| `gen_ai.client.token.usage` | Sum, cumulative monotonic, `{token}` | `gen_ai.system` (`anthropic` / `openai`), `gen_ai.response.model`, `gen_ai.token.type` (`input` / `output` / `cache_read` / `cache_creation`) |
| `otak_usage.cost.usd` | Sum, cumulative monotonic, `USD` | `gen_ai.system`, `gen_ai.response.model`; unknown-priced models are skipped |
| `otak_usage.rtk.tokens` | Sum, cumulative monotonic, `{token}` | `otak_usage.rtk.type` (`saved` / `input` / `output`), only when the `rtk` CLI is available |

Token counts and cost are month-to-date and reset at the start of each month. RTK counts are all-time. Resource attributes include `service.name`, `service.version`, and, when configured, `service.instance.id`.

## Security & Privacy

otak-usage is local by default:

- **Local log reading**: it reads token-count metadata from local Claude Code and Codex CLI logs.
- **No prompt collection**: it does not collect, store, or export prompt content.
- **No credential access**: it does not write to provider log directories or touch credential files.
- **No network by default**: network access is used only when you explicitly enable OpenTelemetry export.
- **User-controlled endpoints**: telemetry goes only to the OTLP/HTTP endpoint and headers you configure.
- **Local RTK integration**: optional RTK support runs the local `rtk gain` command and reads only aggregate savings numbers.
- **Open source, MIT-licensed**: the full implementation is auditable on [GitHub](https://github.com/tsuyoshi-otake/otak-usage).

## Language Support

The interface follows your VS Code display language:

**English** · 日本語 · 简体中文 · 繁體中文 · 한국어 · Tiếng Việt · Español · Português (BR) · Français · Deutsch · हिन्दी · Bahasa Indonesia · Italiano · Русский · العربية · Türkçe

## Requirements

- VS Code **1.90.0** or newer
- At least one of:
  - [Claude Code](https://claude.com/claude-code) with local session logs
  - [OpenAI Codex CLI](https://developers.openai.com/codex) with local session logs
- Optional: [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) for token-savings summaries

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage), or run:

```text
ext install odangoo.otak-usage
```

<details>
<summary><strong>Build from source (VSIX)</strong></summary>

```bash
npm install
npm run package
code --install-extension otak-usage-1.3.3.vsix
```

Reload VS Code after installing the VSIX.

</details>

## Troubleshooting

- **The status bar does not show usage**: confirm Claude Code or Codex CLI has created local session logs on the same machine or remote host where the VS Code extension host is running.
- **One provider is missing**: check `otakUsage.claudeConfigDir` or `otakUsage.codexHome` if your logs are outside the default locations.
- **A model shows `n/a` cost**: add an entry to `otakUsage.pricingOverrides` for that model.
- **RTK savings are absent**: install `rtk`, put it on `PATH`, or set `otakUsage.rtkPath`.
- **Telemetry is not appearing**: confirm `otakUsage.telemetry.enabled`, the OTLP/HTTP base endpoint, custom headers, and the collector's `/v1/metrics` route.
- **The numbers differ from a subscription bill**: otak-usage estimates API-equivalent cost, not subscription spend.

## Related Extensions

More VS Code extensions by [odangoo](https://marketplace.visualstudio.com/publishers/odangoo):

| Extension | Description |
| --- | --- |
| [**otak-paste**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-paste) | Paste optimized screenshots into Markdown and keep repositories lighter |
| [**otak-proxy**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy) | One-click proxy switching for VS Code, Git, npm, and integrated terminals |
| [**otak-monitor**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor) | Real-time CPU, memory, and disk usage in the status bar |
| [**otak-committer**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer) | AI-assisted commit messages, pull requests, and issues |
| [**otak-clipboard**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clipboard) | Copy a folder or the current tab to your clipboard in two clicks |
| [**otak-clock**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock) | Dual time-zone clock for the status bar |
| [**otak-pomodoro**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro) | A Pomodoro focus timer built into VS Code |
| [**otak-restart**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart) | Quick Extension Host and window restart from the status bar |
| [**otak-zen**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen) | A calm, distraction-free Zen mode for VS Code |
| [**otak-lsp**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-lsp) | Japanese morphological analysis with grammar checks, semantic highlights, and hovers |

## License

Released under the [MIT License](LICENSE).

<div align="center">
<br>
<sub>Built by <a href="https://github.com/tsuyoshi-otake">tsuyoshi-otake</a> · <a href="https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage">Marketplace</a> · <a href="https://github.com/tsuyoshi-otake/otak-usage">GitHub</a> · <a href="https://github.com/tsuyoshi-otake/otak-usage/issues">Issues</a></sub>
</div>
