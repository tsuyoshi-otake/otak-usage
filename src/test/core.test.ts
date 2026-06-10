import * as assert from 'assert';
import { addEvent, pruneDaysBefore, summarize } from '../aggregator';
import { formatCost, statusBarText } from '../formatter';
import { dayKey, lastDayOfPrevMonth, startOfMonth, startOfToday } from '../period';
import { calcCost, resolvePricing } from '../pricing';
import { DayBuckets, UsageEvent, emptyUsage } from '../types';

suite('period', () => {
    const noon = new Date(2026, 5, 10, 12, 34, 56).getTime(); // 2026-06-10 local

    test('dayKey uses local time', () => {
        assert.strictEqual(dayKey(noon), '2026-06-10');
    });

    test('startOfToday / startOfMonth', () => {
        assert.strictEqual(startOfToday(noon), new Date(2026, 5, 10).getTime());
        assert.strictEqual(startOfMonth(noon), new Date(2026, 5, 1).getTime());
    });

    test('lastDayOfPrevMonth handles month lengths', () => {
        assert.strictEqual(dayKey(lastDayOfPrevMonth(noon)), '2026-05-31');
        const march = new Date(2026, 2, 10).getTime();
        assert.strictEqual(dayKey(lastDayOfPrevMonth(march)), '2026-02-28');
    });
});

suite('pricing', () => {
    test('exact match', () => {
        const p = resolvePricing('gpt-5.5');
        assert.strictEqual(p?.input, 5);
        assert.strictEqual(p?.output, 30);
        assert.strictEqual(p?.cachedInput, 0.5);
    });

    test('longest prefix match wins', () => {
        // "claude-opus-4-8-20250915" matches both claude-opus-4 ($15) and claude-opus-4-8 ($5)
        const p = resolvePricing('claude-opus-4-8-20250915');
        assert.strictEqual(p?.input, 5);
        assert.strictEqual(p?.output, 25);
    });

    test('unknown model returns undefined', () => {
        assert.strictEqual(resolvePricing('llama-99'), undefined);
        assert.strictEqual(calcCost('llama-99', emptyUsage()), undefined);
    });

    test('partial override merges with defaults', () => {
        const p = resolvePricing('claude-haiku-4-5', { 'claude-haiku-4-5': { input: 7 } });
        assert.strictEqual(p?.input, 7);
        assert.strictEqual(p?.output, 5);
        assert.ok(Math.abs((p?.cacheRead ?? 0) - 0.7) < 1e-9);
    });

    test('override can define a brand-new model', () => {
        const p = resolvePricing('future-model-x', { 'future-model-x': { input: 1, output: 2 } });
        assert.strictEqual(p?.input, 1);
    });

    test('claude cost formula (5m write 1.25x, read 0.1x)', () => {
        const usage = { input: 100, cachedInput: 0, cacheRead: 1000, cacheWrite5m: 200, cacheWrite1h: 0, output: 50 };
        // haiku-4.5: $1 in / $5 out => 100*1 + 1000*0.1 + 200*1.25 + 50*5 = 700 µ$
        assert.ok(Math.abs((calcCost('claude-haiku-4-5', usage) ?? 0) - 700e-6) < 1e-12);
    });

    test('1h cache write priced at 2x input', () => {
        const usage = { input: 0, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000, output: 0 };
        assert.ok(Math.abs((calcCost('claude-haiku-4-5', usage) ?? 0) - 2) < 1e-9);
    });

    test('codex cost formula (cached input at cached price)', () => {
        const usage = { input: 1000, cachedInput: 9000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 };
        // gpt-5.5: 1000*5 + 9000*0.5 + 100*30 = 12500 µ$
        assert.ok(Math.abs((calcCost('gpt-5.5', usage) ?? 0) - 0.0125) < 1e-12);
    });
});

suite('aggregator', () => {
    function ev(day: number, model: string, output: number, provider: 'claude' | 'codex' = 'claude'): UsageEvent {
        return {
            provider,
            model,
            timestamp: new Date(2026, 5, day, 10).getTime(),
            usage: { ...emptyUsage(), output },
        };
    }

    test('events merge into day/model buckets and summarize splits today vs month', () => {
        const days: DayBuckets = {};
        addEvent(days, ev(9, 'claude-haiku-4-5', 1000));
        addEvent(days, ev(10, 'claude-haiku-4-5', 2000));
        addEvent(days, ev(10, 'claude-haiku-4-5', 3000));
        addEvent(days, ev(10, 'gpt-5.5', 1000, 'codex'));
        const s = summarize(days, '2026-06-10');
        // haiku $5/MTok output: today 5000 tok => $0.025, month 6000 tok => $0.03
        assert.ok(Math.abs(s.claude.todayCost - 0.025) < 1e-9);
        assert.ok(Math.abs(s.claude.monthCost - 0.03) < 1e-9);
        // gpt-5.5 $30/MTok output: 1000 tok => $0.03
        assert.ok(Math.abs(s.codex.todayCost - 0.03) < 1e-9);
        assert.strictEqual(s.claude.models.length, 1);
        assert.strictEqual(s.claude.hasUnknownModel, false);
    });

    test('unknown model counts $0 and sets flag', () => {
        const days: DayBuckets = {};
        addEvent(days, ev(10, 'mystery-model', 1_000_000));
        const s = summarize(days, '2026-06-10');
        assert.strictEqual(s.claude.monthCost, 0);
        assert.strictEqual(s.claude.hasUnknownModel, true);
        assert.strictEqual(s.claude.models[0].monthCost, undefined);
    });

    test('pruneDaysBefore removes only older days', () => {
        const days: DayBuckets = { '2026-05-31': {}, '2026-06-01': {}, '2026-06-10': {} };
        assert.strictEqual(pruneDaysBefore(days, '2026-06-01'), true);
        assert.deepStrictEqual(Object.keys(days).sort(), ['2026-06-01', '2026-06-10']);
        assert.strictEqual(pruneDaysBefore(days, '2026-06-01'), false);
    });
});

suite('formatter', () => {
    test('formatCost groups thousands', () => {
        assert.strictEqual(formatCost(12.345), '$12.35');
        assert.strictEqual(formatCost(1234.5), '$1,234.50');
    });

    test('status bar shows both providers and em-dash when unavailable', () => {
        const summary = (cost: number) => ({
            provider: 'claude' as const, todayCost: cost, monthCost: cost * 2, hasUnknownModel: false, models: [],
        });
        const text = statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: false, show: true },
            'today', false,
        );
        assert.strictEqual(text, '$(sparkle) $12.34  ⬡ —');
        const monthText = statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: false, show: false },
            'month', false,
        );
        assert.strictEqual(monthText, '$(sparkle) $24.68');
    });
});
