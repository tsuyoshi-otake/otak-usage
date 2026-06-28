import { ProviderSummary } from './aggregator';
import { I18n } from './i18n';
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

export function tooltipMarkdown(claude: ProviderView, codex: ProviderView, rtk: RtkView, period: Period, updatedAt: Date, i18n = DEFAULT_I18N): string {
    const parts: string[] = [`**${i18n.t('tooltip.title')}**\n`];
    const combined = combinedCostSection(claude, codex, i18n);
    if (combined) {
        parts.push(combined);
    }
    if (claude.show) {
        parts.push(providerSection('Claude Code', CLAUDE_ICON, claude, i18n));
    }
    if (codex.show) {
        parts.push(providerSection('Codex CLI', CODEX_ICON, codex, i18n));
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

function providerSection(title: string, icon: string, view: ProviderView, i18n: I18n): string {
    const lines: string[] = [`${icon} **${title}**\n`];
    if (!view.available) {
        lines.push(`_${i18n.t('tooltip.logDirectoryNotFound')}_\n`);
        return lines.join('\n');
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
