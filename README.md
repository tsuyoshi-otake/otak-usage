<div align="center">

# otak-usage

**See what your AI pair programmers would cost, right in the VS Code status bar.**  
otak-usage reads local Claude Code and OpenAI Codex CLI session logs, converts token counts into API-equivalent USD, shows how much of your subscription rate limits is used, and can add RTK savings plus optional OpenTelemetry export.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/odangoo.otak-usage?label=Marketplace&color=1d4ed8)](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage)
[![VS Code engine](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007acc)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-otak--usage-24292f)](https://github.com/tsuyoshi-otake/otak-usage)

![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-7c3aed)
![Codex CLI](https://img.shields.io/badge/Codex%20CLI-supported-0f766e)
![RTK savings](https://img.shields.io/badge/RTK%20savings-optional-2563eb)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-opt--in-334155)
![Local-first](https://img.shields.io/badge/data-local--first-64748b)
![Context optimization](https://img.shields.io/badge/context%20optimization-default%20on-f97316)

[**Install**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage) ·
[**GitHub**](https://github.com/tsuyoshi-otake/otak-usage) ·
[**Report an issue**](https://github.com/tsuyoshi-otake/otak-usage/issues)

</div>

---

> [!IMPORTANT]
> **Context optimization is enabled by default for both Claude Code and Codex CLI.** Both providers default to a 200k window: Claude Code to a 200k effective auto-compaction window with a 92% trigger (about 184k tokens), Codex to a 200k context window with auto-compaction at 184k. Use **Optimize** in the status-bar tooltip to choose a provider, select a preset, enter fully custom values, or turn that provider off. Turning Claude optimization off restores the values that existed before otak-usage took ownership.

AI coding tools leave useful token-count metadata in local session logs, but comparing day-to-day usage across providers usually means opening separate files or tools. **otak-usage turns those logs into one status-bar readout**: today or month-to-date, combined or per provider/model, with configurable alerts and optional metric export when you want dashboards.

## Quick Start

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage).
2. Use Claude Code or OpenAI Codex CLI normally on the machine where VS Code is running. Context optimization for both providers is already **on by default**.
3. Check the right side of the VS Code status bar:

```text
$18.01
```

Hover the status-bar item for a per-model breakdown of today and the current month. Click it to cycle between **Today**, **This Month**, and **Limits** (subscription rate-limit usage).

The hover tooltip puts Claude Code and Codex CLI side by side — each with its brand logo, rate-limit windows, per-model cost, and a provider total — followed by RTK token savings:

```text
otak-usage — API-equivalent cost

OpenAI + Claude Total: $9.80 / $297.45

Claude Code — Limits (max)        │ Codex CLI — Limits (pro)
5h · 28% used · resets 16:39      │ 5h · 5% used · resets 18:59
7d · 13% used · resets 07-15      │ 7d · 21% used · resets 07-18
claude-opus-5:    $6.20 / $142.30 │ gpt-5.5:      $2.14 / $88.60
claude-sonnet-5:  $1.05 / $58.40  │ gpt-5.4-mini: $0.41 / $6.05
claude-haiku-4-5: $0.00 / $2.10   │
Total:            $7.25 / $202.80 │ Total:        $2.55 / $94.65

RTK — Token Savings
Period       Input    Output   Saved    Rate
Today        7.1M     2.9M     4.2M     59.5%
This Month   12.4M    5.1M     7.3M     58.9%
All Time     3.0B     110.1M   2.9B     96.4%

Period: This Month · Updated 16:09 · Click to switch view
```

> Amounts above are illustrative. The status bar shows the combined total; the two provider columns, the limit windows, and the RTK table each appear only when that data is available and enabled.

> **Disclaimer**: The amounts shown are API-equivalent estimates computed from local session logs and per-token API prices. If you use a subscription plan such as Claude Pro/Max or ChatGPT Plus/Pro, this is not what you actually pay; it is what the same usage would have cost through the API.

## Capabilities

- **Two providers, one glance**: Claude Code (`~/.claude/projects/**/*.jsonl`) and OpenAI Codex CLI (`~/.codex/sessions/**/rollout-*.jsonl`) roll up into one status-bar total. Either provider can be used on its own.
- **Per-model cost breakdowns**: the tooltip and copied summary show token usage and API-equivalent USD by provider, model, and period. In the tooltip, Claude Code and Codex sit side by side (with their brand logos) and RTK savings follow below.
- **Subscription rate limits**: the tooltip shows how much of each provider's 5-hour and weekly rate-limit windows is used, with reset times and plan type — Codex from local session logs, Claude Code from the same Anthropic endpoint the CLI's `/usage` command uses. The status bar uses each provider's longer window for an apples-to-apples view, falling back to the shorter window when necessary.
- **Stable model ordering**: per-provider breakdowns list known models newest-first; unrecognized models appear last in name order.
- **RTK token savings**: when [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is available, the tooltip adds Input / Output / Saved / Rate for Today, This Month, and All Time.
- **Usage alerts**: a VS Code notification appears when today's combined Claude + Codex estimate reaches your configured USD threshold, and/or when a subscription rate-limit window (5-hour or weekly) reaches your configured percentage. `otakUsage.alertMode` chooses which triggers fire (`cost`, `limit`, `both`, or `off`).
- **Fast-mode warning**: when Claude Code or Codex CLI fast mode turns on, the same warning notification the cost and limit alerts use points out that usage is billed at premium fast-mode rates. See [Fast-mode detection](#fast-mode-detection).
- **Claude + Codex context optimization — on by default**: Claude Code gets a 200k effective auto-compaction window with a 92% trigger (about 184k); Codex gets a matching 200k context window with auto-compaction at 184k. Click **Optimize** in the tooltip, choose a provider, then select a preset, enter **Custom** values, or **Turn Off** that provider. The active values for both providers are shown directly in the tooltip.
- **OpenTelemetry telemetry**: opt in to export aggregate token and cost metrics to any OTLP/HTTP endpoint, including a local OpenTelemetry Collector, Grafana Cloud, Honeycomb, or Datadog.
- **Fast incremental scanning**: current-month files are streamed, only newly appended bytes are scanned after the first pass, and scan state survives VS Code restarts.
- **Remote-ready**: the extension runs in the workspace extension host, so it reads logs where your CLIs run, including GitHub Codespaces, Dev Containers, and Remote-SSH hosts — and it says so when it ends up on the local side instead. See [Codespaces, Dev Containers and other remotes](#codespaces-dev-containers-and-other-remotes).
- **Localized interface**: commands, settings, notifications, and status messages follow your VS Code display language.

## How It Works

On each refresh, otak-usage:

1. Resolves the Claude Code config directory and Codex home directory.
2. Streams current-month JSONL logs from the available providers.
3. Deduplicates transcript records and normalizes token counters.
4. Applies built-in pricing plus any `otakUsage.pricingOverrides`.
5. Reads the latest Codex rate-limit snapshot from the session logs and, when `otakUsage.showRateLimits` is enabled, fetches Claude Code limits from the Anthropic usage endpoint.
6. Updates the status bar, tooltip, and copied summary data.
7. Optionally reads RTK aggregate savings and exports OpenTelemetry metrics.

If a provider directory is missing, that provider is skipped without blocking the other one. Unknown-priced models are counted as usage but shown as `n/a` for cost until you add an override.

### Incremental scanning

A refresh never re-reads a transcript it has already accounted for. Every file is
tracked by size, mtime, and a byte offset, so a tick reads only the bytes appended
since the last one, and an incomplete trailing line is left for the next pass.

Discovery is just as incremental. Directory listings are cached and only re-read
when the directory's own mtime moves — which happens when a session file is
created, renamed, or deleted, but not when an existing one is appended to. Entries
are then re-checked on a backoff proportional to how long they have been idle, so
the session you are working in is looked at every tick while a transcript last
touched a week ago is not. Directories are never left unchecked for more than a
minute, so a brand-new session still shows up on the next refresh, and a full
re-listing runs every 30 minutes as a backstop against a filesystem whose
directory mtimes cannot be trusted.

On a real 1,809-file history this makes a steady-state tick about **5x cheaper**
than a full walk (mean 449 vs ~2,228 filesystem calls, 24 ms vs 131 ms), and the
persisted dedupe state is **8x smaller** (1.2 MB vs 10.4 MB), cutting the
serialization the extension does on every save.

### One scan, however many windows are open

VS Code runs an extension host per window, so ten open windows would otherwise
mean ten copies of everything above reading the same files — plus ten calls to
the Anthropic usage endpoint, ten `rtk` child processes, ten OpenTelemetry
exports of the same numbers, and ten popups for one cost alert.

Instead the windows elect one of themselves. The leader scans and publishes the
per-day, per-model token counts; every other window renders that. Costs are
still computed per window, so `otakUsage.pricingOverrides`, the visibility
toggles, the period and the status-bar view stay yours to set per window — and
nothing about the display changes, because every window shows the same numbers
it always did.

- The election runs through the extension's own global storage directory, which
  is shared by every window of one installation on **Windows, macOS, Linux, WSL,
  SSH remotes and Codespaces** alike. In a remote the extension host lives on
  the remote side, so the windows attached to it elect a leader there, next to
  the logs they are actually reading.
- Windows only share a leader when they would scan the same directories. Point
  `otakUsage.claudeConfigDir` or `otakUsage.codexHome` somewhere else in a
  workspace and that window scans for itself.
- The leader renews a 30-second lease every 10 seconds. Close it and the lease
  is handed over at once; kill it and another window picks the work up within
  the lease. **Refresh Usage** always takes over on the spot, so the window you
  are working in is the one that rescans.

## Codespaces, Dev Containers and Other Remotes

`extensionKind` is `["workspace", "ui"]` with `workspace` first, so in a
Codespace, Dev Container, WSL or SSH remote VS Code installs otak-usage on the
**remote** side — the machine the CLIs actually run on, whose `~/.claude` and
`~/.codex` are the logs worth reading. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are
respected there like anywhere else.

### When it lands on the wrong side

An installation that exists only locally falls back to the `ui` kind, and then
the status bar describes your **local** `~/.claude` while you work inside the
remote — the same numbers, silently about the wrong computer. VS Code publishes
exactly the two signals needed to catch that: `env.remoteName` is defined in
every extension host, local and remote alike, once a remote one exists, and
`Extension.extensionKind` says which side this instance runs on. So otak-usage
names the problem instead of reporting the wrong machine:

- the tooltip and the copied summary carry a line naming the host being read;
- a notification states it once per remote kind, with a button that installs the
  extension on the remote.

Dismiss the notification and it does not come back. The tooltip line stays for
as long as the situation does.

### Installing it once instead of once per codespace

An extension cannot install itself into a remote, but the manual step is
avoidable:

- **Per repository** — list it in `devcontainer.json` and every codespace
  created from that repo gets it unasked:

  ```jsonc
  {
    "customizations": {
      "vscode": {
        "extensions": ["odangoo.otak-usage"]
      }
    }
  }
  ```

  Existing codespaces pick this up after **Codespaces: Rebuild Container**.

- **Per remote kind, for the remotes that offer it** — `dev.containers.defaultExtensions`
  covers Dev Containers you build locally and `remote.SSH.defaultExtensions`
  covers SSH hosts. Neither applies to codespaces.

There is no per-account equivalent for Codespaces, and
[Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync) is
not one: it "does not synchronize your extensions to or from a remote window,
such as when you're connected to SSH, a development container (devcontainer), or
WSL". So for a repository whose `devcontainer.json` you cannot edit, installing
it stays a deliberate act — which is what the notification's button is for.

### Usage belongs to the host that produced it

otak-usage reads local log files and does not aggregate across machines, so what
a codespace shows is that codespace's usage:

- disconnect, and your local window is back to local numbers — the codespace's
  totals are not merged in;
- reconnect to the same codespace and they are there again;
- **rebuild the container or delete the codespace and they are gone**, because
  `~/.claude` and `~/.codex` live outside `/workspaces`, which is the only thing
  a rebuild preserves.

Claude Code's rate-limit percentages are the exception. They come from the same
account-level Anthropic endpoint the CLI's `/usage` command uses, so they read
the same from any host. Codex rate limits are parsed out of its session logs and
follow the host, exactly like the costs do.

### Keeping `~/.claude` across rebuilds

Session history — and the context-optimization values otak-usage writes into
`~/.claude/settings.json` and `~/.codex/config.toml` — are discarded when the
container is rebuilt. Named volumes keep both:

```jsonc
{
  "mounts": [
    "source=claude-home,target=/home/vscode/.claude,type=volume",
    "source=codex-home,target=/home/vscode/.codex,type=volume"
  ],
  // A fresh named volume is owned by root, which would leave the CLIs unable to
  // write to their own directories.
  "postCreateCommand": "sudo chown -R $(id -u):$(id -g) ~/.claude ~/.codex"
}
```

Replace `/home/vscode` with your image's remote user home. The volumes outlive
rebuilds of the container, though not deletion of the codespace itself.

### Pinning it to the local machine

To watch your local usage *while* working in a remote, force the UI kind in your
**local** user settings:

```json
"remote.extensionKind": { "odangoo.otak-usage": ["ui"] }
```

This is the arrangement the warning above describes, so it is worth choosing
deliberately rather than arriving at by accident. Note that costs then cover
only what you run locally, while Claude Code's rate-limit percentages remain
account-wide and stay accurate either way.

## Commands

| Command | Description |
| --- | --- |
| `Otak Usage: Cycle Status Bar View (Today / This Month / Limits)` | Cycle the status bar through today's cost, this month's cost, and the rate-limit view. The status-bar item runs this command on click. |
| `Otak Usage: Toggle Period (Today / This Month)` | Switch the status bar between today's and this month's cost without entering the limits view. |
| `Otak Usage: Refresh Usage (Clear Cache and Rescan)` | Drop the incremental scan cache and rebuild the usage summary from local logs. |
| `Otak Usage: Copy Usage Summary` | Copy a plain-text per-model breakdown to the clipboard. The tooltip also exposes this action. |
| `Otak Usage: Configure Context Optimization` | Choose Claude Code or Codex CLI, then select a preset, enter arbitrary custom values, or turn optimization off for that provider. The tooltip's **Optimize** action runs this command. |
| `Otak Usage: Silence Alerts for Today (Toggle)` | Silence every cost and rate-limit notification until the next local midnight, or lift the silence again. See [Alerts](#alerts). |

## Alerts

Cost and rate-limit notifications carry two actions: **Open Settings**, which
jumps to the threshold behind the alert, and **Not Today**, which silences every
otak-usage notification until the next local midnight. A weekly window that sits
above the threshold for days is the case **Not Today** exists for — you already
know, and you would rather not turn the alerts off permanently to stop hearing
about it. The next day the alert fires again, once.

The deadline is stored beside the leader lock in the extension's global storage
rather than in this window's state, because the window that raises alerts is
whichever one holds the lock at that moment, and that moves between windows.
Silencing them anywhere silences them everywhere, and the setting survives a
reload. `Otak Usage: Silence Alerts for Today` sets and clears the same deadline
from the command palette.

## Fast-Mode Detection

Both CLIs offer a fast mode that bills at **premium per-token rates**. otak-usage watches for it and warns with the same notification the cost and limit alerts use — **Open Settings** and **Not Today** buttons included, so one click silences it for the rest of the day:

- **Claude Code**: fast mode leaves no config flag to read, but every fast response is marked in the session transcripts (`usage.speed: "fast"`, tracked as `<model>-fast` and priced at the fast rates). The warning therefore fires on the first fast-billed response of a day.
- **Codex CLI**: fast mode is declared as `fast_mode = true` under `[features]` in `~/.codex/config.toml`, so the warning fires as soon as the flag appears — before any tokens are spent.

The warning fires once per off → on transition (for Claude, at most once per day of fast usage), is raised only by the leader window like every other alert, and stays quiet while `otakUsage.alertMode` is `off` or alerts are silenced with **Not Today**.

**One-time context-optimization migration**: the first time fast mode is detected while that provider's [context optimization](#context-optimization--default-on) is turned off, otak-usage re-enables it once. At premium fast-mode prices a compact, auto-compacted context is where the savings are largest, so the trade-off that justified opting out at standard rates usually no longer holds. The migration runs exactly once per provider — turn the optimization off again afterwards and that choice is final. Cost tracking itself is unaffected: fast usage is priced with its own `-fast` table entries either way.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `otakUsage.period` | `today` | Aggregation period shown in the status bar: `today` or `month`. |
| `otakUsage.updateIntervalSeconds` | `60` | How often to rescan usage logs, in seconds. Minimum: `10`. |
| `otakUsage.alertMode` | `both` | What triggers desktop notifications: `off`, `cost` (the daily USD total), `limit` (a rate-limit window percentage), or `both`. |
| `otakUsage.dailyAlertThresholdUsd` | `10` | Daily combined Claude + Codex cost threshold in USD. Set to `0` to disable the cost alert. |
| `otakUsage.limitAlertThresholdPercent` | `80` | Subscription rate-limit alert threshold, as a percentage (0–100). Fires when any shown Claude or Codex 5-hour or weekly window reaches this utilization. Set to `0` to disable the limit alert. |
| `otakUsage.showClaude` | `true` | Include Claude Code usage in the status bar, tooltip, and copied summary. |
| `otakUsage.showCodex` | `true` | Include Codex CLI usage in the status bar, tooltip, and copied summary. |
| `otakUsage.showRateLimits` | `true` | Show subscription rate-limit usage (5-hour and weekly windows) in the tooltip. See [Subscription Rate Limits](#subscription-rate-limits). |
| `otakUsage.statusBarMode` | `cost` | What the status-bar item shows: `cost` (API-equivalent cost only), `limits` (each provider's longer available rate-limit window percentage, falling back to cost until a snapshot is available), or `costAndLimits` (both). Requires `showRateLimits` for the limit modes. On first run, if a subscription plan is detected (Claude Pro/Max or a Codex plan), otak-usage sets this to `limits` once; any choice you make afterwards is final. |
| `otakUsage.showRtk` | `true` | Show the RTK token-savings tooltip table. It is hidden automatically when `rtk` is unavailable. |
| `otakUsage.rtkPath` | `""` | Path to the `rtk` executable. Empty means `rtk` on `PATH`. |
| `otakUsage.pricingOverrides` | `{}` | Per-model price overrides in USD per million tokens, for example `{"gpt-6": {"input": 5, "cachedInput": 0.5, "output": 30}}`. |
| `otakUsage.claudeConfigDir` | `""` | Claude Code config directory. Empty means `$CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `otakUsage.codexHome` | `""` | Codex home directory. Empty means `$CODEX_HOME` or `~/.codex`. |
| `otakUsage.optimizeClaudeContext` | `true` | **On by default.** Writes the two official auto-compaction environment settings below under `env` in Claude Code `settings.json`. Turning it off through **Optimize** restores the values that existed before otak-usage took ownership. |
| `otakUsage.claudeContextWindow` | `200000` | Effective auto-compaction window written to `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The Custom flow accepts any positive integer; Claude caps it at the active model's actual context window. |
| `otakUsage.claudeAutoCompactPercent` | `92` | Trigger percentage written to `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. Custom values may be 1–100; the default produces an effective trigger near 184k tokens. |
| `otakUsage.optimizeCodexContext` | `true` | When on, write `model_context_window` and `model_auto_compact_token_limit` (from the two settings below) into your Codex `config.toml`, rewriting them in place if present; when off, remove those two keys. While off, the file is left untouched. |
| `otakUsage.codexContextWindow` | `200000` | Value written for `model_context_window` when the optimization is on. The default matches the Claude Code side. The Optimize picker can set this to the 200k or 272k preset — 272k being OpenAI's long-context pricing threshold, the largest window still billed at the standard rate — or a custom positive integer. |
| `otakUsage.codexAutoCompactLimit` | `184000` | Value written for `model_auto_compact_token_limit` when the optimization is on. The Optimize picker pairs 200k with 184k and 272k with 250k; custom values must remain below the context window. |
| `otakUsage.telemetry.enabled` | `false` | Send usage telemetry to an OpenTelemetry OTLP/HTTP endpoint. Off by default. |
| `otakUsage.telemetry.includeTokenUsage` | `true` | Include per-model token usage (`gen_ai.client.token.usage`) in telemetry. |
| `otakUsage.telemetry.includeCost` | `true` | Include per-model USD cost (`otak_usage.cost.usd`) in telemetry. |
| `otakUsage.telemetry.includeRtkTokens` | `true` | Include RTK token savings (`otak_usage.rtk.tokens`) in telemetry. |
| `otakUsage.telemetry.endpoint` | `http://localhost:4318` | OTLP/HTTP base endpoint. The `/v1/metrics` path is appended automatically. |
| `otakUsage.telemetry.headers` | `{}` | Extra HTTP headers per request, for example `{"Authorization": "Bearer <token>"}` for Grafana Cloud or Honeycomb. |
| `otakUsage.telemetry.serviceName` | `otak-usage` | OpenTelemetry `service.name` resource attribute for exported metrics. |
| `otakUsage.telemetry.serviceInstanceId` | `""` | Optional source identifier exported as `service.instance.id`, useful when multiple machines send metrics. |

## Context Optimization — Default On

Both providers are optimized immediately after installation unless you turn them off:

| Provider | Default | Config written |
| --- | --- | --- |
| Claude Code | 200k window × 92% = about 184k auto-compact trigger | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json` (or the configured `$CLAUDE_CONFIG_DIR`) |
| Codex CLI | 200k context, compact at 184k | `model_context_window` and `model_auto_compact_token_limit` in `~/.codex/config.toml` (or the configured `$CODEX_HOME`) |

Codex previously defaulted to 272k / 250k. Upgrading moves an installation to the aligned 200k default once: if your Codex values still read as that old default, they are cleared so the new default applies; anything you chose yourself is kept exactly as it was. Pick the **272k** preset again from the Optimize picker if you want the larger window back.

Open the status-bar tooltip and click **Optimize**. The command palette first asks for **Claude Code** or **Codex CLI**, then offers:

- a provider-specific preset;
- **Custom…**, where every value is validated before it is saved;
- **Turn Off**, which disables only the selected provider.

Claude's Custom flow accepts any positive effective-window token count and an auto-compaction percentage from 1 to 100. For example, 150000 and 80% compact near 120000 tokens. Codex's Custom flow accepts any positive context window and a smaller positive auto-compact token limit.

Claude Code officially supports environment variables under the `env` object in `settings.json`. With the defaults, otak-usage manages this semantic configuration:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "92"
  }
}
```

Unrelated Claude settings and environment variables are preserved. On first enable, otak-usage records whether these two values already existed; **Turn Off** restores those exact earlier values, or removes only the values it added. Invalid JSON or a non-object `env` value causes a visible error and no file write. See the official [Claude Code settings](https://code.claude.com/docs/en/settings) and [environment variable reference](https://code.claude.com/docs/en/env-vars).

Claude's effective auto-compaction window is capped at the active model's real context window. Claude Code's status-line `used_percentage` still uses the model's full context window, so a 1M model configured to compact near 184k can compact while that indicator is near 18%. A shell variable, managed setting, or higher-priority project/local setting may override the user-level values; use Claude Code's `/status` and `/context` commands to inspect the effective configuration. `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, or `autoCompactEnabled: false` also prevents automatic compaction and is never silently removed by otak-usage.

## Subscription Rate Limits

Subscription plans (Claude Pro/Max, ChatGPT Plus/Pro) meter usage in a rolling 5-hour window and a weekly window. With `otakUsage.showRateLimits` enabled (the default), each provider section in the tooltip shows how much of both windows is currently used, when they reset, and the plan type — one row per window:

```text
Limits (max)
5h · 5% used · resets 16:40
7d · 8% used · resets 07-15 14:00
```

- **Codex CLI**: read entirely locally. Rollout session logs already contain the server-reported `rate_limits` snapshot on every turn; the extension reads the tail of the most recent log. Because the snapshot dates from your last Codex activity, a window whose reset time has already passed is shown as 0% used rather than a stale value.
- **Claude Code**: local logs carry no rate-limit data, so the extension calls the Anthropic usage endpoint — the same source as the CLI's `/usage` command — authenticated with the OAuth token Claude Code stores in `.credentials.json`. The token is read-only: it is never refreshed, written, or sent anywhere except `api.anthropic.com`. If the credentials file is absent (for example on macOS, where Claude Code uses the Keychain) or the token has expired, Claude limits are simply omitted.

Set `otakUsage.statusBarMode` to surface limits in the status-bar item itself. Each provider is shown with its brand logo (Claude / OpenAI, shipped as an icon font) followed by its **5-hour window** percentage, so both providers read on the same scale; a snapshot without 5-hour data falls back to its weekly window.

**Subscription users get `limits` by default**: on first run, when a rate-limit snapshot proves a subscription plan (Claude Pro/Max via the OAuth credentials, or a Codex `plan_type`), the status bar switches to the limits view once. This never overrides you — if `statusBarMode` is already set in any settings scope, or `showRateLimits` is off, the detection marks itself done and every later change is yours.

- `cost` (default): the API-equivalent cost, e.g. `$18.01`.
- `limits`: the per-provider percentages instead of cost, e.g. `{claude} 5% {openai} 100%` (falls back to cost until a snapshot is available).
- `costAndLimits`: both, e.g. `$18.01 {claude} 5% {openai} 100%`.

**Clicking the status-bar item cycles the view**: today's cost → this month's cost → limits → back to today's cost. Leaving the limits view restores your configured mode, so a `costAndLimits` preference survives the round trip.

Disabling `otakUsage.showRateLimits` hides everything, reverts the click to the classic Today/This Month toggle, and stops the network request.

## Cost Model

- **Claude Code**: each assistant message records input, output, cache-read, and cache-write token counts. Cost is calculated from input, output, cache reads, 5-minute cache writes, and 1-hour cache writes. Fast-mode responses are tracked as `<model>-fast` and priced separately when a matching table entry exists.
- **Codex CLI**: each turn records `last_token_usage`. Cost is calculated from uncached input, cached input, and output tokens. Reasoning tokens are already included in output tokens. For GPT models with long-context pricing, the extension evaluates each turn independently and applies the published input/output multipliers when total input exceeds 272K tokens.
- **Pricing lookup**: built-in tables cover Claude Fable/Mythos/Opus/Sonnet/Haiku families plus GPT-5.x, Codex, o-series, and GPT-4.x models. Exact match is tried first, then longest-prefix match, so dated model IDs resolve to their base entry.
- **`codex-auto-review`**: Codex labels its automatic code-review turns with this slug, which is not a billable OpenAI model id and carries no published price. Rather than leave that usage unpriced, each turn is billed as whichever Codex model was current on the turn's own date, using the release table [ccusage](https://github.com/ryoppippi/ccusage) maintains. Resolution happens per turn, so a session spanning a release is split correctly. Treat these rows as an estimate: OpenAI has not published what auto-review actually bills as.
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
- **Local config optimization**: by default it updates only the documented context/auto-compaction keys in local Claude Code `settings.json` and Codex `config.toml`. Both can be turned off from **Optimize**; Claude's previous values are restored.
- **No prompt collection**: it does not collect, store, or export prompt content.
- **Read-only credential use, provider-only**: for the Claude rate-limit display it reads the OAuth token Claude Code already stores locally and sends it only to `api.anthropic.com` — never to any other endpoint, and never modified. Disable `otakUsage.showRateLimits` to prevent this entirely; no other feature touches credential files.
- **No other network use**: apart from the Anthropic rate-limit request above (on by default, one call per refresh interval), network access happens only when you explicitly enable OpenTelemetry export.
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
code --install-extension otak-usage-<version>.vsix
```

Reload VS Code after installing the VSIX.

</details>

## Troubleshooting

- **The status bar does not show usage**: confirm Claude Code or Codex CLI has created local session logs on the same machine or remote host where the VS Code extension host is running.
- **One provider is missing**: check `otakUsage.claudeConfigDir` or `otakUsage.codexHome` if your logs are outside the default locations.
- **The numbers describe the wrong machine**: in a Codespace, Dev Container or SSH remote, the tooltip names the host it is reading whenever that is not the remote you are attached to. Install the extension on the remote side — see [Codespaces, Dev Containers and other remotes](#codespaces-dev-containers-and-other-remotes).
- **Usage from a codespace disappeared**: it is read from `~/.claude` and `~/.codex` inside that container, so it is not merged into a local window and does not survive a container rebuild unless those directories are on named volumes.
- **A model shows `n/a` cost**: add an entry to `otakUsage.pricingOverrides` for that model.
- **Rate limits are not showing**: Codex limits appear after the first Codex turn on this machine (they come from session logs). Claude limits require `~/.claude/.credentials.json` with a valid OAuth token — on macOS Claude Code keeps credentials in the Keychain, so Claude limits are unavailable there. Also confirm `otakUsage.showRateLimits` is enabled and reload the window after installing an update.
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
