import * as assert from 'assert';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { applyCodexOptimizeToml, removeCodexOptimizeToml, removeLegacyCodexContextManagementToml } from '../codexOptimize';

suite('TOML structural edits #58', () => {
    const values = { contextWindow: 250000, autoCompactLimit: 212500 };
    for (const source of [
        '[features]\ncontext_management = { experimental_mode = false, keep = true }\n',
        '"model_context_window" = 100000\nmodel_auto_compact_token_limit = 85000\n',
        'instructions = """\n[features.context_management]\nexperimental_mode = false\n"""\n',
        "instructions = '''\n[features.context_management]\nexperimental_mode = false\n'''\n",
        'features = { context_management = { keep = true } }\n',
    ]) {
        test(`preserves unrelated values and is idempotent: ${source.slice(0, 40)}`, () => {
            const input = getStaticTOMLValue(parseTOML(source)) as any;
            const result = applyCodexOptimizeToml(source, values);
            const parsed = getStaticTOMLValue(parseTOML(result)) as any;
            assert.strictEqual(parsed.model_context_window, values.contextWindow);
            assert.strictEqual(parsed.features?.context_management?.experimental_mode, undefined);
            assert.strictEqual(parsed.instructions, input.instructions);
            assert.strictEqual(parsed.features?.context_management?.keep, input.features?.context_management?.keep);
            assert.strictEqual(applyCodexOptimizeToml(result, values), result);
            const removed = removeCodexOptimizeToml(result);
            const restored = getStaticTOMLValue(parseTOML(removed)) as any;
            assert.strictEqual(restored.instructions, input.instructions);
            assert.strictEqual(restored.features?.context_management?.experimental_mode, undefined);
            assert.strictEqual(removeCodexOptimizeToml(removed), removed);
        });
    }
    test('rejects invalid input before returning a write', () => {
        for (const source of ['model = "unterminated', 'model=1\nmodel=2']) {
            assert.throws(() => applyCodexOptimizeToml(source, values));
        }
    });

    for (const legacy of [
        '[features.context_management]\nexperimental_mode = true\n',
        '["features"."context_management"]\n"experimental_mode" = false\n',
        'features.context_management.experimental_mode = true\n',
        '[features]\ncontext_management.experimental_mode = true\n',
        'features = { context_management = { experimental_mode = true } }\n',
        '[features]\ncontext_management = { experimental_mode = false }\n',
        '[features.context_management]\n# already empty\n',
        'features = { context_management = {} }\n',
    ]) {
        test(`repairs the legacy map, preserving numeric settings: ${legacy.trim()}`, () => {
            const source = 'model_context_window = 400000\nmodel_auto_compact_token_limit = 300000\n' + legacy;
            for (const eol of ['\n', '\r\n']) {
                const result = removeLegacyCodexContextManagementToml(source.replace(/\n/g, eol));
                const parsed = getStaticTOMLValue(parseTOML(result)) as any;
                assert.strictEqual(parsed.features?.context_management, undefined);
                assert.strictEqual(parsed.model_context_window, 400000);
                assert.strictEqual(parsed.model_auto_compact_token_limit, 300000);
                assert.strictEqual(removeLegacyCodexContextManagementToml(result), result);
                if (eol === '\r\n') { assert.doesNotMatch(result, /(?<!\r)\n/); }
            }
        });
    }
    test('keeps comments between the removed table header and flag', () => {
        const source = '[features.context_management]\n# keep this note\nexperimental_mode = true\n';
        assert.strictEqual(removeLegacyCodexContextManagementToml(source), '# keep this note\n');
    });
    for (const source of [
        '[features]\ncontext_management = true\n',
        'features = { context_management = false, fast_mode = true }\n',
        'features = false\n',
        'instructions = """\n[features.context_management]\nexperimental_mode = true\n"""\n',
        '[profiles.custom.features.context_management]\nexperimental_mode = true\n',
        '[features.context_management.custom]\nkeep = true\n',
    ]) {
        test(`does not reinterpret unrelated values: ${source.trim()}`, () => {
            assert.strictEqual(removeLegacyCodexContextManagementToml(source), source);
        });
    }
});
