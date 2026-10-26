import * as assert from 'assert';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { migrateCodexDefaultModelToml } from '../codexOptimize';

suite('Codex Terra medium model migration #76', () => {
    test('forces both defaults regardless of the previous model and effort', () => {
        for (const source of ['', 'model = "gpt-6-luna"\n', 'model = "custom-model"\nmodel_reasoning_effort = "max"\n',
            'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n']) {
            const next = migrateCodexDefaultModelToml(source);
            const parsed = getStaticTOMLValue(parseTOML(next)) as any;
            assert.strictEqual(parsed.model, 'gpt-6.1-terra');
            assert.strictEqual(parsed.model_reasoning_effort, 'medium');
            assert.strictEqual(migrateCodexDefaultModelToml(next), next);
        }
    });

    test('preserves comments, CRLF, unrelated keys, and model-like string contents', () => {
        const source = '# config\r\n"model" = "chosen" # keep comment\r\n'
            + 'model_reasoning_effort = "high" # effort\r\n'
            + 'instructions = """model = \'example\'\r\nmodel_reasoning_effort = \'max\'"""\r\n'
            + '[features]\r\nother = true\r\n';
        assert.strictEqual(migrateCodexDefaultModelToml(source), source
            .replace('"chosen"', '"gpt-6.1-terra"').replace('"high"', '"medium"'));
    });

    test('migrates explicit profile overrides in table, dotted and inline forms', () => {
        for (const source of [
            'profile = "work.profile"\n[profiles."work.profile"]\nmodel = "custom"\nmodel_reasoning_effort = "max"\nother = true\n[profiles.inherited]\nother = false\n',
            'profile = "work.profile"\nprofiles."work.profile".model = "custom"\nprofiles."work.profile".model_reasoning_effort = "max"\nprofiles."work.profile".other = true\nprofiles.inherited.other = false\n',
            'profile = "work.profile"\nprofiles = { "work.profile" = { model = "custom", model_reasoning_effort = "max", other = true }, inherited = { other = false } }\n',
        ]) {
            const next = migrateCodexDefaultModelToml(source);
            const parsed = getStaticTOMLValue(parseTOML(next)) as any;
            assert.strictEqual(parsed.profile, 'work.profile');
            assert.deepStrictEqual(parsed.profiles['work.profile'], { model: 'gpt-6.1-terra', model_reasoning_effort: 'medium', other: true });
            assert.deepStrictEqual(parsed.profiles.inherited, { other: false });
            assert.strictEqual(migrateCodexDefaultModelToml(next), next);
        }
    });

    test('half-configured profiles inherit the missing value from the root', () => {
        const next = migrateCodexDefaultModelToml('[profiles.modelOnly]\nmodel = "old"\n[profiles.effortOnly]\nmodel_reasoning_effort = "high"\n');
        const parsed = getStaticTOMLValue(parseTOML(next)) as any;
        assert.deepStrictEqual(parsed.profiles.modelOnly, { model: 'gpt-6.1-terra' });
        assert.deepStrictEqual(parsed.profiles.effortOnly, { model_reasoning_effort: 'medium' });
    });

    test('rejects malformed or structurally conflicting TOML before any write', () => {
        for (const source of ['[broken', 'model = "a"\nmodel = "b"\n', '[model]\nchild = true\n']) {
            assert.throws(() => migrateCodexDefaultModelToml(source));
        }
    });
});
