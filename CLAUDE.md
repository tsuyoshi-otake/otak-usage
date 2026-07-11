# otak-usage — project notes

VS Code extension. Reads local Claude Code / Codex CLI session logs and shows
API-equivalent cost, subscription rate limits, and RTK savings in the status bar.

## Release / publishing (dual registry)
- Releases publish to **both** the VS Marketplace and the **Open VSX Registry**
  via `.github/workflows/publish-vscode.yml`, triggered by pushing a `v*` tag
  (or `gh workflow run publish-vscode.yml --ref main` for a manual dispatch).
- Pipeline: `npm ci` → lint → tests (`xvfb-run vscode-test`) → package VSIX →
  check both tokens up front → `vsce publish` → `ovsx publish`. Both use
  `--skip-duplicate`, so re-runs and dispatches are safe.
- **Release steps**: bump `version` in `package.json`, add a CHANGELOG entry,
  commit, then `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`.
- Repo secrets already configured: `VSCE_PAT` (VS Marketplace), `OVSX_PAT`
  (Open VSX). Do not enter/handle these token values yourself — the user adds
  them in the GitHub UI.
- Publisher/namespace is `odangoo` on both registries. Open VSX namespace
  `odangoo` is owned by tsuyoshi-otake and the Publisher Agreement is signed.
  `ovsx` (dev dep, Eclipse CLI) reads the token from the `OVSX_PAT` env var.
- Open VSX indexing is **eventually consistent**: right after a publish the
  `/versions` list and "latest" pointer lag a few minutes. Trust the ovsx CLI
  `🚀 Published` line; verify a specific version at
  `https://open-vsx.org/api/odangoo/otak-usage/<version>`.
- `package-lock.json` root `version` is stale (1.3.6) and intentionally not kept
  in sync with `package.json`; `npm ci` still works. Don't churn it.

## CI — Security Scan
- `.github/workflows/security.yml` = `npm audit --omit=dev --audit-level=high` +
  CodeQL. The extension ships **zero runtime dependencies** (everything is a
  devDependency), so only the production tree is auditable. Dev-tooling
  advisories (mocha / vsce / ovsx transitive) don't reach users — audit prod
  only, never fail the gate on them.

## Status-bar vs tooltip brand icons (two separate mechanisms)
- **Status bar**: 2-glyph icon font `images/otak-usage-icons.woff`
  (`contributes.icons`: `otak-openai` U+E900, `otak-claude` U+E901), built by
  `tools/build-icon-font.py`. `GLYPH` = em fill (currently 850, tuned to match
  the native Restart/sync codicon). To resize, rescale the existing woff glyphs
  with fontTools rather than re-fetching SVGs (simple-icons dropped `openai`);
  needs a fontTools venv. Used via `$(otak-claude)` / `$(otak-openai)` codicons.
- **Tooltip**: brand marks are **decoupled** from that font. `src/brandIcons.ts`
  holds 24×24 SVG paths + `brandIconImg()`, which emits theme-colored inline
  `<img>` data URIs sized independently (`TOOLTIP_ICON_SIZE` in `formatter.ts`).
  The theme color is threaded from `extension.ts` (`tooltipIconColor()`,
  editor-fg per active theme kind) and re-rendered on
  `onDidChangeActiveColorTheme` — data-URI images can't inherit `currentColor`
  like codicons do. Regenerate the paths with `tools/gen_brandicons.py`.
- The tooltip `MarkdownString` sets `supportHtml`, `supportThemeIcons`, and
  `isTrusted`, so `<img>` + `data:` image URIs render.

## Build / test
- `npm run compile` (tsc), `npm run lint` (eslint src), `npm test` (vscode-test).
  Tests run fine locally on Windows.
