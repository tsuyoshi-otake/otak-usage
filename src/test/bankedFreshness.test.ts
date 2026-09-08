import * as assert from 'assert';
import { effectiveLimits, withCodexBankedResets, LIMITS_FRESHNESS_MS } from '../limits';

suite('independent banked freshness #60', () => {
    const now = 1_900_000_000_000;
    const old = now - LIMITS_FRESHNESS_MS - 1;
    test('fresh count survives expired windows, including follower serialization', () => {
        const combined = withCodexBankedResets({ asOfMs: old, primary: { usedPercent: 90 } }, undefined, 4, now);
        const effective = effectiveLimits(JSON.parse(JSON.stringify(combined)), now);
        assert.strictEqual(effective?.bankedResets, 4);
        assert.strictEqual(effective?.primary, undefined);
    });
    test('banked-only updates refresh zero, failures do not extend freshness', () => {
        const previous = withCodexBankedResets(undefined, undefined, 2, old);
        const updated = withCodexBankedResets(undefined, previous, 0, now);
        assert.strictEqual(effectiveLimits(updated, now)?.bankedResets, 0);
        const failed = withCodexBankedResets(undefined, updated, undefined, now + LIMITS_FRESHNESS_MS + 1);
        assert.strictEqual(effectiveLimits(failed, now + LIMITS_FRESHNESS_MS + 1), undefined);
    });
    test('fresh windows do not revive a stale retained count', () => {
        const updated = withCodexBankedResets({ asOfMs: now, primary: { usedPercent: 20 } }, { asOfMs: old, bankedResets: 2 }, undefined, now);
        const effective = effectiveLimits(updated, now);
        assert.strictEqual(effective?.primary?.usedPercent, 20);
        assert.strictEqual(effective?.bankedResets, undefined);
    });
});
