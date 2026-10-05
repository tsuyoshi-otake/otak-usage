import * as assert from 'assert';
import { FastModeState, claudeFastActive, codexFastModeEnabled, disableClaudeFastModeJson, disableCodexFastModeToml, isValidFastModeState, newlyActiveFastProviders } from '../fastMode';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { DayBuckets, TokenUsage, emptyUsage } from '../types';

function usage(tokens: number): TokenUsage {
    return { ...emptyUsage(), output: tokens };
}

suite('fastMode', () => {
    suite('startup reset #70', () => {
        test('turns off Claude preference while preserving other settings and CRLF', () => {
            const source = '{\r\n\t"fastMode": true,\r\n\t"fastModePerSessionOptIn": false,\r\n\t"env": { "KEEP": "1" },\r\n\t"hooks": { "Stop": [] }\r\n}\r\n';
            const result = disableClaudeFastModeJson(source);
            assert.deepStrictEqual(JSON.parse(result), { ...JSON.parse(source), fastMode: false });
            assert.match(result, /\r\n\t"fastMode": false/);
            assert.strictEqual(result.replace(/\r\n/g, '').includes('\n'), false);
            assert.strictEqual(disableClaudeFastModeJson(result), result);
        });

        test('leaves off, unset and nonboolean Claude values byte-for-byte unchanged', () => {
            for (const source of ['{}', '{ "fastMode": false }', '{ "fastMode": "true" }']) {
                assert.strictEqual(disableClaudeFastModeJson(source), source);
            }
            for (const source of ['', '{', '[]', 'null', 'true']) {
                assert.throws(() => disableClaudeFastModeJson(source));
            }
        });

        for (const source of [
            'service_tier = "fast" # fast default\r\nmodel = "keep"\r\n[features]\r\nfast_mode = true # speed\r\nother = true\r\n',
            '"service_tier" = "priority"\nfeatures."fast_mode" = true\n',
            'features = { fast_mode = true, keep = "yes" }\n',
            'profiles = { "work.profile" = { service_tier = "fast", features = { fast_mode = true, keep = 1 } } }\n',
            '[profiles."work.profile"]\nservice_tier = "fast"\nmodel = "keep"\n[profiles."work.profile".features]\nfast_mode = true\n',
        ]) {
            test(`resets real Codex syntax and preserves unrelated values: ${source.slice(0, 45)}`, () => {
                const result = disableCodexFastModeToml(source);
                const before = getStaticTOMLValue(parseTOML(source)) as any;
                const after = getStaticTOMLValue(parseTOML(result)) as any;
                assert.strictEqual(after.service_tier, undefined);
                assert.strictEqual(after.features?.fast_mode, before.features ? false : undefined);
                assert.strictEqual(after.model, before.model);
                assert.strictEqual(after.features?.other, before.features?.other);
                assert.strictEqual(after.features?.keep, before.features?.keep);
                if (before.profiles) {
                    const profile = after.profiles['work.profile'];
                    assert.strictEqual(profile.service_tier, undefined);
                    assert.strictEqual(profile.features.fast_mode, false);
                    assert.strictEqual(profile.model, before.profiles['work.profile'].model);
                    assert.strictEqual(profile.features.keep, before.profiles['work.profile'].features.keep);
                }
                if (source.includes('# speed')) {
                    assert.match(result, /fast_mode = false # speed/);
                    assert.strictEqual(result.replace(/\r\n/g, '').includes('\n'), false);
                }
                assert.strictEqual(disableCodexFastModeToml(result), result);
            });
        }

        test('resets all Codex profiles without touching other service tiers or string lookalikes', () => {
            const source = 'service_tier = "flex"\nfeatures.fast_mode = false\n'
                + 'instructions = """\nservice_tier = "fast"\n[features]\nfast_mode = true\n"""\n'
                + '[profiles.one]\nservice_tier = "fast"\n[profiles.two]\nservice_tier = "priority"\n'
                + '[profiles.three]\nservice_tier = "flex"\n';
            const result = disableCodexFastModeToml(source);
            const before = getStaticTOMLValue(parseTOML(source)) as any;
            const after = getStaticTOMLValue(parseTOML(result)) as any;
            assert.strictEqual(after.service_tier, 'flex');
            assert.strictEqual(after.instructions, before.instructions);
            assert.strictEqual(after.profiles.one.service_tier, undefined);
            assert.strictEqual(after.profiles.two.service_tier, undefined);
            assert.strictEqual(after.profiles.three.service_tier, 'flex');
        });

        test('leaves missing/off Codex values unchanged and rejects invalid TOML', () => {
            for (const source of ['', 'model = "keep"\n', 'features.fast_mode = false\n', 'service_tier = "default"\n',
                'instructions = "fast_mode = true"\n']) {
                assert.strictEqual(disableCodexFastModeToml(source), source);
            }
            for (const source of ['service_tier = "unterminated', 'features.fast_mode=true\nfeatures.fast_mode=false']) {
                assert.throws(() => disableCodexFastModeToml(source));
            }
        });
    });

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
