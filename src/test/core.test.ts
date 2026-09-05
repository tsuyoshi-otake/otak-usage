import * as assert from 'assert';
import { addEvent, pruneDaysBefore, summarize } from '../aggregator';
import { AlertMode, LimitAlertWindow, evaluateDailyAlert, evaluateLimitAlert, isSnoozed, isValidAlertSnooze, isValidLimitAlertState, normalizeAlertMode, normalizeDailyAlertThresholdUsd, normalizeLimitAlertThresholdPercent, sameLimitAlertState, snoozeUntilEndOfDay } from '../alert';
import { CLAUDE_OPTIMIZE_PRESETS, DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT, DEFAULT_CLAUDE_CONTEXT_WINDOW, SHIPPED_CLAUDE_CONTEXT_DEFAULTS, ClaudeOptimizeBackupV2, LegacyClaudeOptimizeBackup, adoptClaudeOptimizeBackupV2, applyClaudeOptimizeJson, captureClaudeOptimizeBackup, claudeAutoCompactTokenLimit, matchingClaudeOptimizePreset, normalizeClaudeAutoCompactPercent, normalizeClaudeTokenLimit, parseClaudeAutoCompactPercent, parseClaudeTokenLimit, planClaudeContextDefaultMigration, restoreClaudeOptimizeJson, restoreClaudeOptimizeV2Json, restoreLegacyClaudeOptimizeJson, upgradeLegacyClaudeOptimizeBackup } from '../claudeOptimize';
import { CODEX_AUTO_COMPACT_RATIO, CODEX_OPTIMIZE_PRESETS, DEFAULT_CODEX_AUTO_COMPACT_LIMIT, DEFAULT_CODEX_CONTEXT_WINDOW, SHIPPED_CODEX_CONTEXT_DEFAULTS, applyCodexOptimizeToml, matchingCodexOptimizePreset, normalizeCodexTokenLimit, parseCodexTokenLimit, planCodexContextDefaultMigration, removeCodexOptimizeToml, suggestedCodexAutoCompactLimit } from '../codexOptimize';
import { CODEX_DEFAULT_REASONING_EFFORTS, CODEX_ENABLED_REASONING_EFFORTS_KEY, CODEX_PERSISTED_ATOM_STATE_KEY, MementoLike, addCodexMaxReasoningEffort, syncCodexMaxReasoningEffort } from '../codexModelFeatures';
import { applyHookFeaturesJson, hasManagedHook } from '../hookFeatures';
import { RtkView, clipboardText, formatCost, formatTokenLimit, formatTokens, statusBarText, tooltipMarkdown } from '../formatter';
import { I18n, SUPPORTED_LOCALES, resolveSupportedLocale } from '../i18n';
import { dayKey, lastDayOfPrevMonth, startOfMonth, startOfToday } from '../period';
import { calcCost, resolvePricing } from '../pricing';
import { emptyRtkPeriod, parseRtkGain, rtkSavingsPct } from '../rtk';
import { ALL_TELEMETRY_METRICS, buildMetricsPayload, metricsUrl, TelemetryConfig, TelemetrySnapshot } from '../telemetry';
import { DayBuckets, TokenUsage, UsageEvent, emptyUsage } from '../types';

