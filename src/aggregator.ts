import { DayBuckets, Provider, TokenUsage, UsageEvent, addUsage, bucketKey, emptyUsage, parseBucketKey } from './types';
import { dayKey } from './period';
import { PricingOverrides, calcCost } from './pricing';

export function addEvent(days: DayBuckets, event: UsageEvent): void {
    const day = dayKey(event.timestamp);
    const key = bucketKey(event.provider, event.model);
    const bucket = (days[day] ??= {});
    const usage = (bucket[key] ??= emptyUsage());
    addUsage(usage, event.usage);
}

/** Drop buckets for days before minDay (inclusive keep). Returns true if anything was removed. */
export function pruneDaysBefore(days: DayBuckets, minDay: string): boolean {
    let pruned = false;
    for (const day of Object.keys(days)) {
        if (day < minDay) {
            delete days[day];
            pruned = true;
        }
    }
    return pruned;
}

export interface ModelRow {
    model: string;
    todayUsage: TokenUsage;
    monthUsage: TokenUsage;
    todayCost: number | undefined;
    monthCost: number | undefined;
}

export interface ProviderSummary {
    provider: Provider;
    todayCost: number;
    monthCost: number;
    hasUnknownModel: boolean;
    models: ModelRow[];
}

/**
 * Summarize all retained days (callers prune to the current month) into
 * per-provider, per-model today/month costs. Unknown models contribute $0
 * and set hasUnknownModel.
 */
export function summarize(days: DayBuckets, today: string, overrides?: PricingOverrides): Record<Provider, ProviderSummary> {
    const rows = new Map<string, ModelRow & { provider: Provider }>();
    for (const [day, bucket] of Object.entries(days)) {
        for (const [key, usage] of Object.entries(bucket)) {
            const { provider, model } = parseBucketKey(key);
            let row = rows.get(key);
            if (!row) {
                row = { provider, model, todayUsage: emptyUsage(), monthUsage: emptyUsage(), todayCost: undefined, monthCost: undefined };
                rows.set(key, row);
            }
            addUsage(row.monthUsage, usage);
            if (day === today) {
                addUsage(row.todayUsage, usage);
            }
        }
    }
    const result: Record<Provider, ProviderSummary> = {
        claude: { provider: 'claude', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
        codex: { provider: 'codex', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
    };
    for (const row of rows.values()) {
        row.todayCost = calcCost(row.model, row.todayUsage, overrides, today);
        row.monthCost = calcCost(row.model, row.monthUsage, overrides, today);
        const summary = result[row.provider];
        summary.todayCost += row.todayCost ?? 0;
        summary.monthCost += row.monthCost ?? 0;
        if (row.monthCost === undefined) {
            summary.hasUnknownModel = true;
        }
        summary.models.push(row);
    }
    for (const summary of Object.values(result)) {
        summary.models.sort((a, b) => (b.monthCost ?? 0) - (a.monthCost ?? 0));
    }
    return result;
}
