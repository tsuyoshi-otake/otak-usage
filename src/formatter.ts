import { ProviderSummary } from './aggregator';
import { CLAUDE_SVG_PATH, OPENAI_SVG_PATH, brandIconImg } from './brandIcons';
import { I18n } from './i18n';
import { LimitWindow, ProviderLimits } from './limits';
import { Period } from './period';
import { RtkPeriodStats, RtkStats, rtkSavingsPct } from './rtk';

// Brand glyphs shipped as an icon font (contributes.icons in package.json).
export const CLAUDE_ICON = '$(otak-claude)';
export const CODEX_ICON = '$(otak-openai)';
export const RTK_ICON = '$(zap)';

// The tooltip renders the brand marks as inline SVG images (see brandIcons.ts)
// so they can be sized independently of the status-bar icon font — larger than
// the status-bar codicons, which track the status-bar text size.
const TOOLTIP_ICON_SIZE = 18;

const DEFAULT_I18N = new I18n('en');

export function formatCost(v: number): string {
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Human-readable token count in rtk's style: 642, 394.4K, 89.7M, 1.2B. */
export function formatTokens(n: number): string {
    const abs = Math.abs(n);
    for (const [suffix, div] of [['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
        if (abs >= div) {
            return (n / div).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + suffix;
        }
    }
    return String(n);
}

function formatPct(pct: number | undefined): string {
    return pct === undefined ? 'n/a' : pct.toFixed(1) + '%';
}

export interface ProviderView {
    summary: ProviderSummary;
    /** false when the provider's log directory was not found */
    available: boolean;
    show: boolean;
    /** subscription rate-limit snapshot; undefined = unknown or disabled */
    limits?: ProviderLimits;
}

export interface RtkView {
    /** undefined when the rtk CLI is missing or failed — the segment is hidden */
    stats: RtkStats | undefined;
    show: boolean;
}

/** Compact exact token limit for the Optimize action, e.g. 272000 -> 272k. */
export function formatTokenLimit(n: number): string {
    return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString('en-US');
}

export interface ProviderOptimizeView {
    enabled: boolean;
    contextWindow: number;
    autoCompactLimit: number;
}

export interface ContextOptimizeView {
    claude: ProviderOptimizeView;
    codex: ProviderOptimizeView;
}

/**
 * What the status-bar item displays:
 * - `cost`: API-equivalent cost only (default, unchanged behaviour).
 * - `limits`: each provider's most constrained rate-limit percentage only,
 *   falling back to cost when no rate-limit snapshot is available.
 * - `costAndLimits`: cost followed by the rate-limit percentages.
 */
export type StatusBarMode = 'cost' | 'limits' | 'costAndLimits';

export function statusBarText(claude: ProviderView, codex: ProviderView, period: Period, scanning: boolean, mode: StatusBarMode = 'cost'): string {
    if (scanning) {
        return '$(loading~spin) usage';
    }
    const visibleProviders = [claude, codex].filter((view) => view.show && view.available);
    if (visibleProviders.length === 0) {
        return '—';
    }
    const segments: string[] = [];
    if (mode !== 'cost') {
        for (const [icon, view] of [[CLAUDE_ICON, claude], [CODEX_ICON, codex]] as const) {
            const pct = statusBarUsedPercent(view.show && view.available ? view.limits : undefined);
            if (pct !== undefined) {
                segments.push(`${icon} ${Math.round(pct)}%`);
            }
        }
    }
    const parts: string[] = [];
    // 'limits' hides cost, but still shows it when no limit snapshot exists yet.
    if (mode !== 'limits' || segments.length === 0) {
        parts.push(formatCost(visibleProviders.reduce((total, view) => total + periodCost(view, period), 0)));
    }
    if (segments.length > 0) {
        parts.push(segments.join(' '));
    }
    return parts.join('  ');
}

/**
 * The status-bar click cycle: today's cost → this month's cost → limits →
 * back to today's cost. `baseMode` is the mode to restore when leaving the
 * limits view (so a user-configured `costAndLimits` survives the round trip).
 * With rate limits disabled the click degrades to the classic period toggle.
 */
export function cycleStatusBarView(period: Period, mode: StatusBarMode, limitsEnabled: boolean, baseMode: StatusBarMode = 'cost'): { period: Period; mode: StatusBarMode } {
    if (!limitsEnabled) {
        return { period: period === 'today' ? 'month' : 'today', mode };
    }
    if (mode === 'limits') {
        return { period: 'today', mode: baseMode === 'limits' ? 'cost' : baseMode };
    }
    if (period === 'today') {
        return { period: 'month', mode };
    }
    return { period, mode: 'limits' };
}

/**
 * First-run default: subscription users care about their remaining limits
 * more than API-equivalent cost, so when either provider reports a plan
 * (Claude `subscriptionType`, Codex `plan_type`) the status bar should start
 * in `limits` mode. Returns undefined while no snapshot proves a plan yet —
 * the caller keeps the regular `cost` default and may retry later.
 */
export function detectSubscriptionMode(claude: ProviderLimits | undefined, codex: ProviderLimits | undefined): StatusBarMode | undefined {
    return claude?.planType || codex?.planType ? 'limits' : undefined;
}

/**
 * Prefer the provider's longer subscription window for a comparable status-bar
 * view. Providers conventionally place it in `secondary`; weekly-only Codex
 * plans report that same long window in `primary`, which remains the fallback.
 * The tooltip still shows every available window in full.
 */
function statusBarUsedPercent(limits: ProviderLimits | undefined): number | undefined {
    return limits?.secondary?.usedPercent ?? limits?.primary?.usedPercent;
}

/**
 * Display label for a rate-limit window, derived from its reported length
 * (300 min → "5h", 10080 min → "7d"). Codex plans without a session limit
 * report the weekly window in the primary slot, so the positional fallback
 * ("5h"/"7d") only applies when the provider did not report a length.
 */
export function limitWindowLabel(window: LimitWindow, fallback: string): string {
    const minutes = window.windowMinutes;
    if (minutes === undefined || minutes <= 0) {
        return fallback;
    }
    if (minutes % 1440 === 0) {
        return `${minutes / 1440}d`;
    }
    if (minutes % 60 === 0) {
        return `${minutes / 60}h`;
    }
    return `${minutes}m`;
}

function periodCost(view: ProviderView, period: Period): number {
    return period === 'today' ? view.summary.todayCost : view.summary.monthCost;
}

export function tooltipMarkdown(claude: ProviderView, codex: ProviderView, rtk: RtkView, period: Period, updatedAt: Date, i18n = DEFAULT_I18N, iconColor?: string, optimize?: ContextOptimizeView): string {
    const parts: string[] = [`**${i18n.t('tooltip.title')}**\n`];
    const combined = combinedCostSection(claude, codex, i18n);
    if (combined) {
        parts.push(combined);
    }
    const grid = providerGrid(claude, codex, i18n, updatedAt, iconColor);
    if (grid) {
        parts.push(grid);
    }
    if (rtk.show && rtk.stats) {
        parts.push(rtkSection(rtk.stats, i18n));
    }
    const hh = String(updatedAt.getHours()).padStart(2, '0');
    const mm = String(updatedAt.getMinutes()).padStart(2, '0');
    const periodLabel = period === 'today' ? i18n.t('tooltip.today') : i18n.t('tooltip.thisMonth');
    parts.push(`---\n\n${i18n.t('tooltip.period')}: **${periodLabel}** · ${i18n.t('tooltip.updated')} ${hh}:${mm} · ${i18n.t('tooltip.clickToTogglePeriod')}\n`);
    const settingsArg = encodeURIComponent(JSON.stringify(['otakUsage']));
    const optimizeValue = optimize
        ? ` (Claude ${optimize.claude.enabled ? `${formatTokenLimit(optimize.claude.contextWindow)} → ${formatTokenLimit(optimize.claude.autoCompactLimit)}` : 'off'}` +
          ` · Codex ${optimize.codex.enabled ? `${formatTokenLimit(optimize.codex.contextWindow)} → ${formatTokenLimit(optimize.codex.autoCompactLimit)}` : 'off'})`
        : '';
    parts.push(
        `[$(copy) ${i18n.t('tooltip.copySummary')}](command:otak-usage.copyUsage "${i18n.t('tooltip.copySummaryTitle')}")` +
        ` · [$(gear) ${i18n.t('tooltip.settings')}](command:workbench.action.openSettings?${settingsArg} "${i18n.t('tooltip.settingsTitle')}")` +
        ` · [$(rocket) ${i18n.t('tooltip.optimize')}${optimizeValue}](command:otak-usage.configureCodexOptimization "${i18n.t('tooltip.optimizeTitle')}")`,
    );
    return parts.join('\n');
}

function combinedCostSection(claude: ProviderView, codex: ProviderView, i18n: I18n): string | undefined {
    if (!claude.show || !codex.show || !claude.available || !codex.available) {
        return undefined;
    }
    const today = claude.summary.todayCost + codex.summary.todayCost;
    const month = claude.summary.monthCost + codex.summary.monthCost;
    return `**${i18n.t('tooltip.combinedTotal')}: ${formatCost(today)} / ${formatCost(month)}**\n`;
}

/** Plain-text summary written to the clipboard by the Copy Summary link. */
export function clipboardText(claude: ProviderView, codex: ProviderView, rtk: RtkView, now: Date): string {
    const lines: string[] = [`otak-usage ${now.toISOString().slice(0, 16).replace('T', ' ')} (API-equivalent cost, USD)`];
    for (const [title, view] of [['Claude Code', claude], ['Codex CLI', codex]] as const) {
        if (!view.show) {
            continue;
        }
        if (!view.available) {
            lines.push(`${title}: logs not found`);
            continue;
        }
        lines.push(`${title}: today ${formatCost(view.summary.todayCost)} / month ${formatCost(view.summary.monthCost)}`);
        const limits = view.limits;
        if (limits) {
            const rows: string[] = [];
            for (const [fallback, window] of [['5h', limits.primary], ['7d', limits.secondary]] as const) {
                if (window) {
                    const reset = window.resetsAtMs === undefined ? '' : ` (resets ${formatResetTime(window.resetsAtMs, now)})`;
                    rows.push(`    ${limitWindowLabel(window, fallback)} ${Math.round(window.usedPercent)}% used${reset}`);
                }
            }
            if (rows.length > 0) {
                lines.push(`  limits${limits.planType ? ` (${limits.planType})` : ''}:`);
                lines.push(...rows);
            }
        }
        for (const row of view.summary.models) {
            const today = row.todayCost === undefined ? 'n/a' : formatCost(row.todayCost);
            const month = row.monthCost === undefined ? 'n/a' : formatCost(row.monthCost);
            lines.push(`  ${row.model}: today ${today} / month ${month}`);
        }
    }
    if (rtk.show && rtk.stats) {
        const part = (s: RtkPeriodStats) => `${formatTokens(s.savedTokens)} (${formatPct(rtkSavingsPct(s))})`;
        lines.push(`RTK saved: today ${part(rtk.stats.today)} / month ${part(rtk.stats.month)} / all-time ${part(rtk.stats.allTime)}`);
    }
    return lines.join('\n');
}

interface ProviderColumn {
    header: string;
    limits: string[];
    usage: string[];
    total: string | undefined;
}

/**
 * Providers rendered side by side as columns of one table (Claude Code left,
 * Codex right). Every semantic line gets its own table row and shorter groups
 * are padded, so limits, model rows, totals, and the centre divider stay aligned
 * even when the providers expose different amounts of content.
 */
function providerGrid(claude: ProviderView, codex: ProviderView, i18n: I18n, updatedAt: Date, iconColor?: string): string | undefined {
    // With a theme colour available, render the brand marks as independently
    // sized inline images; otherwise fall back to the shared status-bar codicon.
    const claudeIcon = iconColor ? brandIconImg(CLAUDE_SVG_PATH, iconColor, TOOLTIP_ICON_SIZE) : CLAUDE_ICON;
    const codexIcon = iconColor ? brandIconImg(OPENAI_SVG_PATH, iconColor, TOOLTIP_ICON_SIZE) : CODEX_ICON;
    const columns: ProviderColumn[] = [];
    if (claude.show) {
        columns.push(providerColumn('Claude Code', claudeIcon, claude, i18n, updatedAt));
    }
    if (codex.show) {
        columns.push(providerColumn('Codex CLI', codexIcon, codex, i18n, updatedAt));
    }
    if (columns.length === 0) {
        return undefined;
    }
    const lines: string[] = [];
    lines.push(`| ${row(columns.map((c) => c.header))} |`);
    lines.push(`|${columns.map(() => ' :--- ').join('| :---: |')}|`);
    appendAlignedRows(lines, columns.map((column) => column.limits));
    appendAlignedRows(lines, columns.map((column) => column.usage));
    if (columns.some((column) => column.total)) {
        lines.push(`| ${row(columns.map((column) => column.total ?? '&nbsp;'))} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function row(cells: string[]): string {
    return cells.join(' | │ | ');
}

function appendAlignedRows(lines: string[], groups: string[][]): void {
    const height = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < height; index++) {
        lines.push(`| ${row(groups.map((group) => group[index] ?? '&nbsp;'))} |`);
    }
}

function providerColumn(title: string, icon: string, view: ProviderView, i18n: I18n, updatedAt: Date): ProviderColumn {
    const header = `${icon} **${title}**`;
    if (!view.available) {
        return { header, limits: [], usage: [`_${i18n.t('tooltip.logDirectoryNotFound')}_`], total: undefined };
    }
    const limits = limitRows(view.limits, updatedAt, i18n);
    const models = view.summary.models;
    if (models.length === 0) {
        return { header, limits, usage: [`_${i18n.t('tooltip.noUsageThisMonth')}_`], total: undefined };
    }
    const usageLines = models.map((row) => {
        const today = row.todayCost === undefined ? 'n/a' : formatCost(row.todayCost);
        const month = row.monthCost === undefined ? 'n/a' : formatCost(row.monthCost);
        return `${row.model}: ${today} / ${month}`;
    });
    const total = `**${i18n.t('tooltip.total')}: ${formatCost(view.summary.todayCost)} / ${formatCost(view.summary.monthCost)}**`;
    return { header, limits, usage: usageLines, total };
}

/**
 * Rate-limit summary as a header line plus one line per window, e.g.
 * ```
 * $(dashboard) **Limits** (max)
 * 5h · **5% used** · resets 16:40
 * 7d · **19% used** · resets 07-15 14:00
 * ```
 * Lines are joined with `separator` — a Markdown hard break ("  \n") for
 * standalone use, or `<br>` when embedded inside a table cell.
 */
export function limitsLines(limits: ProviderLimits | undefined, now: Date, i18n = DEFAULT_I18N, separator = '  \n'): string | undefined {
    const rows = limitRows(limits, now, i18n);
    return rows.length === 0 ? undefined : rows.join(separator);
}

function limitRows(limits: ProviderLimits | undefined, now: Date, i18n: I18n): string[] {
    if (!limits) {
        return [];
    }
    const rows: string[] = [];
    for (const [fallback, window] of [['5h', limits.primary], ['7d', limits.secondary]] as const) {
        if (!window) {
            continue;
        }
        const used = i18n.t('tooltip.limitUsed', { pct: String(Math.round(window.usedPercent)) });
        rows.push(`${limitWindowLabel(window, fallback)} · **${used}**${resetSuffix(window, now, i18n)}`);
    }
    if (rows.length === 0) {
        return [];
    }
    const plan = limits.planType ? ` (${limits.planType})` : '';
    return [`$(dashboard) **${i18n.t('tooltip.limits')}**${plan}`, ...rows];
}

function resetSuffix(window: LimitWindow, now: Date, i18n: I18n): string {
    if (window.resetsAtMs === undefined) {
        return '';
    }
    return ` · ${i18n.t('tooltip.limitResets', { time: formatResetTime(window.resetsAtMs, now) })}`;
}

/** HH:mm for same-day resets, MM-DD HH:mm otherwise (local time). */
function formatResetTime(resetsAtMs: number, now: Date): string {
    const d = new Date(resetsAtMs);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return hhmm;
    }
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

function rtkSection(stats: RtkStats, i18n: I18n): string {
    const lines: string[] = [`${RTK_ICON} **${i18n.t('tooltip.rtkTitle')}**\n`];
    lines.push(`| ${i18n.t('tooltip.period')} | ${i18n.t('tooltip.input')} | ${i18n.t('tooltip.output')} | ${i18n.t('tooltip.saved')} | ${i18n.t('tooltip.rate')} |`);
    lines.push('| :--- | ---: | ---: | ---: | ---: |');
    for (const [label, s] of [[i18n.t('tooltip.today'), stats.today], [i18n.t('tooltip.thisMonth'), stats.month], [i18n.t('tooltip.allTime'), stats.allTime]] as const) {
        lines.push(`| ${label} | ${formatTokens(s.inputTokens)} | ${formatTokens(s.outputTokens)} | ${formatTokens(s.savedTokens)} | ${formatPct(rtkSavingsPct(s))} |`);
    }
    lines.push('');
    return lines.join('\n');
}
