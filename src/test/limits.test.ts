import * as assert from 'assert';
import { ProviderSummary } from '../aggregator';
import { ProviderView, cycleStatusBarView, detectSubscriptionMode, limitWindowLabel, limitsLines, statusBarText } from '../formatter';
import { I18n } from '../i18n';
import { ProviderLimits, effectiveLimits, parseClaudeUsageResponse, parseCodexRateLimitLine } from '../limits';

const NOW = new Date(2026, 6, 11, 12, 0, 0); // 2026-07-11 12:00 local
const NOW_MS = NOW.getTime();

suite('limits: codex rollout parsing', () => {
    const line = JSON.stringify({
        timestamp: '2026-07-11T04:17:29.134Z',
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
            rate_limits: {
                limit_id: 'codex',
                primary: { used_percent: 11.0, window_minutes: 300, resets_at: 1783745711 },
                secondary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1784332511 },
                plan_type: 'pro',
            },
        },
    });

    test('extracts both windows, plan type, and snapshot time', () => {
        const limits = parseCodexRateLimitLine(line);
        assert.ok(limits);
        assert.strictEqual(limits.primary?.usedPercent, 11);
        assert.strictEqual(limits.primary?.resetsAtMs, 1783745711000);
        assert.strictEqual(limits.primary?.windowMinutes, 300);
        assert.strictEqual(limits.secondary?.usedPercent, 2);
        assert.strictEqual(limits.secondary?.windowMinutes, 10080);
        assert.strictEqual(limits.planType, 'pro');
        assert.strictEqual(limits.asOfMs, Date.parse('2026-07-11T04:17:29.134Z'));
    });

    test('a weekly-only snapshot (no session window) keeps its window length', () => {
        // Plans without a 5h session limit report only the weekly window, in primary.
        const weeklyOnly = JSON.stringify({
            timestamp: '2026-07-13T00:49:09.949Z',
            type: 'event_msg',
            payload: {
                type: 'token_count',
                rate_limits: {
                    limit_id: 'codex',
                    primary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1784499943 },
                    secondary: null,
                    plan_type: 'pro',
                },
            },
        });
        const limits = parseCodexRateLimitLine(weeklyOnly);
        assert.ok(limits);
        assert.strictEqual(limits.primary?.windowMinutes, 10080);
        assert.strictEqual(limits.secondary, undefined);
    });

    test('ignores lines without payload.rate_limits and invalid JSON', () => {
        assert.strictEqual(parseCodexRateLimitLine('{"type":"event_msg","payload":{"type":"token_count"}}'), undefined);
        assert.strictEqual(parseCodexRateLimitLine('not json'), undefined);
    });

    test('ignores records with an unparsable timestamp', () => {
        const rec = JSON.parse(line);
        delete rec.timestamp;
        assert.strictEqual(parseCodexRateLimitLine(JSON.stringify(rec)), undefined);
    });
});

suite('limits: claude usage response parsing', () => {
    test('extracts five_hour and seven_day windows', () => {
        const limits = parseClaudeUsageResponse({
            five_hour: { utilization: 5.0, resets_at: '2026-07-11T07:40:00.407275+00:00' },
            seven_day: { utilization: 8.0, resets_at: '2026-07-15T05:00:00.407296+00:00' },
        }, NOW_MS, 'max');
        assert.ok(limits);
        assert.strictEqual(limits.primary?.usedPercent, 5);
        assert.strictEqual(limits.primary?.resetsAtMs, Date.parse('2026-07-11T07:40:00.407275+00:00'));
        assert.strictEqual(limits.primary?.windowMinutes, 300);
        assert.strictEqual(limits.secondary?.usedPercent, 8);
        assert.strictEqual(limits.secondary?.windowMinutes, 10080);
        assert.strictEqual(limits.planType, 'max');
        assert.strictEqual(limits.asOfMs, NOW_MS);
    });

    test('returns undefined when no window is present', () => {
        assert.strictEqual(parseClaudeUsageResponse({}, NOW_MS), undefined);
        assert.strictEqual(parseClaudeUsageResponse(null, NOW_MS), undefined);
        assert.strictEqual(parseClaudeUsageResponse({ five_hour: { utilization: 'x' } }, NOW_MS), undefined);
    });
});