const noRtk: RtkView = { stats: undefined, show: true };

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

    test('legacy models resolve (dated ids included)', () => {
        assert.strictEqual(resolvePricing('claude-3-5-sonnet-20241022')?.input, 3);
        assert.strictEqual(resolvePricing('claude-3-haiku-20240307')?.input, 0.25);
        assert.strictEqual(resolvePricing('o4-mini')?.cachedInput, 0.275);
        assert.strictEqual(resolvePricing('codex-mini-latest')?.output, 6);
        assert.strictEqual(resolvePricing('gpt-4.1-mini')?.input, 0.4);
    });

    test('claude sonnet 5 resolves introductory and standard prices', () => {
        const intro = resolvePricing('claude-sonnet-5', undefined, '2026-08-31');
        assert.strictEqual(intro?.input, 2);
        assert.strictEqual(intro?.output, 10);
        assert.strictEqual(intro?.cacheWrite, 2.5);
        assert.strictEqual(intro?.cacheWrite1h, 4);
        assert.strictEqual(intro?.cacheRead, 0.2);

        const standard = resolvePricing('claude-sonnet-5-20260630', undefined, '2026-09-01');
        assert.strictEqual(standard?.input, 3);
        assert.strictEqual(standard?.output, 15);
        assert.strictEqual(standard?.cacheWrite, 3.75);
        assert.strictEqual(standard?.cacheWrite1h, 6);
        assert.ok(Math.abs((standard?.cacheRead ?? 0) - 0.3) < 1e-12);
    });

    test('claude fable 5.1 resolves published cache prices, variants and cost', () => {
        const p = resolvePricing('claude-fable-5-1');
        assert.strictEqual(p?.input, 10);
        assert.strictEqual(p?.output, 50);
        assert.strictEqual(p?.cacheWrite, 12.5);
        assert.strictEqual(p?.cacheWrite1h, 20);
        assert.strictEqual(p?.cacheRead, 0.25);
        assert.strictEqual(p?.longContextThreshold, undefined);
        assert.strictEqual(resolvePricing('claude-fable-5-1-20260901')?.cacheRead, 0.25);
        assert.strictEqual(resolvePricing('claude-fable-5')?.cacheRead, 1);

        const usage = {
            ...emptyUsage(),
            input: 1_000_000,
            output: 1_000_000,
            cacheRead: 1_000_000,
            cacheWrite5m: 1_000_000,
            cacheWrite1h: 1_000_000,
        };
        assert.strictEqual(calcCost('claude-fable-5-1', usage), 92.75);
    });

    test('claude opus 5 resolves standard, variant and fast-mode prices', () => {
        const p = resolvePricing('claude-opus-5');
        assert.strictEqual(p?.input, 5);
        assert.strictEqual(p?.output, 25);
        assert.strictEqual(p?.cacheWrite, 6.25);
        assert.strictEqual(p?.cacheWrite1h, 10);
        assert.strictEqual(p?.cacheRead, 0.5);
        // The full 1M context window is billed at standard rates.
        assert.strictEqual(p?.longContextThreshold, undefined);
        // Dated ids and the 1M-context variant resolve to the same entry, and
        // never to the older (pricier) claude-opus-4 line.
        assert.strictEqual(resolvePricing('claude-opus-5-20260724')?.input, 5);
        assert.strictEqual(resolvePricing('claude-opus-5[1m]')?.output, 25);

        const fast = resolvePricing('claude-opus-5-fast');
        assert.strictEqual(fast?.input, 10);
        assert.strictEqual(fast?.output, 50);
        assert.strictEqual(fast?.cacheWrite, 12.5);
        assert.strictEqual(fast?.cacheRead, 1);
        assert.strictEqual(resolvePricing('claude-opus-5-20260724-fast')?.input, 10);
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

    test('fast mode premium prices, cache multipliers stack on fast input', () => {
        const p = resolvePricing('claude-opus-4-7-fast');
        assert.strictEqual(p?.input, 30);
        assert.strictEqual(p?.output, 150);
        assert.strictEqual(p?.cacheWrite, 37.5);
        assert.strictEqual(p?.cacheWrite1h, 60);
        assert.strictEqual(p?.cacheRead, 3);
        assert.strictEqual(resolvePricing('claude-opus-4-8-fast')?.input, 10);
        // The plain model keeps standard prices.
        assert.strictEqual(resolvePricing('claude-opus-4-7')?.input, 5);
    });

    test('dated fast ids resolve to the -fast entry, not the base prefix', () => {
        assert.strictEqual(resolvePricing('claude-opus-4-7-20260120-fast')?.input, 30);
        assert.strictEqual(resolvePricing('claude-opus-4-6-20260101-fast')?.output, 150);
    });

    test('gpt-6-astra resolves official Standard and long-context prices', () => {
        const p = resolvePricing('gpt-6-astra');
        assert.strictEqual(p?.input, 10);
        assert.strictEqual(p?.cachedInput, 1);
        assert.strictEqual(p?.output, 50);
        assert.strictEqual(p?.cacheWrite, 12.5);
        assert.strictEqual(p?.longContextThreshold, 272_000);
        assert.strictEqual(p?.longContextInputMultiplier, 2);
        assert.strictEqual(p?.longContextOutputMultiplier, 1.5);
        // Dated snapshots share the explicit Astra entry.
        assert.strictEqual(resolvePricing('gpt-6-astra-20260903')?.input, 10);
        // Official docs list only gpt-6-astra — do not invent a gpt-6 alias.
        assert.strictEqual(resolvePricing('gpt-6'), undefined);

        const usage = { ...emptyUsage(), input: 100_000, cachedInput: 200_000, output: 100_000 };
        // 0.1*$10 + 0.2*$1 + 0.1*$50 = $6.20
        assert.ok(Math.abs((calcCost('gpt-6-astra', usage) ?? 0) - 6.2) < 1e-12);

        const longUsage = {
            ...usage,
            longContextInput: usage.input,
            longContextCachedInput: usage.cachedInput,
            longContextOutput: usage.output,
        };
        // 2x input/cache, 1.5x output: $2 + $0.40 + $7.50 = $9.90
        assert.ok(Math.abs((calcCost('gpt-6-astra', longUsage) ?? 0) - 9.9) < 1e-12);
    });

    test('gpt-5.4 family resolves per official prices', () => {
        assert.strictEqual(resolvePricing('gpt-5.4-pro')?.input, 30);
        assert.strictEqual(resolvePricing('gpt-5.4-pro')?.output, 180);
        assert.strictEqual(resolvePricing('gpt-5.4-mini')?.input, 0.75);
        assert.strictEqual(resolvePricing('gpt-5.4-mini')?.cachedInput, 0.075);
        assert.strictEqual(resolvePricing('gpt-5.4-nano')?.output, 1.25);
        assert.strictEqual(resolvePricing('gpt-5.4')?.input, 2.5);
    });

    test('gpt-5.6 family and alias resolve per official prices', () => {
        const alias = resolvePricing('gpt-5.6');
        assert.strictEqual(alias?.input, 5);
        assert.strictEqual(alias?.cachedInput, 0.5);
        assert.strictEqual(alias?.output, 30);
        assert.strictEqual(alias?.longContextThreshold, 272_000);
        assert.strictEqual(resolvePricing('gpt-5.6-sol')?.output, 30);
        assert.strictEqual(resolvePricing('gpt-5.6-terra')?.input, 2.5);
        assert.strictEqual(resolvePricing('gpt-5.6-terra-20260710')?.cachedInput, 0.25);
        assert.strictEqual(resolvePricing('gpt-5.6-luna')?.output, 6);
    });

    test('gpt-5.6 terra and luna resolve launch and post-cut prices', () => {
        const terraLaunch = resolvePricing('gpt-5.6-terra', undefined, '2026-07-29');
        assert.strictEqual(terraLaunch?.input, 2.5);
        assert.strictEqual(terraLaunch?.cachedInput, 0.25);
        assert.strictEqual(terraLaunch?.output, 15);

        const terraCut = resolvePricing('gpt-5.6-terra-20260710', undefined, '2026-07-30');
        assert.strictEqual(terraCut?.input, 2);
        assert.strictEqual(terraCut?.cachedInput, 0.2);
        assert.strictEqual(terraCut?.output, 12);
        assert.strictEqual(terraCut?.longContextThreshold, 272_000);

        const lunaLaunch = resolvePricing('gpt-5.6-luna', undefined, '2026-07-29');
        assert.strictEqual(lunaLaunch?.input, 1);
        assert.strictEqual(lunaLaunch?.cachedInput, 0.1);
        assert.strictEqual(lunaLaunch?.output, 6);

        const lunaCut = resolvePricing('gpt-5.6-luna', undefined, '2026-07-30');
        assert.strictEqual(lunaCut?.input, 0.2);
        assert.strictEqual(lunaCut?.cachedInput, 0.02);
        assert.strictEqual(lunaCut?.output, 1.2);

        // Sol and the unsuffixed alias were not part of the cut.
        assert.strictEqual(resolvePricing('gpt-5.6-sol', undefined, '2026-07-30')?.output, 30);
        assert.strictEqual(resolvePricing('gpt-5.6', undefined, '2026-07-30')?.input, 5);
    });

    test('gpt-5.6 sol and its alias resolve launch and post-2026-08-21 prices', () => {
        for (const model of ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-sol-20260710']) {
            const launch = resolvePricing(model, undefined, '2026-08-20');
            assert.strictEqual(launch?.input, 5, model);
            assert.strictEqual(launch?.cachedInput, 0.5, model);
            assert.strictEqual(launch?.output, 30, model);

            const cut = resolvePricing(model, undefined, '2026-08-21');
            assert.strictEqual(cut?.input, 4, model);
            assert.strictEqual(cut?.cachedInput, 0.4, model);
            assert.strictEqual(cut?.output, 20, model);
            // The long-context premium is untouched by the cut.
            assert.strictEqual(cut?.longContextThreshold, 272_000, model);
            assert.strictEqual(cut?.longContextInputMultiplier, 2, model);
            assert.strictEqual(cut?.longContextOutputMultiplier, 1.5, model);
        }

        // Terra and Luna keep their 2026-07-30 prices across Sol's cut.
        assert.strictEqual(resolvePricing('gpt-5.6-terra', undefined, '2026-08-21')?.output, 12);
        assert.strictEqual(resolvePricing('gpt-5.6-luna', undefined, '2026-08-21')?.output, 1.2);
    });

    test('gpt-5.6 sol costs a day at the price in force on it', () => {
        const usage = { ...emptyUsage(), input: 100_000, cachedInput: 200_000, output: 100_000 };
        // Launch: 0.1*$5 + 0.2*$0.5 + 0.1*$30 = $3.60.
        assert.ok(Math.abs((calcCost('gpt-5.6-sol', usage, undefined, '2026-08-20') ?? 0) - 3.6) < 1e-12);
        // From 2026-08-21: 0.1*$4 + 0.2*$0.4 + 0.1*$20 = $2.48.
        assert.ok(Math.abs((calcCost('gpt-5.6-sol', usage, undefined, '2026-08-21') ?? 0) - 2.48) < 1e-12);

        const longUsage = {
            ...usage,
            longContextInput: usage.input,
            longContextCachedInput: usage.cachedInput,
            longContextOutput: usage.output,
        };
        // Above 272K: input and cached input 2x, output 1.5x -> $0.8 + $0.16 + $3 = $3.96.
        assert.ok(Math.abs((calcCost('gpt-5.6-sol', longUsage, undefined, '2026-08-21') ?? 0) - 3.96) < 1e-12);
    });

    test('gpt-5.6 long-context premium applies to the full request', () => {
        const usage = { ...emptyUsage(), input: 100_000, cachedInput: 200_000, output: 100_000 };
        assert.ok(Math.abs((calcCost('gpt-5.6-sol', usage) ?? 0) - 3.6) < 1e-12);

        const longUsage = {
            ...usage,
            longContextInput: usage.input,
            longContextCachedInput: usage.cachedInput,
            longContextOutput: usage.output,
        };
        // Input and cached input are 2x; output is 1.5x: $1 + $0.2 + $4.5 = $5.7.
        assert.ok(Math.abs((calcCost('gpt-5.6-sol', longUsage) ?? 0) - 5.7) < 1e-12);
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

    test('pricing uses the aggregation day for scheduled model prices', () => {
        const days: DayBuckets = {};
        addEvent(days, { ...ev(2, 'claude-sonnet-5', 1_000_000), timestamp: new Date(2026, 8, 2, 10).getTime() });
        const s = summarize(days, '2026-09-02');
        assert.strictEqual(s.claude.monthCost, 15);
        assert.strictEqual(s.claude.hasUnknownModel, false);
    });

    test('a mid-month price cut leaves the days before it at the old price', () => {
        const days: DayBuckets = {};
        const usage = { ...emptyUsage(), output: 1_000_000 };
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-luna', timestamp: new Date(2026, 6, 29, 10).getTime(), usage });
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-luna', timestamp: new Date(2026, 6, 31, 10).getTime(), usage });
        const s = summarize(days, '2026-07-31');
        // 2026-07-29 still bills at $6/M output, 2026-07-31 at the cut $1.20/M.
        assert.ok(Math.abs(s.codex.monthCost - 7.2) < 1e-12);
        assert.ok(Math.abs(s.codex.todayCost - 1.2) < 1e-12);
    });

    test('gpt-5.6 long-context premium survives daily and monthly aggregation', () => {
        const days: DayBuckets = {};
        const usage = {
            ...emptyUsage(),
            input: 100_000,
            cachedInput: 200_000,
            output: 100_000,
            longContextInput: 100_000,
            longContextCachedInput: 200_000,
            longContextOutput: 100_000,
        };
        addEvent(days, { provider: 'codex', model: 'gpt-5.6-sol', timestamp: new Date(2026, 6, 10, 10).getTime(), usage });
        const s = summarize(days, '2026-07-10');
        assert.ok(Math.abs(s.codex.todayCost - 5.7) < 1e-12);
        assert.ok(Math.abs(s.codex.monthCost - 5.7) < 1e-12);
        assert.strictEqual(s.codex.models[0].todayUsage.longContextCachedInput, 200_000);
    });

    test('model breakdowns are newest-first with unknown models last', () => {
        const days: DayBuckets = {};
        addEvent(days, ev(10, 'gpt-5.4', 1_000_000, 'codex'));
        addEvent(days, ev(10, 'gpt-6-astra', 1, 'codex'));
        addEvent(days, ev(10, 'gpt-5.6-sol-20260710', 1, 'codex'));
        addEvent(days, ev(10, 'gpt-5.5', 1_000, 'codex'));
        addEvent(days, ev(10, 'z-future-model', 10_000_000, 'codex'));
        addEvent(days, ev(10, 'a-future-model', 10_000_000, 'codex'));

        addEvent(days, ev(10, 'claude-haiku-4-5', 1_000_000));
        addEvent(days, ev(10, 'claude-fable-5', 1));
        addEvent(days, ev(10, 'claude-fable-5-1', 1));
        addEvent(days, ev(10, 'claude-opus-4-8', 1_000));
        addEvent(days, ev(10, 'claude-opus-5', 1_000));

        const s = summarize(days, '2026-07-10');
        assert.deepStrictEqual(s.codex.models.map((row) => row.model), [
            'gpt-6-astra',
            'gpt-5.6-sol-20260710',
            'gpt-5.5',
            'gpt-5.4',
            'a-future-model',
            'z-future-model',
        ]);
        assert.deepStrictEqual(s.claude.models.map((row) => row.model), [
            'claude-fable-5-1',
            'claude-fable-5',
            'claude-opus-5',
            'claude-opus-4-8',
            'claude-haiku-4-5',
        ]);
    });

    test('pruneDaysBefore removes only older days', () => {
        const days: DayBuckets = { '2026-05-31': {}, '2026-06-01': {}, '2026-06-10': {} };
        assert.strictEqual(pruneDaysBefore(days, '2026-06-01'), true);
        assert.deepStrictEqual(Object.keys(days).sort(), ['2026-06-01', '2026-06-10']);
        assert.strictEqual(pruneDaysBefore(days, '2026-06-01'), false);
    });
});

suite('daily alert', () => {
    test('normalizes threshold values', () => {
        assert.strictEqual(normalizeDailyAlertThresholdUsd(undefined), 10);
        assert.strictEqual(normalizeDailyAlertThresholdUsd(Number.NaN), 10);
        assert.strictEqual(normalizeDailyAlertThresholdUsd(-5), 0);
        assert.strictEqual(normalizeDailyAlertThresholdUsd(12.5), 12.5);
    });

    test('notifies when the daily total reaches the threshold', () => {
        const decision = evaluateDailyAlert(10, 10, '2026-06-10', undefined);
        assert.strictEqual(decision.shouldNotify, true);
        assert.deepStrictEqual(decision.nextState, { day: '2026-06-10', thresholdUsd: 10, costUsd: 10 });
    });

    test('suppresses repeats for the same day and lower thresholds', () => {
        const state = { day: '2026-06-10', thresholdUsd: 10, costUsd: 11 };
        assert.strictEqual(evaluateDailyAlert(15, 10, '2026-06-10', state).shouldNotify, false);
        assert.strictEqual(evaluateDailyAlert(15, 5, '2026-06-10', state).shouldNotify, false);
    });

    test('allows a higher threshold alert and resets on a new day', () => {
        const state = { day: '2026-06-10', thresholdUsd: 10, costUsd: 11 };
        const higher = evaluateDailyAlert(21, 20, '2026-06-10', state);
        assert.strictEqual(higher.shouldNotify, true);
        assert.deepStrictEqual(higher.nextState, { day: '2026-06-10', thresholdUsd: 20, costUsd: 21 });

        const nextDay = evaluateDailyAlert(10, 10, '2026-06-11', state);
        assert.strictEqual(nextDay.shouldNotify, true);
        assert.deepStrictEqual(nextDay.nextState, { day: '2026-06-11', thresholdUsd: 10, costUsd: 10 });
    });

    test('threshold zero disables notifications', () => {
        const decision = evaluateDailyAlert(100, 0, '2026-06-10', undefined);
        assert.strictEqual(decision.shouldNotify, false);
        assert.strictEqual(decision.nextState, undefined);
    });
});

suite('alert mode', () => {
    test('normalizes the alert mode with a "both" fallback', () => {
        for (const mode of ['off', 'cost', 'limit', 'both'] as AlertMode[]) {
            assert.strictEqual(normalizeAlertMode(mode), mode);
        }
        assert.strictEqual(normalizeAlertMode(undefined), 'both');
        assert.strictEqual(normalizeAlertMode('nonsense'), 'both');
    });

    test('clamps the limit alert threshold percent to 0-100', () => {
        assert.strictEqual(normalizeLimitAlertThresholdPercent(undefined), 80);
        assert.strictEqual(normalizeLimitAlertThresholdPercent(Number.NaN), 80);
        assert.strictEqual(normalizeLimitAlertThresholdPercent(-5), 0);
        assert.strictEqual(normalizeLimitAlertThresholdPercent(150), 100);
        assert.strictEqual(normalizeLimitAlertThresholdPercent(72), 72);
    });
});

suite('limit alert', () => {
    const win = (over: Partial<LimitAlertWindow> = {}): LimitAlertWindow => ({
        id: 'claude:primary', provider: 'Claude', window: '5h', usedPercent: 90, resetsAtMs: 1000, ...over,
    });

    test('notifies once when a window reaches the threshold', () => {
        const decision = evaluateLimitAlert([win({ usedPercent: 82 })], 80, undefined);
        assert.strictEqual(decision.triggered.length, 1);
        assert.strictEqual(decision.triggered[0].id, 'claude:primary');
        assert.deepStrictEqual(decision.nextState.notified['claude:primary'], { resetsAtMs: 1000, thresholdPercent: 80 });

        // Same window instance climbing further does not re-notify.
        const again = evaluateLimitAlert([win({ usedPercent: 95 })], 80, decision.nextState);
        assert.strictEqual(again.triggered.length, 0);
    });

    test('does not notify below the threshold', () => {
        const decision = evaluateLimitAlert([win({ usedPercent: 79 })], 80, undefined);
        assert.strictEqual(decision.triggered.length, 0);
        assert.deepStrictEqual(decision.nextState.notified, {});
    });

    test('re-arms when the window resets to a new instance', () => {
        const first = evaluateLimitAlert([win({ usedPercent: 90 })], 80, undefined);
        assert.strictEqual(first.triggered.length, 1);
        const nextInstance = evaluateLimitAlert([win({ usedPercent: 90, resetsAtMs: 2000 })], 80, first.nextState);
        assert.strictEqual(nextInstance.triggered.length, 1);
        assert.strictEqual(nextInstance.nextState.notified['claude:primary'].resetsAtMs, 2000);
    });

    test('re-notifies when the threshold is raised above the level already sent', () => {
        const first = evaluateLimitAlert([win({ usedPercent: 96 })], 80, undefined);
        assert.strictEqual(first.triggered.length, 1);
        // Lowered threshold: already covered by the 80% alert, stays silent.
        const lower = evaluateLimitAlert([win({ usedPercent: 96 })], 70, first.nextState);
        assert.strictEqual(lower.triggered.length, 0);
        assert.strictEqual(lower.nextState.notified['claude:primary'].thresholdPercent, 80);
        // Raised threshold and still crossed: a more severe alert fires again.
        const higher = evaluateLimitAlert([win({ usedPercent: 96 })], 95, first.nextState);
        assert.strictEqual(higher.triggered.length, 1);
        assert.strictEqual(higher.nextState.notified['claude:primary'].thresholdPercent, 95);
    });

    test('threshold zero disables limit notifications', () => {
        const decision = evaluateLimitAlert([win({ usedPercent: 100 })], 0, undefined);
        assert.strictEqual(decision.triggered.length, 0);
        assert.deepStrictEqual(decision.nextState.notified, {});
    });

    test('drops state for windows no longer present', () => {
        const first = evaluateLimitAlert([win({ usedPercent: 90 })], 80, undefined);
        const gone = evaluateLimitAlert([], 80, first.nextState);
        assert.deepStrictEqual(gone.nextState.notified, {});
    });

    test('evaluates each provider window independently', () => {
        const windows = [
            win({ id: 'claude:primary', usedPercent: 85 }),
            win({ id: 'codex:secondary', provider: 'Codex', window: '7d', usedPercent: 50, resetsAtMs: 3000 }),
        ];
        const decision = evaluateLimitAlert(windows, 80, undefined);
        assert.deepStrictEqual(decision.triggered.map((w) => w.id), ['claude:primary']);
    });

    test('state validation and equality', () => {
        assert.strictEqual(isValidLimitAlertState({ notified: {} }), true);
        assert.strictEqual(isValidLimitAlertState({ notified: { 'claude:primary': { resetsAtMs: null, thresholdPercent: 80 } } }), true);
        assert.strictEqual(isValidLimitAlertState({ notified: { x: { resetsAtMs: 'no', thresholdPercent: 80 } } }), false);
        assert.strictEqual(isValidLimitAlertState(undefined), false);
        assert.strictEqual(isValidLimitAlertState({}), false);

        const a = { notified: { 'claude:primary': { resetsAtMs: 1000, thresholdPercent: 80 } } };
        const b = { notified: { 'claude:primary': { resetsAtMs: 1000, thresholdPercent: 80 } } };
        assert.strictEqual(sameLimitAlertState(a, b), true);
        assert.strictEqual(sameLimitAlertState(a, { notified: {} }), false);
        assert.strictEqual(sameLimitAlertState(undefined, undefined), true);
    });
});

suite('alert snooze', () => {
    test('"not today" runs until the next local midnight', () => {
        const now = new Date(2026, 6, 26, 14, 30, 15, 250).getTime();
        const until = new Date(snoozeUntilEndOfDay(now));
        assert.strictEqual(until.getDate(), 27);
        assert.strictEqual(until.getHours(), 0);
        assert.strictEqual(until.getMinutes(), 0);
        assert.strictEqual(until.getSeconds(), 0);
        assert.strictEqual(until.getMilliseconds(), 0);
        assert.ok(until.getTime() > now);
    });

    test('a snooze set a minute before midnight still ends that same midnight', () => {
        const now = new Date(2026, 6, 26, 23, 59, 0).getTime();
        const until = snoozeUntilEndOfDay(now);
        assert.strictEqual(until - now, 60_000);
    });

    test('silences until the deadline and not a moment past it', () => {
        assert.strictEqual(isSnoozed({ untilMs: 2000 }, 1999), true);
        assert.strictEqual(isSnoozed({ untilMs: 2000 }, 2000), false);
        assert.strictEqual(isSnoozed({ untilMs: 2000 }, 2001), false);
        assert.strictEqual(isSnoozed(undefined, 1999), false);
    });

    test('rejects an unusable deadline rather than silencing forever', () => {
        assert.strictEqual(isValidAlertSnooze({ untilMs: 1000 }), true);
        assert.strictEqual(isValidAlertSnooze({ untilMs: Number.NaN }), false);
        assert.strictEqual(isValidAlertSnooze({ untilMs: '1000' }), false);
        assert.strictEqual(isValidAlertSnooze({}), false);
        assert.strictEqual(isValidAlertSnooze(undefined), false);
    });
});

suite('codex optimize', () => {
    const values = { contextWindow: 250000, autoCompactLimit: 230000 };

    test('normalizes token limits to positive integers', () => {
        assert.strictEqual(normalizeCodexTokenLimit(undefined, 272000), 272000);
        assert.strictEqual(normalizeCodexTokenLimit(0, 272000), 272000);
        assert.strictEqual(normalizeCodexTokenLimit(-5, 272000), 272000);
        assert.strictEqual(normalizeCodexTokenLimit(Number.NaN, 272000), 272000);
        assert.strictEqual(normalizeCodexTokenLimit(300500.9, 272000), 300500);
    });

    test('offers stable 250k and 272k preset pairs, default first', () => {
        assert.deepStrictEqual(CODEX_OPTIMIZE_PRESETS, [
            { id: '250k', contextWindow: 250000, autoCompactLimit: 212500 },
            { id: '272k', contextWindow: 272000, autoCompactLimit: 231200 },
        ]);
        assert.strictEqual(DEFAULT_CODEX_CONTEXT_WINDOW, 250000);
        assert.strictEqual(DEFAULT_CODEX_AUTO_COMPACT_LIMIT, 212500);
        assert.strictEqual(matchingCodexOptimizePreset(250000, 212500)?.id, '250k');
        assert.strictEqual(matchingCodexOptimizePreset(250000, 180000), undefined);
        assert.strictEqual(suggestedCodexAutoCompactLimit(250000), 212500);
    });

    test('compacts every preset at the shared 85% of its window', () => {
        assert.strictEqual(CODEX_AUTO_COMPACT_RATIO, 0.85);
        // Both providers compact at the same share of their window.
        assert.strictEqual(DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT / 100, CODEX_AUTO_COMPACT_RATIO);
        for (const preset of CODEX_OPTIMIZE_PRESETS) {
            assert.strictEqual(
                preset.autoCompactLimit,
                suggestedCodexAutoCompactLimit(preset.contextWindow),
                `${preset.id} must follow the shared compact ratio`,
            );
        }
        // A custom window gets the same treatment, rounded down to an integer.
        assert.strictEqual(suggestedCodexAutoCompactLimit(400000), 340000);
        assert.strictEqual(suggestedCodexAutoCompactLimit(1), 1);
    });

    suite('shipped-default migration', () => {
        test('covers every default this extension has shipped, oldest first', () => {
            assert.deepStrictEqual(SHIPPED_CODEX_CONTEXT_DEFAULTS, [
                { contextWindow: 250000, autoCompactLimit: 230000 },
                { contextWindow: 272000, autoCompactLimit: 250000 },
                { contextWindow: 200000, autoCompactLimit: 184000 },
                { contextWindow: 230000, autoCompactLimit: 195500 },
                { contextWindow: 240000, autoCompactLimit: 216000 },
            ]);
        });

        test('clears any pair this extension once shipped as its default', () => {
            for (const shipped of SHIPPED_CODEX_CONTEXT_DEFAULTS) {
                assert.deepStrictEqual(
                    planCodexContextDefaultMigration(shipped.contextWindow, shipped.autoCompactLimit),
                    { clear: ['codexContextWindow', 'codexAutoCompactLimit'], write: {} },
                    shipped.contextWindow + ' / ' + shipped.autoCompactLimit + ' must migrate',
                );
            }
        });

        test('leaves every pair the current picker offers untouched', () => {
            for (const preset of CODEX_OPTIMIZE_PRESETS) {
                assert.deepStrictEqual(
                    planCodexContextDefaultMigration(preset.contextWindow, preset.autoCompactLimit),
                    { clear: [], write: {} },
                    preset.id + ' must survive the migration',
                );
            }
        });

        test('writes nothing when neither value was ever set', () => {
            assert.deepStrictEqual(planCodexContextDefaultMigration(undefined, undefined), {
                clear: [],
                write: {},
            });
        });

        test('clears a half-written pair whose other half was the previous default', () => {
            assert.deepStrictEqual(planCodexContextDefaultMigration(240000, undefined), {
                clear: ['codexContextWindow'],
                write: {},
            });
            assert.deepStrictEqual(planCodexContextDefaultMigration(undefined, 216000), {
                clear: ['codexAutoCompactLimit'],
                write: {},
            });
        });

        test('leaves chosen values alone and pins the unset half to the previous default', () => {
            assert.deepStrictEqual(planCodexContextDefaultMigration(400000, undefined), {
                clear: [],
                write: { codexAutoCompactLimit: 216000 },
            });
            assert.deepStrictEqual(planCodexContextDefaultMigration(undefined, 120000), {
                clear: [],
                write: { codexContextWindow: 240000 },
            });
            assert.deepStrictEqual(planCodexContextDefaultMigration(400000, 380000), {
                clear: [],
                write: {},
            });
        });

        test('treats an unusable stored value as the previous default and clears it', () => {
            assert.deepStrictEqual(planCodexContextDefaultMigration(0, 216000), {
                clear: ['codexContextWindow', 'codexAutoCompactLimit'],
                write: {},
            });
        });
    });

    test('parses custom token limits without accepting partial or unsafe values', () => {
        assert.strictEqual(parseCodexTokenLimit('272,000'), 272000);
        assert.strictEqual(parseCodexTokenLimit('200_000'), 200000);
        assert.strictEqual(parseCodexTokenLimit('12.5k'), undefined);
        assert.strictEqual(parseCodexTokenLimit('0'), undefined);
        assert.strictEqual(parseCodexTokenLimit('-1'), undefined);
    });

    test('rewrites existing keys in place and preserves the rest of the file', () => {
        const input = [
            'model = "gpt-5.6-sol"',
            '# comment above the context window',
            'model_context_window = 320000',
            'model_auto_compact_token_limit = 300000',
            'model_reasoning_effort = "medium"',
            '',
            '[features]',
            'fast_mode = true',
        ].join('\n');
        const out = applyCodexOptimizeToml(input, values);
        assert.ok(out.includes('model_context_window = 250000'));
        assert.ok(out.includes('model_auto_compact_token_limit = 230000'));
        assert.ok(!out.includes('320000'));
        assert.ok(!out.includes('300000'));
        // Untouched lines and ordering are preserved.
        assert.ok(out.includes('# comment above the context window'));
        assert.ok(out.includes('model = "gpt-5.6-sol"'));
        assert.ok(out.includes('[features]\nfast_mode = true'));
        // No duplicate keys were introduced.
        assert.strictEqual(out.match(/^model_context_window\s*=/gm)?.length, 1);
    });

    test('inserts the keys when the file lacks them', () => {
        const input = 'model = "gpt-5.6-sol"\n\n[features]\nfast_mode = true\n';
        const out = applyCodexOptimizeToml(input, values);
        assert.ok(out.startsWith('model_context_window = 250000\nmodel_auto_compact_token_limit = 230000\n'));
        assert.ok(out.includes('[features]'));
    });

    test('does not touch keys that live inside a table section', () => {
        const input = [
            'model = "x"',
            '',
            '[some_table]',
            'model_context_window = 999',
        ].join('\n');
        const out = applyCodexOptimizeToml(input, values);
        // The table value is left alone; the managed keys are inserted in the preamble.
        assert.ok(out.includes('[some_table]\nmodel_context_window = 999'));
        assert.ok(out.startsWith('model_context_window = 250000\n'));
    });

    test('creates a config body from empty text', () => {
        const out = applyCodexOptimizeToml('', values);
        assert.ok(out.includes('model_context_window = 250000'));
        assert.ok(out.includes('model_auto_compact_token_limit = 230000'));
    });

    test('pins Astra experimental context management after [features]', () => {
        const input = [
            'model = "gpt-5.6-sol"',
            '',
            '[features]',
            'fast_mode = true',
            '',
            '[marketplaces.openai-bundled]',
            'source_type = "local"',
        ].join('\n');
        const out = applyCodexOptimizeToml(input, values);
        const featuresAt = out.indexOf('[features]\nfast_mode = true');
        const contextAt = out.indexOf('[features.context_management]\nexperimental_mode = true');
        const marketAt = out.indexOf('[marketplaces.openai-bundled]');
        assert.ok(featuresAt >= 0 && contextAt > featuresAt && marketAt > contextAt);
        assert.strictEqual(out.match(/^\[features\.context_management\]/gm)?.length, 1);
        assert.strictEqual(out.match(/^\s*experimental_mode\s*=/gm)?.length, 1);
    });

    test('rewrites an existing experimental_mode flag in place without duplicating the table', () => {
        const input = [
            '[features.context_management]',
            'experimental_mode = false',
            'other = 1',
        ].join('\n');
        const out = applyCodexOptimizeToml(input, values);
        assert.ok(out.includes('[features.context_management]\nexperimental_mode = true\nother = 1'));
        assert.ok(!out.includes('experimental_mode = false'));
        assert.strictEqual(out.match(/^\[features\.context_management\]/gm)?.length, 1);
    });

    test('rewrites the dotted features.context_management.experimental_mode form', () => {
        const input = 'features.context_management.experimental_mode = false\nmodel = "x"\n';
        const out = applyCodexOptimizeToml(input, values);
        assert.ok(out.includes('features.context_management.experimental_mode = true'));
        assert.ok(!out.includes('experimental_mode = false'));
        assert.ok(!out.includes('[features.context_management]'));
    });

    test('remove strips exactly the two managed keys and nothing else', () => {
        const input = [
            'model = "gpt-5.6-sol"',
            'model_context_window = 272000',
            'model_auto_compact_token_limit = 240000',
            'model_reasoning_effort = "medium"',
            '[features]',
            'fast_mode = true',
        ].join('\n');
        const out = removeCodexOptimizeToml(input);
        assert.ok(!out.includes('model_context_window'));
        assert.ok(!out.includes('model_auto_compact_token_limit'));
        assert.ok(out.includes('model = "gpt-5.6-sol"'));
        assert.ok(out.includes('model_reasoning_effort = "medium"'));
        assert.ok(out.includes('[features]'));
        assert.ok(!out.includes('experimental_mode'));
        assert.ok(!out.includes('[features.context_management]'));
    });

    test('remove keeps unrelated keys in [features.context_management]', () => {
        const input = [
            '[features.context_management]',
            'experimental_mode = true',
            'other = 1',
        ].join('\n');
        const out = removeCodexOptimizeToml(input);
        assert.ok(!out.includes('experimental_mode'));
        assert.ok(out.includes('[features.context_management]'));
        assert.ok(out.includes('other = 1'));
    });

    test('apply then remove is a clean round-trip for inserted keys', () => {
        const original = 'model = "x"\nmodel_reasoning_effort = "high"\n\n[features]\nfast_mode = true\n';
        const applied = applyCodexOptimizeToml(original, values);
        const removed = removeCodexOptimizeToml(applied);
        assert.strictEqual(removed, original);
    });

    test('preserves CRLF line endings', () => {
        const input = 'model = "x"\r\nmodel_context_window = 320000\r\n';
        const out = applyCodexOptimizeToml(input, values);
        assert.ok(out.includes('\r\n'));
        assert.ok(!out.includes('320000'));
        assert.ok(out.includes('model_context_window = 250000'));
    });
});

suite('codex model features', () => {
    class FakeMemento implements MementoLike {
        readonly whenReady = Promise.resolve();

        constructor(
            readonly description: { identifier: { value: string }; version: string },
            readonly _storage: { state: Record<string, unknown> },
        ) { }

        get<T>(key: string): T | undefined {
            return this._storage.state[key] as T | undefined;
        }

        update(key: string, value: unknown): Thenable<void> {
            this._storage.state[key] = value;
            return Promise.resolve();
        }

        dispose(): void { }
    }

    function fakeSource(state: unknown): { source: FakeMemento; storage: { state: Record<string, unknown> } } {
        const storage = { state: { [CODEX_PERSISTED_ATOM_STATE_KEY]: state } };
        const source = new FakeMemento({
            identifier: { value: 'odangoo.otak-usage' },
            version: '1.0.0',
        }, storage);
        return { source, storage };
    }

    test('appends only Max and preserves existing reasoning choices', () => {
        const current = {
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['minimal', 'high'],
            unrelated: true,
        };
        const result = addCodexMaxReasoningEffort(current);
        assert.deepStrictEqual(result.state, {
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['minimal', 'high', 'max'],
            unrelated: true,
        });
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.supported, true);
        assert.deepStrictEqual(current[CODEX_ENABLED_REASONING_EFFORTS_KEY], ['minimal', 'high']);
    });

    test('uses Codex defaults when the persisted effort list is missing', () => {
        const result = addCodexMaxReasoningEffort({ unrelated: 'keep' });
        assert.deepStrictEqual(result.state, {
            unrelated: 'keep',
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: [...CODEX_DEFAULT_REASONING_EFFORTS, 'max'],
        });
    });

    test('is idempotent when Max is already enabled', () => {
        const current = { [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['low', 'max'] };
        const result = addCodexMaxReasoningEffort(current);
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.supported, true);
        assert.strictEqual(result.state, current);
    });

    test('fails closed for malformed persisted state', () => {
        const result = addCodexMaxReasoningEffort({
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['low', 42],
        });
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.supported, false);
    });

    test('fails closed when the VS Code memento bridge is unavailable', async () => {
        const source: MementoLike = {
            get: () => undefined,
            update: () => Promise.resolve(),
        };
        assert.strictEqual(await syncCodexMaxReasoningEffort(source, '26.727.40816'), 'bridge-unavailable');
    });

    test('updates the Codex extension memento through the shared storage service', async () => {
        const { source, storage } = fakeSource({
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['low', 'ultra'],
            anotherSetting: 'keep',
        });
        assert.strictEqual(await syncCodexMaxReasoningEffort(source, '26.727.40816'), 'updated');
        assert.deepStrictEqual(storage.state[CODEX_PERSISTED_ATOM_STATE_KEY], {
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: ['low', 'ultra', 'max'],
            anotherSetting: 'keep',
        });
        assert.strictEqual(await syncCodexMaxReasoningEffort(source, '26.727.40816'), 'already-enabled');
    });
});

