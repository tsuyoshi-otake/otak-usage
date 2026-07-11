import { ProviderSummary } from './aggregator';
import { I18n } from './i18n';
import { LimitWindow, ProviderLimits } from './limits';
import { Period } from './period';
import { RtkPeriodStats, RtkStats, rtkSavingsPct } from './rtk';

export const CLAUDE_ICON = '$(sparkle)';
export const CODEX_ICON = '⬡';
export const RTK_ICON = '$(zap)';

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
            const pct = worstUsedPercent(view.show && view.available ? view.limits : undefined);
            if (pct !== undefined) {
                segments.push(`${icon}${Math.round(pct)}%`);
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

/** The most constrained window's used percentage — what the user will hit first. */
function worstUsedPercent(limits: ProviderLimits | undefined): number | undefined {
    const values = [limits?.primary?.usedPercent, limits?.secondary?.usedPercent].filter((v): v is number => v !== undefined);
    return values.length === 0 ? undefined : Math.max(...values);
}

function periodCost(view: ProviderView, period: Period): number {
    return period === 'today' ? view.summary.todayCost : view.summary.monthCost;
}

export function tooltipMarkdown(claude: ProviderView, codex: ProviderView, rtk: RtkView, period: Period, updatedAt: Date, i18n = DEFAULT_I18N): string {
    const parts: string[] = [`**${i18n.t('tooltip.title')}**\n`];
    const combined = combinedCostSection(claude, codex, i18n);
    if (combined) {
        parts.push(combined);
    }
    if (claude.show) {
        parts.push(providerSection('Claude Code', CLAUDE_ICON, claude, i18n, updatedAt));
    }
    if (codex.show) {
        parts.push(providerSection('Codex CLI', CODEX_ICON, codex, i18n, updatedAt));
    }
    if (rtk.show && rtk.stats) {
        parts.push(rtkSection(rtk.stats, i18n));
    }
    const hh = String(updatedAt.getHours()).padStart(2, '0');
    const mm = String(updatedAt.getMinutes()).padStart(2, '0');
    const periodLabel = period === 'today' ? i18n.t('tooltip.today') : i18n.t('tooltip.thisMonth');
    parts.push(`---\n\n${i18n.t('tooltip.period')}: **${periodLabel}** · ${i18n.t('tooltip.updated')} ${hh}:${mm} · ${i18n.t('tooltip.clickToTogglePeriod')}\n`);
    const settingsArg = encodeURIComponent(JSON.stringify(['otakUsage.telemetry']));
    parts.push(
        `[$(copy) ${i18n.t('tooltip.copySummary')}](command:otak-usage.copyUsage "${i18n.t('tooltip.copySummaryTitle')}")` +
        ` · [$(gear) ${i18n.t('tooltip.settings')}](command:workbench.action.openSettings?${settingsArg} "${i18n.t('tooltip.settingsTitle')}")`,
    );
    return parts.join('\n');
}

function combinedCostSection(claude: ProviderView, codex: ProviderView, i18n: I18n): string | undefined {
    if (!claude.show || !codex.show || !claude.available || !codex.available) {
        return undefined;
    }
    const lines: string[] = [`**${i18n.t('tooltip.combinedTotal')}**\n`];
    lines.push(`| ${i18n.t('tooltip.today')} | ${i18n.t('tooltip.thisMonth')} |`);
    lines.push('| ---: | ---: |');
    lines.push(`| **${formatCost(claude.summary.todayCost + codex.summary.todayCost)}** | **${formatCost(claude.summary.monthCost + codex.summary.monthCost)}** |`);
    lines.push('');
    return lines.join('\n');
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
            for (const [label, window] of [['5h', limits.primary], ['7d', limits.secondary]] as const) {
                if (window) {
                    const reset = window.resetsAtMs === undefined ? '' : ` (resets ${formatResetTime(window.resetsAtMs, now)})`;
                    rows.push(`    ${label} ${Math.round(window.usedPercent)}% used${reset}`);
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

function providerSection(title: string, icon: string, view: ProviderView, i18n: I18n, updatedAt: Date): string {
    const lines: string[] = [`${icon} **${title}**\n`];
    if (!view.available) {
        lines.push(`_${i18n.t('tooltip.logDirectoryNotFound')}_\n`);
        return lines.join('\n');
    }
    const limits = limitsLines(view.limits, updatedAt, i18n);
    if (limits) {
        lines.push(`${limits}\n`);
    }
    const models = view.summary.models;
    if (models.length === 0) {
        lines.push(`_${i18n.t('tooltip.noUsageThisMonth')}_\n`);
        return lines.join('\n');
    }
    lines.push(`| ${i18n.t('tooltip.model')} | ${i18n.t('tooltip.today')} | ${i18n.t('tooltip.thisMonth')} |`);
    lines.push('| :--- | ---: | ---: |');
    for (const row of models) {
        const today = row.todayCost === undefined ? 'n/a' : formatCost(row.todayCost);
        const month = row.monthCost === undefined ? 'n/a' : formatCost(row.monthCost);
        lines.push(`| ${row.model} | ${today} | ${month} |`);
    }
    lines.push(`| **${i18n.t('tooltip.total')}** | **${formatCost(view.summary.todayCost)}** | **${formatCost(view.summary.monthCost)}** |`);
    lines.push('');
    return lines.join('\n');
}

/**
 * Rate-limit summary as a header line plus one line per window, e.g.
 * ```
 * $(dashboard) **Limits** (max)
 * 5h · **5% used** · resets 16:40
 * 7d · **19% used** · resets 07-15 14:00
 * ```
 * Lines are joined with a Markdown hard break ("  \n") so each window renders
 * on its own row inside the tooltip.
 */
export function limitsLines(limits: ProviderLimits | undefined, now: Date, i18n = DEFAULT_I18N): string | undefined {
    if (!limits) {
        return undefined;
    }
    const rows: string[] = [];
    for (const [label, window] of [['5h', limits.primary], ['7d', limits.secondary]] as const) {
        if (!window) {
            continue;
        }
        const used = i18n.t('tooltip.limitUsed', { pct: String(Math.round(window.usedPercent)) });
        rows.push(`${label} · **${used}**${resetSuffix(window, now, i18n)}`);
    }
    if (rows.length === 0) {
        return undefined;
    }
    const plan = limits.planType ? ` (${limits.planType})` : '';
    return [`$(dashboard) **${i18n.t('tooltip.limits')}**${plan}`, ...rows].join('  \n');
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