suite('limits: staleness clamp', () => {
    test('a window past its reset time reads as 0% used', () => {
        const stale: ProviderLimits = {
            primary: { usedPercent: 100, resetsAtMs: NOW_MS - 1000, windowMinutes: 10080 },
            secondary: { usedPercent: 19, resetsAtMs: NOW_MS + 1000 },
            asOfMs: NOW_MS - 6 * 3600_000,
        };
        const effective = effectiveLimits(stale, NOW_MS);
        assert.strictEqual(effective?.primary?.usedPercent, 0);
        assert.strictEqual(effective?.primary?.resetsAtMs, undefined);
        assert.strictEqual(effective?.primary?.windowMinutes, 10080);
        assert.strictEqual(effective?.secondary?.usedPercent, 19);
    });

    test('passes fresh limits through and undefined stays undefined', () => {
        const fresh: ProviderLimits = {
            primary: { usedPercent: 5, resetsAtMs: NOW_MS + 1000 },
            secondary: { usedPercent: 8, resetsAtMs: NOW_MS + 2000 },
            asOfMs: NOW_MS,
        };
        assert.deepStrictEqual(effectiveLimits(fresh, NOW_MS), fresh);
        assert.strictEqual(effectiveLimits(undefined, NOW_MS), undefined);
    });
});

suite('limits: window labels', () => {
    test('derives the label from the reported window length', () => {
        assert.strictEqual(limitWindowLabel({ usedPercent: 0, windowMinutes: 300 }, '7d'), '5h');
        assert.strictEqual(limitWindowLabel({ usedPercent: 0, windowMinutes: 10080 }, '5h'), '7d');
        assert.strictEqual(limitWindowLabel({ usedPercent: 0, windowMinutes: 1440 }, '5h'), '1d');
        assert.strictEqual(limitWindowLabel({ usedPercent: 0, windowMinutes: 90 }, '5h'), '90m');
    });

    test('falls back to the positional label when no length is reported', () => {
        assert.strictEqual(limitWindowLabel({ usedPercent: 0 }, '5h'), '5h');
        assert.strictEqual(limitWindowLabel({ usedPercent: 0, windowMinutes: 0 }, '7d'), '7d');
    });
});