suite('optional hooks', () => {
    const runner = '/tmp/otak-usage-hook.js';

    test('adds repository and sound hooks for Claude and Codex', () => {
        for (const provider of ['claude', 'codex'] as const) {
            const out = applyHookFeaturesJson('{}\n', provider, runner, { repositoryName: true, sounds: true });
            assert.ok(hasManagedHook(out, provider, 'repository'));
            assert.ok(hasManagedHook(out, provider, 'sounds'));
            assert.ok(out.includes('--otak-usage-hook ' + provider + ' repository'));
            assert.ok(out.includes('--otak-usage-hook ' + provider + ' sounds'));
            const parsed = JSON.parse(out);
            assert.ok(parsed.hooks.Stop);
            assert.ok(parsed.hooks.UserPromptSubmit);
        }
    });

    test('preserves user hooks and is idempotent', () => {
        const input = JSON.stringify({
            permissions: { allow: ['git status'] },
            hooks: {
                Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo user-stop' }] }],
            },
        }, null, 2) + '\r\n';
        const once = applyHookFeaturesJson(input, 'claude', runner, { repositoryName: true, sounds: true });
        const twice = applyHookFeaturesJson(once, 'claude', runner, { repositoryName: true, sounds: true });
        assert.strictEqual(twice, once);
        assert.deepStrictEqual(JSON.parse(once).permissions, { allow: ['git status'] });
        assert.ok(once.includes('echo user-stop'));
    });

    test('removes only managed hooks when disabled', () => {
        const input = JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] },
        });
        const enabled = applyHookFeaturesJson(input, 'codex', runner, { repositoryName: true, sounds: true });
        const disabled = applyHookFeaturesJson(enabled, 'codex', runner, { repositoryName: false, sounds: false });
        assert.ok(!hasManagedHook(disabled, 'codex', 'repository'));
        assert.ok(!hasManagedHook(disabled, 'codex', 'sounds'));
        assert.ok(disabled.includes('echo user-stop'));
    });

    test('preserves CRLF when creating a missing desktop-style document', () => {
        const out = applyHookFeaturesJson('{"permissions":{}}\r\n', 'codex', runner, { repositoryName: true, sounds: false });
        assert.ok(out.includes('\r\n'));
        assert.ok(out.includes('--otak-usage-hook codex repository'));
    });
});

