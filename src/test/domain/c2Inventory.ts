export interface AtomicCondition {
    id: string;
    source: 'types.ts' | 'pricing.ts' | 'aggregator.ts' | 'period.ts';
    expression: string;
    requirement: string;
}

/**
 * Atomic boolean conditions in the domain modules. Nullish selection is listed
 * where choosing the fallback changes domain behaviour. Loop termination and
 * TypeScript-emitted helper branches are intentionally outside this inventory.
 */
export const C2_INVENTORY: readonly AtomicCondition[] = [
    { id: 'T-LCI-TARGET', source: 'types.ts', expression: 'target.longContextInput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'T-LCI-SOURCE', source: 'types.ts', expression: 'source.longContextInput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'T-LCC-TARGET', source: 'types.ts', expression: 'target.longContextCachedInput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'T-LCC-SOURCE', source: 'types.ts', expression: 'source.longContextCachedInput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'T-LCO-TARGET', source: 'types.ts', expression: 'target.longContextOutput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'T-LCO-SOURCE', source: 'types.ts', expression: 'source.longContextOutput is defined', requirement: 'Missing long-context counters behave as zero.' },
    { id: 'P-ORDER-EXACT', source: 'pricing.ts', expression: 'exact order exists', requirement: 'An exact built-in model has a stable display order.' },
    { id: 'P-MATCH-PREFIX', source: 'pricing.ts', expression: 'model starts with pricing key', requirement: 'Dated model identifiers inherit a base price.' },
    { id: 'P-MATCH-FAST-KEY', source: 'pricing.ts', expression: 'key ends with -fast', requirement: 'Only fast pricing keys participate in normalized fast matching.' },
    { id: 'P-MATCH-FAST-MODEL', source: 'pricing.ts', expression: 'model ends with -fast', requirement: 'Only fast model identifiers receive fast prices.' },
    { id: 'P-OVERRIDES', source: 'pricing.ts', expression: 'overrides supplied', requirement: 'Pricing overrides are optional.' },
    { id: 'P-BASE-MISSING', source: 'pricing.ts', expression: 'base pricing is missing', requirement: 'Override-only models are supported and wholly unknown models are rejected.' },
    { id: 'P-OVERRIDE-MISSING', source: 'pricing.ts', expression: 'override pricing is missing', requirement: 'Built-in models do not require an override.' },
    { id: 'P-EFFECTIVE-DAY', source: 'pricing.ts', expression: 'effective day supplied', requirement: 'Scheduled prices apply only when a billing day is known.' },
    { id: 'P-REVISION-ACTIVE', source: 'pricing.ts', expression: 'effective day >= revision day', requirement: 'A revision applies on, not before, its effective day.' },
    { id: 'P-INPUT-MISSING', source: 'pricing.ts', expression: 'input rate is missing', requirement: 'A usable price requires both input and output rates.' },
    { id: 'P-OUTPUT-MISSING', source: 'pricing.ts', expression: 'output rate is missing', requirement: 'A usable price requires both input and output rates.' },
    { id: 'P-LONG-THRESHOLD', source: 'pricing.ts', expression: 'long-context threshold exists', requirement: 'Only models declaring a threshold can be premium requests.' },
    { id: 'P-LONG-ABOVE', source: 'pricing.ts', expression: 'input tokens > threshold', requirement: 'The threshold itself is standard price; premium begins one token above.' },
    { id: 'P-COST-PRICED', source: 'pricing.ts', expression: 'resolved pricing exists', requirement: 'Unknown models return no cost.' },
    { id: 'A-DAY-EXISTS', source: 'aggregator.ts', expression: 'day bucket exists', requirement: 'Events on the same day accumulate without replacing prior events.' },
    { id: 'A-MODEL-EXISTS', source: 'aggregator.ts', expression: 'model bucket exists', requirement: 'Events for the same model accumulate; other models remain separate.' },
    { id: 'A-PRUNE-BEFORE', source: 'aggregator.ts', expression: 'day < minimum day', requirement: 'Pruning removes only days strictly before the inclusive boundary.' },
    { id: 'A-ROW-EXISTS', source: 'aggregator.ts', expression: 'summary row exists', requirement: 'One model row accumulates across days.' },
    { id: 'A-DAY-PRICED', source: 'aggregator.ts', expression: 'day cost is defined', requirement: 'Any unpriced day makes the model month cost unknown.' },
    { id: 'A-IS-TODAY', source: 'aggregator.ts', expression: 'bucket day equals today', requirement: 'Today usage excludes every other retained day.' },
    { id: 'A-MONTH-PRICED', source: 'aggregator.ts', expression: 'all model days are priced', requirement: 'Unknown month costs do not enter provider totals.' },
    { id: 'A-KNOWN-ORDER-A', source: 'aggregator.ts', expression: 'left model has built-in order', requirement: 'Known models sort ahead of unknown models.' },
    { id: 'A-KNOWN-ORDER-B', source: 'aggregator.ts', expression: 'right model has built-in order', requirement: 'Known models sort ahead of unknown models.' },
    { id: 'A-ORDER-LESS', source: 'aggregator.ts', expression: 'left unknown model id < right unknown model id', requirement: 'Unknown models have deterministic lexical ordering.' },
    { id: 'A-ORDER-GREATER', source: 'aggregator.ts', expression: 'left unknown model id > right unknown model id', requirement: 'Unknown models have deterministic lexical ordering.' },
] as const;

export class AtomicConditionCoverage {
    private readonly outcomes = new Map<string, Set<boolean>>();

    record(id: string, ...outcomes: boolean[]): void {
        if (!C2_INVENTORY.some(condition => condition.id === id)) {
            throw new Error(`Unknown C2 condition ${id}`);
        }
        const observed = this.outcomes.get(id) ?? new Set<boolean>();
        outcomes.forEach(outcome => observed.add(outcome));
        this.outcomes.set(id, observed);
    }

    report(): { covered: number; total: number; percent: number; missing: string[]; conditions: Array<AtomicCondition & { outcomes: boolean[] }> } {
        const missing: string[] = [];
        let covered = 0;
        const conditions: Array<AtomicCondition & { outcomes: boolean[] }> = [];
        for (const condition of C2_INVENTORY) {
            const outcomes = this.outcomes.get(condition.id) ?? new Set<boolean>();
            conditions.push({ ...condition, outcomes: [...outcomes].sort() });
            for (const value of [false, true]) {
                if (outcomes.has(value)) {
                    covered++;
                } else {
                    missing.push(`${condition.id}=${value}`);
                }
            }
        }
        const total = C2_INVENTORY.length * 2;
        return { covered, total, percent: total === 0 ? 100 : (covered / total) * 100, missing, conditions };
    }

    assertComplete(): void {
        const report = this.report();
        if (report.missing.length > 0) {
            throw new Error(`Atomic-condition C2 ${report.covered}/${report.total} (${report.percent.toFixed(1)}%); missing ${report.missing.join(', ')}`);
        }
    }
}
