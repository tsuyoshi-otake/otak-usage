# Privacy Notice

Otak Usage processes Claude Code, OpenAI Codex CLI, and optional RTK usage data on the machine where the VS Code extension host runs. The project does not operate a hosted telemetry or analytics service.

## Data accessed locally

- Claude Code and Codex CLI session logs are read to extract model identifiers, timestamps, token counts, cache usage, and Codex rate-limit snapshots. Prompt and response content is not collected, cached, displayed, or exported.
- When subscription rate-limit display is enabled, the extension reads the Claude Code OAuth access token and expiry metadata from Claude Code's local credentials file. The token is used only as a bearer token for the Anthropic usage request. It is not modified, refreshed, copied into extension storage, logged, or included in telemetry.
- Optional RTK integration runs the configured local `rtk` executable with `gain --daily --format json` and reads aggregate token-saving statistics from its output.
- Context optimization and optional hook features update only the Claude Code and Codex configuration files described in the extension settings and README.

## Data stored locally

The extension stores aggregate usage totals, scan offsets, rate-limit snapshots, alert state, and multi-window coordination data in VS Code extension storage. This data does not contain prompt or response content. VS Code and the operating system control the lifetime and protection of that local storage.

## Network requests

- **Anthropic usage API:** When `otakUsage.showRateLimits` is enabled (the default), the extension sends the locally stored Claude Code OAuth token only to `https://api.anthropic.com/api/oauth/usage` to retrieve subscription utilization. Disable that setting to prevent this request.
- **OpenTelemetry export:** `otakUsage.telemetry.enabled` is disabled by default. When explicitly enabled, the extension sends the selected aggregate token, cost, and RTK metrics to the OTLP/HTTP endpoint configured by the user. It sends no prompt or response content. Any configured telemetry headers are sent only to that endpoint.
- No other network requests are made by the extension.

## Workspace Trust

Otak Usage is disabled in VS Code Restricted Mode. Trusting a workspace allows the extension to read the configured local CLI directories, update optional CLI configuration, and run the configured RTK executable. Review workspace-scoped `otakUsage` settings before granting trust to an unfamiliar workspace.

## Questions and reports

Privacy or security concerns can be reported through the project's [GitHub issue tracker](https://github.com/tsuyoshi-otake/otak-usage/issues).
