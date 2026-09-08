import * as assert from 'assert';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { applyCodexOptimizeToml, removeCodexOptimizeToml } from '../codexOptimize';

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
            assert.strictEqual(parsed.features.context_management.experimental_mode, true);
            assert.strictEqual(parsed.instructions, input.instructions);
            assert.strictEqual(parsed.features.context_management.keep, input.features?.context_management?.keep);
            assert.strictEqual(applyCodexOptimizeToml(result, values), result);
            const removed = removeCodexOptimizeToml(result);
            const restored = getStaticTOMLValue(parseTOML(removed)) as any;
            assert.strictEqual(restored.instructions, input.instructions);
            assert.strictEqual(restored.features?.context_management?.experimental_mode, undefined);
            assert.strictEqual(removeCodexOptimizeToml(removed), removed);
        });
    }
    test('rejects invalid input and scalar/table conflicts before returning a write', () => {
        for (const source of ['model = "unterminated', 'model=1\nmodel=2', 'features = false']) {
            assert.throws(() => applyCodexOptimizeToml(source, values));
        }
    });
});
