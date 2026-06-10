import { ProviderSummary } from './aggregator';
import { Period } from './period';

export const CLAUDE_ICON = '$(sparkle)';
export const CODEX_ICON = '⬡';

export function formatCost(v: number): string {
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface ProviderView {
    summary: ProviderSummary;
    /** false when the provider's log directory was not found */
    available: boolean;
    show: boolean;
}

export function statusBarText(claude: ProviderView, codex: ProviderView, period: Period, scanning: boolean): string {
    if (scanning) {
        return '$(loading~spin) usage';
    }
    const segments: string[] = [];
    if (claude.show) {
        segments.push(`${CLAUDE_ICON} ${segmentText(claude, period)}`);
    }
    if (codex.show) {
        segments.push(`${CODEX_ICON} ${segmentText(codex, period)}`);
    }
    return segments.join('  ');
}

function segmentText(view: ProviderView, period: Period): string {
    if (!view.available) {
        return '—';
    }
    return formatCost(period === 'today' ? view.summary.todayCost : view.summary.monthCost);
}

export function tooltipMarkdown(claude: ProviderView, codex: ProviderView, period: Period, updatedAt: Date): string {
    const parts: string[] = ['**otak-usage — API-equivalent cost**\n'];
    if (claude.show) {
        parts.push(providerSection('Claude Code', CLAUDE_ICON, claude));
    }
    if (codex.show) {
        parts.push(providerSection('Codex CLI', CODEX_ICON, codex));
    }
    const hh = String(updatedAt.getHours()).padStart(2, '0');
    const mm = String(updatedAt.getMinutes()).padStart(2, '0');
    const periodLabel = period === 'today' ? 'Today' : 'This Month';
    parts.push(`---\n\nPeriod: **${periodLabel}** · Updated ${hh}:${mm} · Click to toggle period\n`);
    parts.push('[$(copy) Copy Summary](command:otak-usage.copyUsage "Copy the usage summary to the clipboard")');
    return parts.join('\n');
}

/** Plain-text summary written to the clipboard by the Copy Summary link. */
export function clipboardText(claude: ProviderView, codex: ProviderView, now: Date): string {
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
    if (view.summary.hasUnknownModel) {
        lines.push('$(warning) Some models have no known pricing and are counted as $0. Add them to `otakUsage.pricingOverrides`.\n');
    }
    return lines.join('\n');
}
