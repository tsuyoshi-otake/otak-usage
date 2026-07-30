import * as assert from 'assert';
import { FastModeState, claudeFastActive, codexFastModeEnabled, isValidFastModeState, newlyActiveFastProviders } from '../fastMode';
import { DayBuckets, TokenUsage, emptyUsage } from '../types';

function usage(tokens: number): TokenUsage {
    return { ...emptyUsage(), output: tokens };
}

suite('fastMode', () => {
    suite('claudeFastActive', () => {
        test('fast usage today is detected', () => {
            const days: DayBuckets = {
                '2026-07-30': { 'claude/claude-opus-5-fast': usage(10) },
            };
            assert.strictEqual(claudeFastActive(days, '2026-07-30'), true);
        });

        test('dated fast model ids are detected', () => {
            const days: DayBuckets = {
                '2026-07-30': { 'claude/claude-opus-5-20260724-fast': usage(1) },
            };
            assert.strictEqual(claudeFastActive(days, '2026-07-30'), true);
        });

        test('non-fast usage, other days, and empty buckets are not', () => {
            const days: DayBuckets = {
                '2026-07-29': { 'claude/claude-opus-5-fast': usage(10) },
                '2026-07-30': {
                    'claude/claude-opus-5': usage(10),
                    'claude/claude-opus-5-fast': usage(0),
                },
            };
            assert.strictEqual(claudeFastActive(days, '2026-07-30'), false);
            assert.strictEqual(claudeFastActive({}, '2026-07-30'), false);
        });

        test('a codex model that happens to end in -fast does not count', () => {
            const days: DayBuckets = {
                '2026-07-30': { 'codex/gpt-5.5-fast': usage(10) },
            };
            assert.strictEqual(claudeFastActive(days, '2026-07-30'), false);
        });
    });

    suite('codexFastModeEnabled', () => {
        test('features table form', () => {
            assert.strictEqual(codexFastModeEnabled('model = "gpt-5.5"\n\n[features]\nfast_mode = true\n'), true);
            assert.strictEqual(codexFastModeEnabled('[features]\nfast_mode = false\n'), false);
        });

        test('dotted preamble form', () => {
            assert.strictEqual(codexFastModeEnabled('features.fast_mode = true\nmodel = "x"\n'), true);
        });

        test('whitespace, comments, and CRLF are tolerated', () => {
            assert.strictEqual(codexFastModeEnabled('[ features ]\r\n  fast_mode   =  true  # speed!\r\n'), true);
        });

        test('fast_mode outside [features] does not count', () => {
            assert.strictEqual(codexFastModeEnabled('fast_mode = true\n'), false);
            assert.strictEqual(codexFastModeEnabled('[other]\nfast_mode = true\n'), false);
            assert.strictEqual(codexFastModeEnabled('[features.sub]\nfast_mode = true\n'), false);
        });

        test('missing file content and empty text are off', () => {
            assert.strictEqual(codexFastModeEnabled(''), false);
        });
    });

    suite('newlyActiveFastProviders', () => {
        test('first observation notifies for whatever is on', () => {
            assert.deepStrictEqual(
                newlyActiveFastProviders({ claude: true, codex: true }, undefined),
                ['claude', 'codex'],
            );
            assert.deepStrictEqual(newlyActiveFastProviders({ claude: false, codex: false }, undefined), []);
        });

        test('only off → on transitions notify', () => {
            const prev: FastModeState = { claude: true, codex: false };
            assert.deepStrictEqual(newlyActiveFastProviders({ claude: true, codex: true }, prev), ['codex']);
            assert.deepStrictEqual(newlyActiveFastProviders({ claude: false, codex: false }, prev), []);
        });

        test('turning off re-arms the warning', () => {
            const off = newlyActiveFastProviders({ claude: false, codex: false }, { claude: true, codex: false });
            assert.deepStrictEqual(off, []);
            assert.deepStrictEqual(
                newlyActiveFastProviders({ claude: true, codex: false }, { claude: false, codex: false }),
                ['claude'],
            );
        });
    });

    suite('isValidFastModeState', () => {
        test('accepts the persisted shape and rejects everything else', () => {
            assert.strictEqual(isValidFastModeState({ claude: true, codex: false }), true);
            assert.strictEqual(isValidFastModeState(undefined), false);
            assert.strictEqual(isValidFastModeState(null), false);
            assert.strictEqual(isValidFastModeState({ claude: true }), false);
            assert.strictEqual(isValidFastModeState({ claude: 'true', codex: false }), false);
        });
    });
});
