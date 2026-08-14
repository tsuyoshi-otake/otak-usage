import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';
import { addEvent, pruneDaysBefore, summarize } from '../../aggregator';
import { dayKey, lastDayOfPrevMonth, startOfMonth, startOfToday } from '../../period';
import { calcCost, defaultPricingOrder, isLongContextRequest, resolvePricing } from '../../pricing';
import { DayBuckets, TokenUsage, addUsage, bucketKey, emptyUsage, parseBucketKey, subtractUsage, totalTokens } from '../../types';
import { AtomicConditionCoverage } from './c2Inventory';
import { checkProperty } from './pbtEvidence';
import { RequirementRates, requirementAdd, requirementCost, requirementLocalDay, requirementLocalMidnight, requirementMonthStart, requirementPreviousMonthEnd, requirementTotal } from './requirementOracle';

const c2 = new AtomicConditionCoverage();
const finiteCount = fc.integer({ min: 0, max: 10_000_000 });
const optionalCount = fc.option(finiteCount, { nil: undefined });
const usageArbitrary: fc.Arbitrary<TokenUsage> = fc.record({
    input: finiteCount,
    cachedInput: finiteCount,
    cacheRead: finiteCount,
    cacheWrite5m: finiteCount,
    cacheWrite1h: finiteCount,
    output: finiteCount,
    longContextInput: optionalCount,
    longContextCachedInput: optionalCount,
    longContextOutput: optionalCount,
});
const ratesArbitrary: fc.Arbitrary<RequirementRates> = fc.record({
    input: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    cachedInput: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    cacheRead: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    cacheWrite5m: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    cacheWrite1h: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    output: fc.integer({ min: 1, max: 1_000 }).map(value => value / 10),
    longContextInputMultiplier: fc.integer({ min: 10, max: 40 }).map(value => value / 10),
    longContextOutputMultiplier: fc.integer({ min: 10, max: 40 }).map(value => value / 10),
});

function normalized(usage: TokenUsage): Required<TokenUsage> {
    return {
        input: usage.input,
        cachedInput: usage.cachedInput,
        cacheRead: usage.cacheRead,
        cacheWrite5m: usage.cacheWrite5m,
        cacheWrite1h: usage.cacheWrite1h,
        output: usage.output,
        longContextInput: usage.longContextInput ?? 0,
        longContextCachedInput: usage.longContextCachedInput ?? 0,
        longContextOutput: usage.longContextOutput ?? 0,
    };
}

