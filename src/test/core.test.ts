import * as assert from 'assert';
import { addEvent, pruneDaysBefore, summarize } from '../aggregator';
import { evaluateDailyAlert, normalizeDailyAlertThresholdUsd } from '../alert';
import { RtkView, clipboardText, formatCost, formatTokens, statusBarText, tooltipMarkdown } from '../formatter';
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

    test('gpt-5.4 family resolves per official prices', () => {
        assert.strictEqual(resolvePricing('gpt-5.4-pro')?.input, 30);
        assert.strictEqual(resolvePricing('gpt-5.4-pro')?.output, 180);
        assert.strictEqual(resolvePricing('gpt-5.4-mini')?.input, 0.75);
        assert.strictEqual(resolvePricing('gpt-5.4-mini')?.cachedInput, 0.075);
        assert.strictEqual(resolvePricing('gpt-5.4-nano')?.output, 1.25);
        assert.strictEqual(resolvePricing('gpt-5.4')?.input, 2.5);
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
});

suite('formatter', () => {
    test('formatCost groups thousands', () => {
        assert.strictEqual(formatCost(12.345), '$12.35');
        assert.strictEqual(formatCost(1234.5), '$1,234.50');
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
        assert.ok(md.includes('**OpenAI + Claude Total**'));
        assert.ok(md.includes('| **$17.34** | **$34.68** |'));

        const unavailableMd = tooltipMarkdown(claude, { ...codex, available: false }, noRtk, 'today', new Date(2026, 5, 10, 9, 5));
        assert.ok(!unavailableMd.includes('**OpenAI + Claude Total**'));
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
        assert.ok(md.includes('**OpenAI + Claude 合計**'));
        assert.ok(md.includes('| モデル | 本日 | 今月 |'));
        assert.ok(md.includes('| **合計** | **$12.34** | **$24.68** |'));
        assert.ok(md.includes('期間: **今月** · 更新 09:05 · クリックして期間を切り替え'));
        assert.ok(md.includes('[$(copy) サマリーをコピー]'));
        assert.ok(md.includes('$(zap) **RTK — トークン節約量**'));
        assert.ok(md.includes('| 全期間 | 107.3M | 17.6M | 89.7M | 83.6% |'));
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