suite('claude optimize', () => {
    const values = { contextWindow: 250000, autoCompactPercent: 85 };

    test('offers a 250k preset that compacts at 212.5k, leaving 37.5k for the summary', () => {
        assert.deepStrictEqual(CLAUDE_OPTIMIZE_PRESETS, [
            { id: '250k', contextWindow: 250000, autoCompactPercent: 85 },
        ]);
        assert.strictEqual(DEFAULT_CLAUDE_CONTEXT_WINDOW, 250000);
        assert.strictEqual(DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT, 85);
        assert.strictEqual(claudeAutoCompactTokenLimit(values), 212500);
        assert.strictEqual(values.contextWindow - claudeAutoCompactTokenLimit(values), 37500);
        assert.strictEqual(matchingClaudeOptimizePreset(values)?.id, '250k');
        assert.strictEqual(matchingClaudeOptimizePreset({ ...values, autoCompactPercent: 90 }), undefined);
        assert.strictEqual(matchingClaudeOptimizePreset({ ...values, contextWindow: 200000 }), undefined);
    });

    suite('shipped-default migration', () => {
        test('covers every default this extension has shipped, oldest first', () => {
            assert.deepStrictEqual(SHIPPED_CLAUDE_CONTEXT_DEFAULTS, [
                { contextWindow: 200000, autoCompactPercent: 92 },
                { contextWindow: 230000, autoCompactPercent: 85 },
                { contextWindow: 240000, autoCompactPercent: 90 },
            ]);
        });

        test('clears any pair this extension once shipped as its default', () => {
            for (const shipped of SHIPPED_CLAUDE_CONTEXT_DEFAULTS) {
                assert.deepStrictEqual(
                    planClaudeContextDefaultMigration(shipped.contextWindow, shipped.autoCompactPercent),
                    { clear: ['claudeContextWindow', 'claudeAutoCompactPercent'], write: {} },
                    shipped.contextWindow + ' / ' + shipped.autoCompactPercent + ' must migrate',
                );
            }
        });

        test('leaves the preset the current picker offers untouched', () => {
            for (const preset of CLAUDE_OPTIMIZE_PRESETS) {
                assert.deepStrictEqual(
                    planClaudeContextDefaultMigration(preset.contextWindow, preset.autoCompactPercent),
                    { clear: [], write: {} },
                    preset.id + ' must survive the migration',
                );
            }
        });

        test('writes nothing when neither value was ever set', () => {
            assert.deepStrictEqual(planClaudeContextDefaultMigration(undefined, undefined), {
                clear: [],
                write: {},
            });
        });

        test('clears the percentage-only release, whose window was never written', () => {
            assert.deepStrictEqual(planClaudeContextDefaultMigration(undefined, 90), {
                clear: ['claudeAutoCompactPercent'],
                write: {},
            });
        });

        test('leaves chosen values alone and pins the unset half to the previous default', () => {
            assert.deepStrictEqual(planClaudeContextDefaultMigration(1000000, undefined), {
                clear: [],
                write: { claudeAutoCompactPercent: 90 },
            });
            assert.deepStrictEqual(planClaudeContextDefaultMigration(undefined, 70), {
                clear: [],
                write: { claudeContextWindow: 240000 },
            });
            assert.deepStrictEqual(planClaudeContextDefaultMigration(1000000, 70), {
                clear: [],
                write: {},
            });
        });

        test('treats an out-of-range percentage as the previous default and clears it', () => {
            assert.deepStrictEqual(planClaudeContextDefaultMigration(240000, 0), {
                clear: ['claudeContextWindow', 'claudeAutoCompactPercent'],
                write: {},
            });
        });
    });

    test('matches the Codex window so both providers behave alike', () => {
        assert.strictEqual(DEFAULT_CLAUDE_CONTEXT_WINDOW, DEFAULT_CODEX_CONTEXT_WINDOW);
        assert.strictEqual(DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT / 100, CODEX_AUTO_COMPACT_RATIO);
        assert.strictEqual(claudeAutoCompactTokenLimit(values), DEFAULT_CODEX_AUTO_COMPACT_LIMIT);
    });

    test('normalizes percentages and token limits', () => {
        assert.strictEqual(normalizeClaudeAutoCompactPercent(0, 90), 90);
        assert.strictEqual(normalizeClaudeAutoCompactPercent(101, 90), 90);
        assert.strictEqual(normalizeClaudeAutoCompactPercent(85.8, 90), 85);
        assert.strictEqual(parseClaudeAutoCompactPercent('70'), 70);
        assert.strictEqual(parseClaudeAutoCompactPercent('0'), undefined);
        assert.strictEqual(parseClaudeAutoCompactPercent('101'), undefined);
        assert.strictEqual(normalizeClaudeTokenLimit(0, 230000), 230000);
        assert.strictEqual(normalizeClaudeTokenLimit('300000', 230000), 230000);
        assert.strictEqual(normalizeClaudeTokenLimit(300000.7, 230000), 300000);
        assert.strictEqual(parseClaudeTokenLimit('300_000'), 300000);
        assert.strictEqual(parseClaudeTokenLimit('0'), undefined);
        assert.strictEqual(parseClaudeTokenLimit('-1'), undefined);
    });

    test('applies string environment values and preserves unrelated settings', () => {
        const original = JSON.stringify({
            permissions: { allow: ['Bash(npm test)'] },
            env: { EXISTING: 'keep-me' },
            autoCompactEnabled: true,
        }, null, 4) + '\n';
        const backup = captureClaudeOptimizeBackup(original);
        const applied = applyClaudeOptimizeJson(original, values);
        const parsed = JSON.parse(applied);

        assert.deepStrictEqual(parsed.permissions, { allow: ['Bash(npm test)'] });
        assert.strictEqual(parsed.autoCompactEnabled, true);
        assert.strictEqual(parsed.env.EXISTING, 'keep-me');
        assert.strictEqual(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000');
        assert.strictEqual(parsed.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '85');
        assert.ok(applied.includes('\n    "permissions"'));

        const restored = JSON.parse(restoreClaudeOptimizeJson(applied, backup));
        assert.deepStrictEqual(restored, JSON.parse(original));
    });

    test('restores pre-existing optimizer values exactly', () => {
        const original = JSON.stringify({
            env: {
                CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
                CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
                OTHER: 'value',
            },
        });
        const backup = captureClaudeOptimizeBackup(original);
        const applied = applyClaudeOptimizeJson(original, values);
        const restored = restoreClaudeOptimizeJson(applied, backup);
        assert.deepStrictEqual(JSON.parse(restored), JSON.parse(original));
    });

    test('carries a v1 backup forward untouched, since it already held both values', () => {
        const legacyBackup: LegacyClaudeOptimizeBackup = {
            version: 1,
            envPresent: true,
            contextWindow: { present: true, value: '750000' },
            autoCompactPercent: { present: true, value: '80' },
        };
        const upgraded = upgradeLegacyClaudeOptimizeBackup(legacyBackup);
        assert.deepStrictEqual(upgraded, {
            version: 3,
            envPresent: true,
            contextWindow: { present: true, value: '750000' },
            autoCompactPercent: { present: true, value: '80' },
        });
        // Both formats give back the same file, so an interrupted upgrade is safe.
        const applied = applyClaudeOptimizeJson(JSON.stringify({ env: { OTHER: 'keep-me' } }), values);
        assert.deepStrictEqual(
            JSON.parse(restoreClaudeOptimizeJson(applied, upgraded)),
            JSON.parse(restoreLegacyClaudeOptimizeJson(applied, legacyBackup)),
        );
    });

    test('captures the window a v2 owner left in place before managing it again', () => {
        // v2 never wrote a window, so the one in the file is the user's own.
        const current = JSON.stringify({
            env: {
                CLAUDE_CODE_AUTO_COMPACT_WINDOW: '750000',
                CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90',
                OTHER: 'keep-me',
            },
        });
        const v2Backup: ClaudeOptimizeBackupV2 = {
            version: 2,
            envPresent: true,
            autoCompactPercent: { present: true, value: '80' },
        };
        const adopted = adoptClaudeOptimizeBackupV2(current, v2Backup);
        assert.deepStrictEqual(adopted, {
            version: 3,
            envPresent: true,
            contextWindow: { present: true, value: '750000' },
            autoCompactPercent: { present: true, value: '80' },
        });
        const applied = JSON.parse(applyClaudeOptimizeJson(current, values));
        assert.strictEqual(applied.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000');
        const restored = JSON.parse(restoreClaudeOptimizeJson(JSON.stringify(applied), adopted));
        assert.strictEqual(restored.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '750000');
        assert.strictEqual(restored.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
        assert.strictEqual(restored.env.OTHER, 'keep-me');
    });

    test('leaves the window alone when restoring v2 ownership that never managed it', () => {
        const v2Backup: ClaudeOptimizeBackupV2 = {
            version: 2,
            envPresent: true,
            autoCompactPercent: { present: false },
        };
        const restored = JSON.parse(restoreClaudeOptimizeV2Json(JSON.stringify({ env: {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '750000',
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90',
        } }), v2Backup));
        assert.strictEqual(restored.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '750000');
        assert.strictEqual(restored.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
    });

    test('rejects a backup tagged with another ownership version', () => {
        const v2Backup: ClaudeOptimizeBackupV2 = { version: 2, envPresent: false, autoCompactPercent: { present: false } };
        assert.throws(() => restoreClaudeOptimizeJson('{}', v2Backup as never), /backup version/);
        assert.throws(() => restoreClaudeOptimizeV2Json('{}', { version: 3 } as never), /backup version/);
        assert.throws(() => restoreLegacyClaudeOptimizeJson('{}', v2Backup as never), /backup version/);
    });

    test('removes an env object created solely for optimization on restore', () => {
        const original = '{"model":"opus"}\r\n';
        const backup = captureClaudeOptimizeBackup(original);
        const applied = applyClaudeOptimizeJson(original, values);
        assert.ok(applied.includes('\r\n'));
        const restored = JSON.parse(restoreClaudeOptimizeJson(applied, backup));
        assert.deepStrictEqual(restored, { model: 'opus' });
    });

    test('keeps unrelated environment values added while optimization is active', () => {
        const original = '{}\n';
        const backup = captureClaudeOptimizeBackup(original);
        const applied = JSON.parse(applyClaudeOptimizeJson(original, values));
        applied.env.ADDED_LATER = 'keep-me';
        const restored = JSON.parse(restoreClaudeOptimizeJson(JSON.stringify(applied), backup));
        assert.deepStrictEqual(restored, { env: { ADDED_LATER: 'keep-me' } });
    });

    test('rejects malformed settings and a non-object env without rewriting', () => {
        assert.throws(() => captureClaudeOptimizeBackup('{ invalid'));
        assert.throws(() => applyClaudeOptimizeJson('{"env":"bad"}', values), /env/);
        assert.throws(() => applyClaudeOptimizeJson('[]', values), /JSON object/);
    });
});

suite('i18n', () => {
    test('resolves supported and regional locales', () => {
        assert.strictEqual(resolveSupportedLocale('en-US'), 'en');
        assert.strictEqual(resolveSupportedLocale('ja_JP'), 'ja');
        assert.strictEqual(resolveSupportedLocale('zh-Hans-CN'), 'zh-cn');
        assert.strictEqual(resolveSupportedLocale('zh-Hant-TW'), 'zh-tw');
        assert.strictEqual(resolveSupportedLocale('ar-SA'), 'ar');
        assert.strictEqual(resolveSupportedLocale('de-DE'), 'de');
        assert.strictEqual(resolveSupportedLocale('es-MX'), 'es');
        assert.strictEqual(resolveSupportedLocale('fr-CA'), 'fr');
        assert.strictEqual(resolveSupportedLocale('hi-IN'), 'hi');
        assert.strictEqual(resolveSupportedLocale('id-ID'), 'id');
        assert.strictEqual(resolveSupportedLocale('it-IT'), 'it');
        assert.strictEqual(resolveSupportedLocale('pt-PT'), 'pt-br');
        assert.strictEqual(resolveSupportedLocale('ru-RU'), 'ru');
        assert.strictEqual(resolveSupportedLocale('tr-TR'), 'tr');
        assert.strictEqual(resolveSupportedLocale('fr-FR'), 'fr');
        assert.strictEqual(resolveSupportedLocale('nl-NL'), 'en');
    });

    test('translates runtime messages with parameters', () => {
        const i18n = new I18n('ja');
        assert.strictEqual(i18n.getCurrentLocale(), 'ja');
        assert.ok(i18n.t('action.openSettings').includes('設定'));
        assert.ok(i18n.t('alert.dailyCostExceeded', { total: '$12.34', threshold: '$10.00' }).includes('$12.34'));
    });

    test('all supported locales have substituted alert messages', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const message = new I18n(locale).t('alert.dailyCostExceeded', { total: '$12.34', threshold: '$10.00' });
            assert.ok(message.includes('$12.34'), locale);
            assert.ok(message.includes('$10.00'), locale);
            assert.ok(!message.includes('{total}'), locale);
            assert.ok(!message.includes('{threshold}'), locale);
        }
    });

    test('all supported locales substitute the limit alert message', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const message = new I18n(locale).t('alert.limitExceeded', { provider: 'Claude', window: '5h', pct: '82', threshold: '80' });
            assert.ok(message.includes('Claude'), locale);
            assert.ok(message.includes('82'), locale);
            for (const ph of ['{provider}', '{window}', '{pct}', '{threshold}']) {
                assert.ok(!message.includes(ph), `${locale}: ${ph}`);
            }
        }
    });

    test('every locale names the host it is not reading', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const i18n = new I18n(locale);
            for (const key of ['action.installOnRemote', 'alert.scanningLocalHost', 'tooltip.scanningLocalHost'] as const) {
                const text = i18n.t(key, { remote: 'GitHub Codespaces' });
                assert.ok(text.includes('GitHub Codespaces'), `${locale}: ${key}`);
                assert.ok(!text.includes('{remote}'), `${locale}: ${key}`);
                if (locale !== 'en') {
                    assert.notStrictEqual(text, new I18n('en').t(key, { remote: 'GitHub Codespaces' }), `${locale} fell back to English: ${key}`);
                }
            }
        }
    });

    test('every locale names the snooze action and its confirmations', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const i18n = new I18n(locale);
            for (const key of ['action.notToday', 'message.alertsSnoozed', 'message.alertsResumed'] as const) {
                const text = i18n.t(key);
                assert.ok(text.trim().length > 0, `${locale}: ${key}`);
                assert.ok(!text.includes('{'), `${locale}: ${key}`);
                if (locale !== 'en') {
                    assert.notStrictEqual(text, new I18n('en').t(key), `${locale} fell back to English: ${key}`);
                }
            }
            // The notification puts the two actions side by side, so a locale
            // that translated both to the same label would be unusable.
            assert.notStrictEqual(i18n.t('action.notToday'), i18n.t('action.openSettings'), locale);
        }
    });
});