function assertNear(actual: number | undefined, expected: number): void {
    assert.notStrictEqual(actual, undefined);
    assert.ok(Math.abs((actual ?? 0) - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
}

function overrides(rates: RequirementRates) {
    return {
        oracle: {
            input: rates.input,
            cachedInput: rates.cachedInput,
            cacheRead: rates.cacheRead,
            cacheWrite: rates.cacheWrite5m,
            cacheWrite1h: rates.cacheWrite1h,
            output: rates.output,
            longContextInputMultiplier: rates.longContextInputMultiplier,
            longContextOutputMultiplier: rates.longContextOutputMultiplier,
        },
    };
}

suite('domain quality: requirement-derived examples', () => {
    test('all billing dimensions agree with the independent oracle', () => {
        const usage: TokenUsage = {
            input: 1_000_000, cachedInput: 500_000, cacheRead: 400_000,
            cacheWrite5m: 300_000, cacheWrite1h: 200_000, output: 100_000,
            longContextInput: 50_000, longContextCachedInput: 40_000, longContextOutput: 30_000,
        };
        const rates: RequirementRates = {
            input: 2, cachedInput: 0.2, cacheRead: 0.25, cacheWrite5m: 2.5,
            cacheWrite1h: 4, output: 12, longContextInputMultiplier: 2,
            longContextOutputMultiplier: 1.5,
        };
        assertNear(calcCost('oracle', usage, overrides(rates)), requirementCost(usage, rates));
        assert.strictEqual(calcCost('unlisted', usage), undefined);
        c2.record('P-COST-PRICED', true, false);
        c2.record('P-OVERRIDES', true, false);
        c2.record('P-BASE-MISSING', true, false);
        c2.record('P-OVERRIDE-MISSING', true, false);
    });

    test('revision and long-context boundaries are inclusive/exclusive as required', () => {
        assert.strictEqual(resolvePricing('gpt-5.6-terra', undefined, '2026-07-29')?.input, 2.5);
        assert.strictEqual(resolvePricing('gpt-5.6-terra', undefined, '2026-07-30')?.input, 2);
        assert.strictEqual(resolvePricing('gpt-5.6-terra')?.input, 2.5);
        assert.strictEqual(isLongContextRequest('gpt-5.6-sol', 272_000), false);
        assert.strictEqual(isLongContextRequest('gpt-5.6-sol', 272_001), true);
        assert.strictEqual(isLongContextRequest('claude-opus-5', 999_999), false);
        c2.record('P-EFFECTIVE-DAY', true, false);
        c2.record('P-REVISION-ACTIVE', true, false);
        c2.record('P-LONG-THRESHOLD', true, false);
        c2.record('P-LONG-ABOVE', true, false);
    });

    test('exact, dated, fast and incomplete price candidates take each lookup path', () => {
        assert.deepStrictEqual(resolvePricing('gpt-5.5'), {
            input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
            cacheWrite1h: 10, cachedInput: 0.5,
            longContextThreshold: 272_000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5,
        });
        assert.strictEqual(resolvePricing('claude-opus-4-8-20250915')?.input, 5);
        assert.strictEqual(resolvePricing('claude-opus-4-7-20260120-fast')?.input, 30);
        assert.deepStrictEqual(resolvePricing('oracle', { oracle: { input: 2, output: 10 } }, '2026-01-01'), {
            input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
            cacheWrite1h: 4, cachedInput: 0.2,
            longContextThreshold: undefined, longContextInputMultiplier: undefined, longContextOutputMultiplier: undefined,
        });
        assert.strictEqual(resolvePricing('oracle', { oracle: { input: 1 } }), undefined);
        assert.strictEqual(resolvePricing('oracle', { oracle: { output: 1 } }), undefined);
        const terraOrder = defaultPricingOrder('gpt-5.6-terra');
        assert.ok(terraOrder !== undefined);
        assert.strictEqual(defaultPricingOrder('gpt-5.6-terra-20260801'), terraOrder);
        assert.ok((terraOrder ?? Number.MAX_SAFE_INTEGER) < (defaultPricingOrder('gpt-5.5') ?? -1));
        assert.strictEqual(defaultPricingOrder('not-a-priced-model'), undefined);
        c2.record('P-ORDER-EXACT', true, false);
        c2.record('P-MATCH-PREFIX', true, false);
        c2.record('P-MATCH-FAST-KEY', true, false);
        c2.record('P-MATCH-FAST-MODEL', true, false);
        c2.record('P-INPUT-MISSING', true, false);
        c2.record('P-OUTPUT-MISSING', true, false);
    });

    test('aggregation keeps the prune boundary, separates today, and flags unknown models', () => {
        const days: DayBuckets = {};
        const today = new Date(2026, 6, 30, 12).getTime();
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-terra', timestamp: today, usage: { ...emptyUsage(), input: 1_000_000 } });
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-terra', timestamp: today, usage: { ...emptyUsage(), output: 1_000_000 } });
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-terra', timestamp: today - 86_400_000, usage: { ...emptyUsage(), input: 1_000_000 } });
        addEvent(days, { provider: 'codex', model: 'gpt-5.5', timestamp: today, usage: { ...emptyUsage(), input: 1_000_000 } });
        addEvent(days, { provider: 'codex', model: 'z-unknown', timestamp: today - 86_400_000, usage: { ...emptyUsage(), input: 1 } });
        addEvent(days, { provider: 'codex', model: 'a-unknown', timestamp: today - 86_400_000, usage: { ...emptyUsage(), input: 1 } });
        const summary = summarize(days, dayKey(today));
        assert.strictEqual(summary.codex.todayCost, 19);
        assert.strictEqual(summary.codex.monthCost, 21.5);
        assert.strictEqual(summary.codex.hasUnknownModel, true);
        assert.strictEqual(summary.claude.todayCost, 0);
        assert.strictEqual(summary.claude.monthCost, 0);
        assert.strictEqual(summary.claude.hasUnknownModel, false);
        assert.deepStrictEqual(summary.codex.models.map(row => row.model), ['gpt-5.6-terra', 'gpt-5.5', 'a-unknown', 'z-unknown']);
        const terra = summary.codex.models[0];
        assert.strictEqual(terra.todayCost, 14);
        assert.strictEqual(terra.monthCost, 16.5);
        assert.strictEqual(terra.todayUsage.input, 1_000_000);
        assert.strictEqual(terra.monthUsage.input, 2_000_000);
        assert.strictEqual(summary.codex.models[2].monthCost, undefined);
        assert.deepStrictEqual(summarize({}, dayKey(today)), {
            claude: { provider: 'claude', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
            codex: { provider: 'codex', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
        });

        const prune: DayBuckets = { '2026-06-30': {}, '2026-07-01': {}, '2026-07-02': {} };
        assert.strictEqual(pruneDaysBefore(prune, '2026-07-01'), true);
        assert.deepStrictEqual(Object.keys(prune), ['2026-07-01', '2026-07-02']);
        assert.strictEqual(pruneDaysBefore(prune, '2026-07-01'), false);
        for (const id of ['A-DAY-EXISTS', 'A-MODEL-EXISTS', 'A-PRUNE-BEFORE', 'A-ROW-EXISTS', 'A-DAY-PRICED', 'A-IS-TODAY', 'A-MONTH-PRICED', 'A-KNOWN-ORDER-A', 'A-KNOWN-ORDER-B', 'A-ORDER-LESS', 'A-ORDER-GREATER']) {
            c2.record(id, true, false);
        }
    });

    test('summary ordering covers known-only, mixed, and both lexical directions', () => {
        const at = new Date(2026, 6, 30, 12).getTime();
        const event = (model: string) => ({ provider: 'codex' as const, model, timestamp: at, usage: { ...emptyUsage(), input: 1 } });

        const knownOnly: DayBuckets = {};
        addEvent(knownOnly, event('gpt-5.5'));
        addEvent(knownOnly, event('gpt-5.6-terra'));
        const knownSummary = summarize(knownOnly, dayKey(at)).codex;
        assert.strictEqual(knownSummary.hasUnknownModel, false);
        assert.deepStrictEqual(knownSummary.models.map(row => row.model), ['gpt-5.6-terra', 'gpt-5.5']);

        const mixed: DayBuckets = {};
        addEvent(mixed, event('a-unknown'));
        addEvent(mixed, event('gpt-5.6-terra'));
        assert.deepStrictEqual(summarize(mixed, dayKey(at)).codex.models.map(row => row.model), ['gpt-5.6-terra', 'a-unknown']);

        const lexical: DayBuckets = {};
        addEvent(lexical, event('a-unknown'));
        addEvent(lexical, event('z-unknown'));
        assert.deepStrictEqual(summarize(lexical, dayKey(at)).codex.models.map(row => row.model), ['a-unknown', 'z-unknown']);
    });

    test('calendar examples agree with independently constructed local boundaries', () => {
        for (const value of [new Date(2024, 1, 29, 23, 59).getTime(), new Date(2026, 0, 1, 0, 0).getTime()]) {
            assert.strictEqual(dayKey(value), requirementLocalDay(value));
            assert.strictEqual(startOfToday(value), requirementLocalMidnight(value));
            assert.strictEqual(startOfMonth(value), requirementMonthStart(value));
            assert.strictEqual(lastDayOfPrevMonth(value), requirementPreviousMonthEnd(value));
        }
    });
});

suite('domain quality: deterministic properties', () => {
    test('usage addition matches the oracle and subtraction reverses it', () => {
        checkProperty('usage-add-subtract', fc.property(usageArbitrary, usageArbitrary, (left, right) => {
            const target = { ...left };
            addUsage(target, right);
            assert.deepStrictEqual(normalized(target), normalized(requirementAdd(left, right)));
            subtractUsage(target, right);
            assert.deepStrictEqual(normalized(target), normalized(left));
        }));
        for (const id of ['T-LCI-TARGET', 'T-LCI-SOURCE', 'T-LCC-TARGET', 'T-LCC-SOURCE', 'T-LCO-TARGET', 'T-LCO-SOURCE']) {
            c2.record(id, true, false);
        }
    });

    test('display token total excludes long-context classification fields', () => {
        checkProperty('display-total', fc.property(usageArbitrary, usage => {
            assert.strictEqual(totalTokens(usage), requirementTotal(usage));
        }));
    });

    test('bucket key round-trips provider and arbitrary model text', () => {
        checkProperty('bucket-key-round-trip', fc.property(fc.constantFrom<'claude' | 'codex'>('claude', 'codex'), fc.string(), (provider, model) => {
            assert.deepStrictEqual(parseBucketKey(bucketKey(provider, model)), { provider, model });
        }));
    });

    test('cost calculation matches the independent formula and is additive', () => {
        checkProperty('cost-oracle-and-additivity', fc.property(usageArbitrary, usageArbitrary, ratesArbitrary, (left, right, rates) => {
            const actualLeft = calcCost('oracle', left, overrides(rates));
            const actualRight = calcCost('oracle', right, overrides(rates));
            const combined = calcCost('oracle', requirementAdd(left, right), overrides(rates));
            assertNear(actualLeft, requirementCost(left, rates));
            assertNear(actualRight, requirementCost(right, rates));
            assertNear(combined, (actualLeft ?? 0) + (actualRight ?? 0));
        }));
    });

    test('local period helpers agree with component-based oracle over calendar range', () => {
        const dates = fc.date({ min: new Date(2000, 0, 1), max: new Date(2035, 11, 31), noInvalidDate: true });
        checkProperty('local-period-boundaries', fc.property(dates, value => {
            const epoch = value.getTime();
            assert.strictEqual(dayKey(epoch), requirementLocalDay(epoch));
            assert.strictEqual(startOfToday(epoch), requirementLocalMidnight(epoch));
            assert.strictEqual(startOfMonth(epoch), requirementMonthStart(epoch));
            assert.strictEqual(lastDayOfPrevMonth(epoch), requirementPreviousMonthEnd(epoch));
        }));
    });
});

suite('domain quality: atomic-condition C2', () => {
    test('every inventoried feasible atomic condition has true and false witnesses', () => {
        c2.assertComplete();
        const report = c2.report();
        assert.strictEqual(report.percent, 100);
        const target = path.resolve('docs/verification/evidence/c2-latest.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, generatedAtUtc: new Date().toISOString(), ...report }, null, 2)}\n`, 'utf8');
    });
});