suite('limits: formatting', () => {
    const limits: ProviderLimits = {
        primary: { usedPercent: 5, resetsAtMs: new Date(2026, 6, 11, 16, 40).getTime() },
        secondary: { usedPercent: 19, resetsAtMs: new Date(2026, 6, 15, 14, 0).getTime() },
        planType: 'max',
        asOfMs: NOW_MS,
    };

    test('limitsLines renders a header plus one line per window as separate rows', () => {
        const out = limitsLines(limits, NOW);
        assert.strictEqual(out, [
            '$(dashboard) **Limits** (max)',
            '5h · **5% used** · resets 16:40',
            '7d · **19% used** · resets 07-15 14:00',
        ].join('  \n'));
        assert.strictEqual(out?.split('  \n').length, 3);
    });

    test('limitsLines is localized', () => {
        const out = limitsLines(limits, NOW, new I18n('ja'));
        assert.ok(out?.includes('制限'));
        assert.ok(out?.includes('(max)'));
        assert.ok(out?.includes('5% 使用'));
        assert.ok(out?.includes('16:40 リセット'));
        assert.strictEqual(out?.split('  \n').length, 3);
    });

    test('limitsLines omits empty snapshots', () => {
        assert.strictEqual(limitsLines(undefined, NOW), undefined);
        assert.strictEqual(limitsLines({ asOfMs: NOW_MS }, NOW), undefined);
    });

    test('limitsLines joins with a custom separator for table cells', () => {
        const out = limitsLines(limits, NOW, undefined, '<br>');
        assert.strictEqual(out?.split('<br>').length, 3);
        assert.ok(!out?.includes('  \n'));
    });

    test('limitsLines labels windows by their reported length, not their slot', () => {
        // Codex plans without a session limit put the weekly window in primary.
        const weeklyPrimary: ProviderLimits = {
            primary: { usedPercent: 2, resetsAtMs: new Date(2026, 6, 20, 9, 0).getTime(), windowMinutes: 10080 },
            planType: 'pro',
            asOfMs: NOW_MS,
        };
        const out = limitsLines(weeklyPrimary, NOW);
        assert.strictEqual(out, [
            '$(dashboard) **Limits** (pro)',
            '7d · **2% used** · resets 07-20 09:00',
        ].join('  \n'));
    });

    suite('statusBarText modes', () => {
        const emptySummary: ProviderSummary = { provider: 'claude', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] };
        const view = (limits?: ProviderLimits): ProviderView => ({
            summary: emptySummary,
            available: true,
            show: true,
            limits,
        });
        const claude = view({ primary: { usedPercent: 5 }, secondary: { usedPercent: 8 }, asOfMs: NOW_MS });
        const codex = view({ primary: { usedPercent: 100 }, secondary: { usedPercent: 19 }, asOfMs: NOW_MS });

        test('cost mode is the default and shows only cost', () => {
            assert.strictEqual(statusBarText(claude, codex, 'today', false), '$0.00');
            assert.strictEqual(statusBarText(claude, codex, 'today', false, 'cost'), '$0.00');
        });

        test('limits mode shows the longer window percentage per provider', () => {
            assert.strictEqual(statusBarText(claude, codex, 'today', false, 'limits'), '$(otak-claude) 8% $(otak-openai) 19%');
        });

        test('costAndLimits mode shows cost then percentages', () => {
            assert.strictEqual(statusBarText(claude, codex, 'today', false, 'costAndLimits'), '$0.00  $(otak-claude) 8% $(otak-openai) 19%');
        });

        test('falls back to the weekly window when a snapshot has no 5-hour data', () => {
            const weeklyOnly = view({ secondary: { usedPercent: 42 }, asOfMs: NOW_MS });
            assert.strictEqual(statusBarText(weeklyOnly, view(undefined), 'today', false, 'limits'), '$(otak-claude) 42%');
        });

        test('limits mode falls back to cost when no snapshot is available', () => {
            assert.strictEqual(statusBarText(view(undefined), view(undefined), 'today', false, 'limits'), '$0.00');
        });

        test('a provider without a snapshot contributes no segment', () => {
            assert.strictEqual(statusBarText(view(undefined), codex, 'today', false, 'costAndLimits'), '$0.00  $(otak-openai) 19%');
        });
    });

    suite('cycleStatusBarView', () => {
        test('cycles today cost → month cost → limits → today cost', () => {
            assert.deepStrictEqual(cycleStatusBarView('today', 'cost', true), { period: 'month', mode: 'cost' });
            assert.deepStrictEqual(cycleStatusBarView('month', 'cost', true), { period: 'month', mode: 'limits' });
            assert.deepStrictEqual(cycleStatusBarView('month', 'limits', true), { period: 'today', mode: 'cost' });
        });

        test('restores a user-configured costAndLimits after the limits view', () => {
            assert.deepStrictEqual(cycleStatusBarView('today', 'costAndLimits', true), { period: 'month', mode: 'costAndLimits' });
            assert.deepStrictEqual(cycleStatusBarView('month', 'costAndLimits', true), { period: 'month', mode: 'limits' });
            assert.deepStrictEqual(cycleStatusBarView('month', 'limits', true, 'costAndLimits'), { period: 'today', mode: 'costAndLimits' });
        });

        test('degrades to the plain period toggle when rate limits are disabled', () => {
            assert.deepStrictEqual(cycleStatusBarView('today', 'cost', false), { period: 'month', mode: 'cost' });
            assert.deepStrictEqual(cycleStatusBarView('month', 'cost', false), { period: 'today', mode: 'cost' });
        });

        test('a stale limits baseMode falls back to cost', () => {
            assert.deepStrictEqual(cycleStatusBarView('month', 'limits', true, 'limits'), { period: 'today', mode: 'cost' });
        });
    });

    suite('detectSubscriptionMode (first-run default)', () => {
        const withPlan = (planType?: string): ProviderLimits => ({ primary: { usedPercent: 5 }, planType, asOfMs: NOW_MS });

        test('a plan on either provider selects the limits view', () => {
            assert.strictEqual(detectSubscriptionMode(withPlan('max'), undefined), 'limits');
            assert.strictEqual(detectSubscriptionMode(undefined, withPlan('pro')), 'limits');
            assert.strictEqual(detectSubscriptionMode(withPlan('max'), withPlan('pro')), 'limits');
        });

        test('no snapshot or no plan yields undefined (keep the cost default)', () => {
            assert.strictEqual(detectSubscriptionMode(undefined, undefined), undefined);
            assert.strictEqual(detectSubscriptionMode(withPlan(undefined), withPlan(undefined)), undefined);
            assert.strictEqual(detectSubscriptionMode(withPlan(''), undefined), undefined);
        });
    });
});