suite('formatter', () => {
    test('formatCost groups thousands', () => {
        assert.strictEqual(formatCost(12.345), '$12.35');
        assert.strictEqual(formatCost(1234.5), '$1,234.50');
    });

    test('formatTokenLimit keeps Optimize targets compact and exact', () => {
        assert.strictEqual(formatTokenLimit(272000), '272k');
        assert.strictEqual(formatTokenLimit(195500), '195.5k');
        assert.strictEqual(formatTokenLimit(231200), '231.2k');
        assert.strictEqual(formatTokenLimit(250500), '250.5k');
        assert.strictEqual(formatTokenLimit(250550), '250,550');
    });

    test('status bar shows the selected-period total for visible available providers', () => {
        const summary = (cost: number) => ({
            provider: 'claude' as const, todayCost: cost, monthCost: cost * 2, hasUnknownModel: false, models: [],
        });
        const text = statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: true, show: true },
            'today', false,
        );
        assert.strictEqual(text, '$17.34');
        const monthText = statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: true, show: false },
            'month', false,
        );
        assert.strictEqual(monthText, '$24.68');
    });

    test('status bar excludes unavailable providers and RTK stats', () => {
        const summary = (cost: number) => ({
            provider: 'claude' as const, todayCost: cost, monthCost: cost * 2, hasUnknownModel: false, models: [],
        });
        const rtk: RtkView = {
            show: true,
            stats: {
                today: { commands: 5, inputTokens: 1000, outputTokens: 100, savedTokens: 900 },
                month: { commands: 50, inputTokens: 2_000_000, outputTokens: 300_000, savedTokens: 1_700_000 },
                allTime: { commands: 99, inputTokens: 107_270_123, outputTokens: 17_583_120, savedTokens: 89_719_478 },
            },
        };

        assert.strictEqual(statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: false, show: true },
            'today', false,
        ), '$12.34');

        assert.strictEqual(statusBarText(
            { summary: summary(12.34), available: true, show: false },
            { summary: summary(5), available: true, show: false },
            'month', false,
        ), '—');

        assert.strictEqual(statusBarText(
            { summary: summary(12.34), available: true, show: true },
            { summary: summary(5), available: true, show: true },
            'today', true,
        ), '$(loading~spin) usage');

        const md = tooltipMarkdown(
            { summary: summary(12.34), available: true, show: false },
            { summary: summary(5), available: true, show: false },
            rtk,
            'today',
            new Date(2026, 5, 10, 9, 5),
        );
        assert.ok(md.includes('$(zap) **RTK — Token Savings**'));
    });

    test('status bar prefers the longer provider limit window', () => {
        const summary = { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] };
        const text = statusBarText(
            {
                summary,
                available: true,
                show: true,
                limits: {
                    asOfMs: Date.now(),
                    primary: { usedPercent: 17, windowMinutes: 300 },
                    secondary: { usedPercent: 35, windowMinutes: 10080 },
                },
            },
            { summary: { ...summary, provider: 'codex' as const }, available: false, show: false },
            'month',
            false,
            'limits',
        );
        assert.strictEqual(text, '$(otak-claude) 35%');
    });

    test('tooltip includes the combined OpenAI and Claude total', () => {
        const claude = {
            summary: { provider: 'claude' as const, todayCost: 12.34, monthCost: 24.68, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const codex = {
            summary: { provider: 'codex' as const, todayCost: 5, monthCost: 10, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };

        const md = tooltipMarkdown(claude, codex, noRtk, 'today', new Date(2026, 5, 10, 9, 5));
        assert.ok(md.includes('**OpenAI + Claude Total: $17.34 / $34.68**'));

        const unavailableMd = tooltipMarkdown(claude, { ...codex, available: false }, noRtk, 'today', new Date(2026, 5, 10, 9, 5));
        assert.ok(!unavailableMd.includes('OpenAI + Claude Total'));
    });

    test('tooltip exposes optional hook toggles', () => {
        const summary = (provider: 'claude' | 'codex') => ({
            provider, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [],
        });
        const md = tooltipMarkdown(
            { summary: summary('claude'), available: true, show: true },
            { summary: summary('codex'), available: true, show: true },
            noRtk,
            'today',
            new Date(2026, 5, 10, 9, 5),
            undefined,
            undefined,
            undefined,
            undefined,
            { repositoryName: true, sounds: false },
        );
        assert.ok(md.includes('Repository name: On'));
        assert.ok(md.includes('Hook sounds: Off'));
        assert.ok(md.includes('command:otak-usage.toggleRepositoryNameHook'));
        assert.ok(md.includes('command:otak-usage.toggleHookSounds'));
        assert.match(md, /\n\n\[Repository name:/, 'hook toggles should start in a separate Markdown block');
    });

    test('tooltip renders brand icons as sized theme-coloured images when a colour is given', () => {
        const claude = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const codex = {
            summary: { provider: 'codex' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const now = new Date(2026, 5, 10, 9, 5);

        // Without a colour, the header keeps the shared status-bar codicons.
        const codicon = tooltipMarkdown(claude, codex, noRtk, 'today', now);
        assert.ok(codicon.includes('$(otak-claude)') && codicon.includes('$(otak-openai)'));
        assert.ok(!codicon.includes('<img'));

        // With a colour, both marks become independently sized inline images
        // tinted to the active theme's foreground.
        const img = tooltipMarkdown(claude, codex, noRtk, 'today', now, new I18n('en'), '#cccccc');
        const imgCount = (img.match(/<img src="data:image\/svg\+xml;base64,/g) ?? []).length;
        assert.strictEqual(imgCount, 2);
        assert.ok(img.includes('width="18" height="18"'));
        assert.ok(!img.includes('$(otak-claude)') && !img.includes('$(otak-openai)'));
        // The chosen colour is baked into the SVG (base64), so it must decode back.
        const decoded = img
            .match(/base64,([^"]+)"/g)!
            .map((m) => Buffer.from(m.slice(7, -1), 'base64').toString('utf8'));
        assert.ok(decoded.every((svg) => svg.includes('fill="#cccccc"')));
    });

    test('tooltip localizes runtime labels', () => {
        const row = {
            model: 'claude-fable-5',
            todayUsage: emptyUsage(), monthUsage: emptyUsage(),
            todayCost: 12.34, monthCost: 24.68,
        };
        const claude = {
            summary: { provider: 'claude' as const, todayCost: 12.34, monthCost: 24.68, hasUnknownModel: false, models: [row] },
            available: true,
            show: true,
        };
        const codex = {
            summary: { provider: 'codex' as const, todayCost: 5, monthCost: 10, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const rtk: RtkView = {
            show: true,
            stats: {
                today: emptyRtkPeriod(),
                month: { commands: 50, inputTokens: 2_000_000, outputTokens: 300_000, savedTokens: 1_700_000 },
                allTime: { commands: 99, inputTokens: 107_270_123, outputTokens: 17_583_120, savedTokens: 89_719_478 },
            },
        };

        const md = tooltipMarkdown(claude, codex, rtk, 'month', new Date(2026, 5, 10, 9, 5), new I18n('ja'));
        assert.ok(md.includes('**otak-usage — API 相当コスト**'));
        assert.ok(md.includes('**OpenAI + Claude 合計: $17.34 / $34.68**'));
        assert.ok(md.includes('| $(otak-claude) **Claude Code** | │ | $(otak-openai) **Codex CLI** |'));
        assert.ok(md.includes('| :--- | :---: | :--- |'));
        assert.ok(md.includes('claude-fable-5: $12.34 / $24.68'));
        assert.ok(md.includes('**合計: $12.34 / $24.68**'));
        assert.ok(!md.includes('_本日 / 今月_'));
        assert.ok(md.includes('期間: **今月** · 更新 09:05 · クリックして表示を切り替え'));
        assert.ok(md.includes('[$(copy) サマリーをコピー]'));
        assert.ok(md.includes('$(zap) **RTK — トークン節約量**'));
        assert.ok(md.includes('| 全期間 | 107.3M | 17.6M | 89.7M | 83.6% |'));
    });

    test('tooltip keeps unequal provider rows and totals aligned', () => {
        const model = (name: string, cost: number) => ({
            model: name,
            todayUsage: emptyUsage(),
            monthUsage: emptyUsage(),
            todayCost: cost,
            monthCost: cost * 2,
        });
        const claude = {
            summary: {
                provider: 'claude' as const,
                todayCost: 3,
                monthCost: 6,
                hasUnknownModel: false,
                models: [model('claude-one', 1), model('claude-two', 2)],
            },
            available: true,
            show: true,
        };
        const codex = {
            summary: {
                provider: 'codex' as const,
                todayCost: 4,
                monthCost: 8,
                hasUnknownModel: false,
                models: [model('gpt-one', 4)],
            },
            available: true,
            show: true,
        };
        const md = tooltipMarkdown(claude, codex, noRtk, 'month', new Date(2026, 5, 10, 9, 5));
        assert.ok(md.includes('| claude-one: $1.00 / $2.00 | │ | gpt-one: $4.00 / $8.00 |'));
        assert.ok(md.includes('| claude-two: $2.00 / $4.00 | │ | &nbsp; |'));
        assert.ok(md.includes('| **Total: $3.00 / $6.00** | │ | **Total: $4.00 / $8.00** |'));
        assert.ok(!md.includes('<br>'));
    });

    test('tooltip contains the copy command link', () => {
        const view = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const md = tooltipMarkdown(view, { ...view, show: false }, noRtk, 'today', new Date(2026, 5, 10, 9, 5));
        assert.ok(md.includes('(command:otak-usage.copyUsage'));
        assert.ok(md.includes('Updated 09:05'));
        assert.ok(!md.includes('RTK'));
        // Settings opens all otakUsage settings; Optimize opens the preset picker.
        assert.ok(md.includes(`openSettings?${encodeURIComponent(JSON.stringify(['otakUsage']))}`));
        assert.ok(md.includes('(command:otak-usage.configureCodexOptimization'));
        assert.ok(md.includes('Optimize'));
    });

    test('tooltip leads with the host warning when the window reads another machine', () => {
        const view = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const warning = 'Reading this machine — usage on GitHub Codespaces is not counted.';
        const render = (hostWarning?: string) => tooltipMarkdown(
            view, { ...view, show: false }, noRtk, 'today', new Date(2026, 5, 10, 9, 5),
            new I18n('en'), undefined, undefined, hostWarning,
        );
        const warned = render(warning);
        assert.ok(warned.includes(`$(warning) _${warning}_`));
        // Which machine the numbers describe outranks the numbers themselves:
        // the caveat sits under the title, above everything it qualifies.
        assert.ok(warned.indexOf('otak-usage — API-equivalent cost') < warned.indexOf('$(warning)'));
        assert.ok(warned.indexOf('$(warning)') < warned.indexOf('Period:'));
        assert.ok(!render().includes('$(warning)'));
    });

    test('the copied summary carries the host warning where the tooltip cannot follow it', () => {
        const view = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const now = new Date(2026, 5, 10, 9, 5);
        const note = 'Reading this machine — usage on GitHub Codespaces is not counted.';
        assert.ok(clipboardText(view, view, noRtk, now, note).split('\n')[1].includes(note));
        assert.ok(!clipboardText(view, view, noRtk, now).includes('GitHub Codespaces'));
    });

    test('tooltip shows the active Optimize token pair', () => {
        const view = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const md = tooltipMarkdown(
            view,
            { ...view, show: false },
            noRtk,
            'month',
            new Date(2026, 5, 10, 9, 5),
            new I18n('en'),
            undefined,
            {
                claude: { enabled: true, contextWindow: 240000, autoCompactLimit: 216000 },
                codex: { enabled: true, contextWindow: 272000, autoCompactLimit: 250000 },
            },
        );
        assert.ok(md.includes('Optimize (Claude 240k → 216k · Codex 272k → 250k)'));
    });

    test('tooltip includes the RTK savings table when stats exist', () => {
        const view = {
            summary: { provider: 'claude' as const, todayCost: 1, monthCost: 2, hasUnknownModel: false, models: [] },
            available: true,
            show: true,
        };
        const rtk: RtkView = {
            show: true,
            stats: {
                today: emptyRtkPeriod(),
                month: { commands: 50, inputTokens: 2_000_000, outputTokens: 300_000, savedTokens: 1_700_000 },
                allTime: { commands: 99, inputTokens: 107_270_123, outputTokens: 17_583_120, savedTokens: 89_719_478 },
            },
        };
        const md = tooltipMarkdown(view, { ...view, show: false }, rtk, 'today', new Date(2026, 5, 10, 9, 5));
        assert.ok(md.includes('$(zap) **RTK — Token Savings**'));
        assert.ok(md.includes('| All Time | 107.3M | 17.6M | 89.7M | 83.6% |'));
        // a period with no commands shows n/a instead of a rate
        assert.ok(md.includes('| Today | 0 | 0 | 0 | n/a |'));
    });

    test('clipboardText lists providers and models in plain text', () => {
        const row = {
            model: 'claude-fable-5',
            todayUsage: emptyUsage(), monthUsage: emptyUsage(),
            todayCost: 340.49, monthCost: 340.49,
        };
        const claude = {
            summary: { provider: 'claude' as const, todayCost: 371.18, monthCost: 2455.8, hasUnknownModel: false, models: [row] },
            available: true, show: true,
        };
        const codex = {
            summary: { provider: 'codex' as const, todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
            available: false, show: true,
        };
        const rtk: RtkView = {
            show: true,
            stats: {
                today: { commands: 5, inputTokens: 1000, outputTokens: 100, savedTokens: 900 },
                month: { commands: 50, inputTokens: 2_000_000, outputTokens: 300_000, savedTokens: 1_700_000 },
                allTime: { commands: 99, inputTokens: 107_270_123, outputTokens: 17_583_120, savedTokens: 89_719_478 },
            },
        };
        const text = clipboardText(claude, codex, rtk, new Date(Date.UTC(2026, 5, 10, 12, 0)));
        assert.ok(text.includes('Claude Code: today $371.18 / month $2,455.80'));
        assert.ok(text.includes('  claude-fable-5: today $340.49 / month $340.49'));
        assert.ok(text.includes('Codex CLI: logs not found'));
        assert.ok(text.includes('RTK saved: today 900 (90.0%) / month 1.7M (85.0%) / all-time 89.7M (83.6%)'));
        assert.ok(text.startsWith('otak-usage 2026-06-10 12:00'));
        // no rtk -> no RTK line
        assert.ok(!clipboardText(claude, codex, noRtk, new Date(Date.UTC(2026, 5, 10, 12, 0))).includes('RTK'));
    });

    test('formatTokens uses rtk-style units', () => {
        assert.strictEqual(formatTokens(0), '0');
        assert.strictEqual(formatTokens(642), '642');
        assert.strictEqual(formatTokens(394_400), '394.4K');
        assert.strictEqual(formatTokens(89_719_478), '89.7M');
        assert.strictEqual(formatTokens(1_230_000_000), '1.2B');
    });
});

suite('rtk', () => {
    const sample = JSON.stringify({
        summary: {
            total_commands: 16318,
            total_input: 107_270_123,
            total_output: 17_583_120,
            total_saved: 89_719_478,
            avg_savings_pct: 83.6,
            total_time_ms: 294_153_933,
            avg_time_ms: 18026,
        },
        daily: [
            { date: '2026-05-02', commands: 6, input_tokens: 713, output_tokens: 71, saved_tokens: 642, savings_pct: 90.0 },
            { date: '2026-06-01', commands: 10, input_tokens: 5000, output_tokens: 500, saved_tokens: 4500, savings_pct: 90.0 },
            { date: '2026-06-12', commands: 4, input_tokens: 2000, output_tokens: 1000, saved_tokens: 1000, savings_pct: 50.0 },
        ],
    });

    test('parseRtkGain splits today / month / all-time', () => {
        const stats = parseRtkGain(sample, '2026-06-12');
        assert.ok(stats);
        assert.deepStrictEqual(stats.today, { commands: 4, inputTokens: 2000, outputTokens: 1000, savedTokens: 1000 });
        // month = 06-01 + 06-12; the May entry is excluded
        assert.deepStrictEqual(stats.month, { commands: 14, inputTokens: 7000, outputTokens: 1500, savedTokens: 5500 });
        assert.strictEqual(stats.allTime.inputTokens, 107_270_123);
        assert.strictEqual(stats.allTime.savedTokens, 89_719_478);
    });

    test('rtkSavingsPct is saved/input, undefined with no input', () => {
        const stats = parseRtkGain(sample, '2026-06-12');
        assert.ok(stats);
        assert.strictEqual(rtkSavingsPct(stats.today), 50);
        assert.ok(Math.abs((rtkSavingsPct(stats.allTime) ?? 0) - 83.6388) < 1e-3);
        assert.strictEqual(rtkSavingsPct(emptyRtkPeriod()), undefined);
    });

    test('summary-only output (no daily array) still parses', () => {
        const stats = parseRtkGain(JSON.stringify({ summary: { total_commands: 1, total_input: 10, total_output: 2, total_saved: 8 } }), '2026-06-12');
        assert.ok(stats);
        assert.strictEqual(stats.allTime.savedTokens, 8);
        assert.deepStrictEqual(stats.today, emptyRtkPeriod());
    });

    test('malformed output returns undefined', () => {
        assert.strictEqual(parseRtkGain('not json', '2026-06-12'), undefined);
        assert.strictEqual(parseRtkGain('"json but not an object"', '2026-06-12'), undefined);
        assert.strictEqual(parseRtkGain('{}', '2026-06-12'), undefined);
    });
});

suite('telemetry', () => {
    const t = new Date(2026, 5, 12, 9, 30, 0).getTime(); // 2026-06-12 local
    const today = dayKey(t);
    const config: TelemetryConfig = {
        enabled: true,
        metrics: ALL_TELEMETRY_METRICS,
        endpoint: 'http://localhost:4318',
        headers: {},
        serviceName: 'otak-usage',
        serviceVersion: '9.9.9',
        serviceInstanceId: '',
    };

    function usage(partial: Partial<TokenUsage>): TokenUsage {
        return { ...emptyUsage(), ...partial };
    }

    function attrs(point: { attributes: Array<{ key: string; value: unknown }> }): Record<string, string> {
        const out: Record<string, string> = {};
        for (const kv of point.attributes) {
            out[kv.key] = (kv.value as { stringValue?: string }).stringValue ?? '';
        }
        return out;
    }

    function buildFromEvents(events: UsageEvent[], rtkStats?: TelemetrySnapshot['rtk']) {
        const days: DayBuckets = {};
        for (const ev of events) {
            addEvent(days, ev);
        }
        const summaries = summarize(days, today);
        const snapshot: TelemetrySnapshot = { timestampMs: t, windowStartMs: startOfMonth(t), summaries, rtk: rtkStats };
        return buildMetricsPayload(config, snapshot);
    }

    function metricByName(payload: ReturnType<typeof buildMetricsPayload>, name: string) {
        assert.ok(payload);
        return payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
    }

    function findPoint(metric: { sum: { dataPoints: Array<{ attributes: Array<{ key: string; value: unknown }>; asInt?: string }> } } | undefined, match: Record<string, string>) {
        assert.ok(metric);
        return metric.sum.dataPoints.find((p) => {
            const a = attrs(p);
            return Object.entries(match).every(([k, v]) => a[k] === v);
        });
    }

    test('maps token usage to gen_ai semantic-convention labels', () => {
        const payload = buildFromEvents([
            { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 100, cacheRead: 35369, cacheWrite5m: 200, cacheWrite1h: 40, output: 336 }) },
            { provider: 'codex', model: 'gpt-5.5', timestamp: t, usage: usage({ input: 50, cachedInput: 20, output: 80 }) },
        ]);
        const metric = metricByName(payload, 'gen_ai.client.token.usage');
        assert.ok(metric);
        assert.strictEqual(metric.unit, '{token}');
        assert.strictEqual(metric.sum.aggregationTemporality, 2);
        assert.strictEqual(metric.sum.isMonotonic, true);

        // Claude → anthropic; cache_creation = 5m + 1h.
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'anthropic', 'gen_ai.response.model': 'claude-opus-4-8', 'gen_ai.token.type': 'input' })?.asInt, '100');
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'anthropic', 'gen_ai.token.type': 'output' })?.asInt, '336');
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'anthropic', 'gen_ai.token.type': 'cache_read' })?.asInt, '35369');
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'anthropic', 'gen_ai.token.type': 'cache_creation' })?.asInt, '240');

        // Codex → openai; cachedInput folds into cache_read.
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'openai', 'gen_ai.response.model': 'gpt-5.5', 'gen_ai.token.type': 'input' })?.asInt, '50');
        assert.strictEqual(findPoint(metric, { 'gen_ai.system': 'openai', 'gen_ai.token.type': 'cache_read' })?.asInt, '20');

        // Counter start time = month start, data point time = now.
        const dp = findPoint(metric, { 'gen_ai.system': 'openai', 'gen_ai.token.type': 'output' });
        assert.strictEqual(dp?.asInt, '80');
    });

    test('carries service resource attributes and scope', () => {
        const payload = buildFromEvents([
            { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 1 }) },
        ]);
        assert.ok(payload);
        const resAttrs = attrs(payload.resourceMetrics[0].resource);
        assert.strictEqual(resAttrs['service.name'], 'otak-usage');
        assert.strictEqual(resAttrs['service.version'], '9.9.9');
        assert.strictEqual(payload.resourceMetrics[0].scopeMetrics[0].scope.name, 'otak-usage');
        // Blank instance id is omitted from resource attributes.
        assert.ok(!('service.instance.id' in resAttrs));
    });

    test('exports a user-set source as service.instance.id', () => {
        const days: DayBuckets = {};
        addEvent(days, { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 1 }) });
        const snapshot: TelemetrySnapshot = { timestampMs: t, windowStartMs: startOfMonth(t), summaries: summarize(days, today), rtk: undefined };
        const payload = buildMetricsPayload({ ...config, serviceInstanceId: '  my-laptop  ' }, snapshot);
        assert.ok(payload);
        const resAttrs = attrs(payload.resourceMetrics[0].resource);
        // Free-form string, trimmed.
        assert.strictEqual(resAttrs['service.instance.id'], 'my-laptop');
    });

    test('omits zero-valued data points and returns undefined when empty', () => {
        assert.strictEqual(buildFromEvents([]), undefined);
        const payload = buildFromEvents([
            { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 5 }) },
        ]);
        const metric = metricByName(payload, 'gen_ai.client.token.usage');
        assert.ok(metric);
        // Only the input bucket is non-zero.
        assert.strictEqual(metric.sum.dataPoints.length, 1);
    });

    test('emits all-time RTK token counts with rtk type labels', () => {
        const rtk = {
            today: emptyRtkPeriod(),
            month: emptyRtkPeriod(),
            allTime: { commands: 3, inputTokens: 1000, outputTokens: 200, savedTokens: 800 },
        };
        const payload = buildFromEvents([
            { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 1 }) },
        ], rtk);
        const metric = metricByName(payload, 'otak_usage.rtk.tokens');
        assert.ok(metric);
        assert.strictEqual(findPoint(metric, { 'otak_usage.rtk.type': 'saved' })?.asInt, '800');
        assert.strictEqual(findPoint(metric, { 'otak_usage.rtk.type': 'input' })?.asInt, '1000');
        assert.strictEqual(findPoint(metric, { 'otak_usage.rtk.type': 'output' })?.asInt, '200');
        assert.strictEqual(metric.sum.dataPoints[0].startTimeUnixNano, '0');
    });

    test('emits per-model cost in USD as a double', () => {
        const days: DayBuckets = {};
        addEvent(days, { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 1_000_000, output: 1_000_000 }) });
        const snapshot: TelemetrySnapshot = { timestampMs: t, windowStartMs: startOfMonth(t), summaries: summarize(days, today), rtk: undefined };
        const payload = buildMetricsPayload(config, snapshot);
        const metric = metricByName(payload, 'otak_usage.cost.usd');
        assert.ok(metric);
        assert.strictEqual(metric.unit, 'USD');
        const dp = metric.sum.dataPoints.find((p) => attrs(p)['gen_ai.response.model'] === 'claude-opus-4-8');
        assert.ok(dp);
        assert.strictEqual(attrs(dp)['gen_ai.system'], 'anthropic');
        assert.ok(typeof dp.asDouble === 'number' && dp.asDouble > 0);
    });

    test('exports only the selected contents', () => {
        const days: DayBuckets = {};
        addEvent(days, { provider: 'claude', model: 'claude-opus-4-8', timestamp: t, usage: usage({ input: 1000, output: 1000 }) });
        const rtk = { today: emptyRtkPeriod(), month: emptyRtkPeriod(), allTime: { commands: 1, inputTokens: 10, outputTokens: 2, savedTokens: 8 } };
        const snapshot: TelemetrySnapshot = { timestampMs: t, windowStartMs: startOfMonth(t), summaries: summarize(days, today), rtk };

        const onlyRtk = buildMetricsPayload({ ...config, metrics: ['rtkTokens'] }, snapshot);
        assert.strictEqual(metricByName(onlyRtk, 'gen_ai.client.token.usage'), undefined);
        assert.strictEqual(metricByName(onlyRtk, 'otak_usage.cost.usd'), undefined);
        assert.ok(metricByName(onlyRtk, 'otak_usage.rtk.tokens'));

        const onlyTokens = buildMetricsPayload({ ...config, metrics: ['tokenUsage'] }, snapshot);
        assert.ok(metricByName(onlyTokens, 'gen_ai.client.token.usage'));
        assert.strictEqual(metricByName(onlyTokens, 'otak_usage.cost.usd'), undefined);
        assert.strictEqual(metricByName(onlyTokens, 'otak_usage.rtk.tokens'), undefined);

        // Nothing selected → nothing to send.
        assert.strictEqual(buildMetricsPayload({ ...config, metrics: [] }, snapshot), undefined);
    });

    test('metricsUrl appends /v1/metrics once', () => {
        assert.strictEqual(metricsUrl('http://localhost:4318'), 'http://localhost:4318/v1/metrics');
        assert.strictEqual(metricsUrl('http://localhost:4318/'), 'http://localhost:4318/v1/metrics');
        assert.strictEqual(metricsUrl('https://otlp.example.com/v1/metrics'), 'https://otlp.example.com/v1/metrics');
    });
});
