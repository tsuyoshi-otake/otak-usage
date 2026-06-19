import { ProviderSummary } from './aggregator';
import { Period } from './period';
import { RtkPeriodStats, RtkStats, rtkSavingsPct } from './rtk';

export const CLAUDE_ICON = '$(sparkle)';
export const CODEX_ICON = '⬡';
export const RTK_ICON = '$(zap)';

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
}

export interface RtkView {
    /** undefined when the rtk CLI is missing or failed — the segment is hidden */
    stats: RtkStats | undefined;
    show: boolean;
}

export function statusBarText(claude: ProviderView, codex: ProviderView, period: Period, scanning: boolean): string {
    if (scanning) {
        return '$(loading~spin) usage';
    }
    const visibleProviders = [claude, codex].filter((view) => view.show && view.available);
    if (visibleProviders.length === 0) {
        return '—';
    }
    return formatCost(visibleProviders.reduce((total, view) => total + periodCost(view, period), 0));
}

function periodCost(view: ProviderView, period: Period): number {
    return period === 'today' ? view.summary.todayCost : view.summary.monthCost;
}

export function tooltipMarkdown(claude: ProviderView, codex: ProviderView, rtk: RtkView, period: Period, updatedAt: Date): string {
    const parts: string[] = ['**otak-usage — API-equivalent cost**\n'];
    if (claude.show) {
        parts.push(providerSection('Claude Code', CLAUDE_ICON, claude));
    }
    if (codex.show) {
        parts.push(providerSection('Codex CLI', CODEX_ICON, codex));
    }
    if (rtk.show && rtk.stats) {
        parts.push(rtkSection(rtk.stats));
    }
    const hh = String(updatedAt.getHours()).padStart(2, '0');
    const mm = String(updatedAt.getMinutes()).padStart(2, '0');
    const periodLabel = period === 'today' ? 'Today' : 'This Month';
    parts.push(`---\n\nPeriod: **${periodLabel}** · Updated ${hh}:${mm} · Click to toggle period\n`);
    parts.push('[$(copy) Copy Summary](command:otak-usage.copyUsage "Copy the usage summary to the clipboard")');
    return parts.join('\n');
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

function providerSection(title: string, icon: string, view: ProviderView): string {
    const lines: string[] = [`${icon} **${title}**\n`];
    if (!view.available) {
        lines.push('_Log directory not found._\n');
        return lines.join('\n');
    }
    const models = view.summary.models;
    if (models.length === 0) {
        lines.push('_No usage this month._\n');
        return lines.join('\n');
    }
    lines.push('| Model | Today | This Month |');
    lines.push('| :--- | ---: | ---: |');
    for (const row of models) {
        const today = row.todayCost === undefined ? 'n/a' : formatCost(row.todayCost);
        const month = row.monthCost === undefined ? 'n/a' : formatCost(row.monthCost);
        lines.push(`| ${row.model} | ${today} | ${month} |`);
    }
    lines.push(`| **Total** | **${formatCost(view.summary.todayCost)}** | **${formatCost(view.summary.monthCost)}** |`);
    lines.push('');
    return lines.join('\n');
}

function rtkSection(stats: RtkStats): string {
    const lines: string[] = [`${RTK_ICON} **RTK — Token Savings**\n`];
    lines.push('| Period | Input | Output | Saved | Rate |');
    lines.push('| :--- | ---: | ---: | ---: | ---: |');
    for (const [label, s] of [['Today', stats.today], ['This Month', stats.month], ['All Time', stats.allTime]] as const) {
        lines.push(`| ${label} | ${formatTokens(s.inputTokens)} | ${formatTokens(s.outputTokens)} | ${formatTokens(s.savedTokens)} | ${formatPct(rtkSavingsPct(s))} |`);
    }
    lines.push('');
    return lines.join('\n');
}
