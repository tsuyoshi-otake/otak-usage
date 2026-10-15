import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import { captureClaudeOptimizeBackup } from '../claudeOptimize';

suite('context default migration #74', () => {
    const codexMarker = 'otakUsage.codexContextDefaultMigration';
    const claudeMarker = 'otakUsage.claudeContextDefaultMigration';
    let home: string;
    let controller: any;
    let values: Map<string, unknown>;
    let state: Map<string, unknown>;
    let failSetting: string | undefined;
    let errors: unknown[][];
    const cachedDefaults: Record<string, unknown> = {
        codexContextWindow: 272000, codexAutoCompactLimit: 231200,
        claudeContextWindow: 250000, claudeAutoCompactPercent: 85,
    };

    setup(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-context-migration-'));
        fs.mkdirSync(path.join(home, 'codex'));
        fs.mkdirSync(path.join(home, 'claude'));
        values = new Map();
        state = new Map([[codexMarker, 6], [claudeMarker, 2]]);
        failSetting = undefined;
        errors = [];
        const entry = path.join(__dirname, '..', 'extension.js');
        const realRequire = createRequire(entry);
        const exports: any = {};
        const vscode = {
            window: { createStatusBarItem: () => ({}) }, StatusBarAlignment: { Right: 1 },
            ConfigurationTarget: { Global: 1 },
            env: { language: 'en' }, extensions: { getExtension() { } }, ExtensionKind: { UI: 1 },
        };
        vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nexports.Controller = UsageController;', {
            exports, require: (name: string) => name === 'vscode' ? vscode : realRequire(name),
            process, Error, console: { ...console, error: (...args: unknown[]) => errors.push(args) },
            setTimeout, clearTimeout, setInterval, clearInterval,
        }, { filename: entry });
        controller = new exports.Controller({ globalState: {
            get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
            update: async (key: string, value: unknown) => { state.set(key, value); },
        } });
        controller.config = () => ({
            // Simulate VS Code retaining the previous manifest after an update.
            get: (key: string, fallback: unknown) => values.get(key) ?? cachedDefaults[key] ?? fallback,
            inspect: (key: string) => ({ defaultValue: cachedDefaults[key], globalValue: values.get(key) }),
            update: async (key: string, value: unknown) => {
                if (key === failSetting) { throw new Error('injected configuration write failure'); }
                if (value === undefined) { values.delete(key); } else { values.set(key, value); }
            },
        });
        controller.codexHomeDir = () => path.join(home, 'codex');
        controller.claudeConfigDir = () => path.join(home, 'claude');
    });
    teardown(() => fs.rmSync(home, { recursive: true, force: true }));

    function setPreviousDefaults(): void {
        for (const [key, value] of Object.entries(cachedDefaults)) { values.set(key, value); }
    }

    test('migrates current generations once and resolves 320k despite cached manifest defaults', async () => {
        setPreviousDefaults();
        await Promise.all([controller.ensureContextDefaultsMigrated(), controller.ensureContextDefaultsMigrated()]);
        assert.strictEqual(state.get(codexMarker), 7);
        assert.strictEqual(state.get(claudeMarker), 3);
        assert.strictEqual(values.size, 0);
        assert.strictEqual(controller.currentCodexOptimizeValues().contextWindow, 320000);
        assert.strictEqual(controller.currentCodexOptimizeValues().autoCompactLimit, 272000);
        assert.strictEqual(controller.currentClaudeOptimizeValues().contextWindow, 320000);
        assert.strictEqual(controller.currentClaudeOptimizeValues().autoCompactPercent, 85);
        // A later explicit selection survives even if it was once a default.
        values.set('codexContextWindow', 180000);
        values.set('codexAutoCompactLimit', 150000);
        values.set('claudeContextWindow', 250000);
        values.set('claudeAutoCompactPercent', 85);
        await controller.migrateContextDefaults();
        assert.strictEqual(values.get('codexContextWindow'), 180000);
        assert.strictEqual(values.get('codexAutoCompactLimit'), 150000);
        assert.strictEqual(values.get('claudeContextWindow'), 250000);
        assert.strictEqual(values.get('claudeAutoCompactPercent'), 85);
    });

    test('retries the generation-5 correction and keeps a later compact choice (#69)', async () => {
        state.set(codexMarker, 5);
        values.set('codexContextWindow', 180000);
        values.set('codexAutoCompactLimit', 150000);
        fs.writeFileSync(path.join(home, 'codex', 'config.toml'),
            'model_context_window = 180000\nmodel_auto_compact_token_limit = 150000\n'
            + '[features.context_management]\nexperimental_mode = true\n');
        await controller.migrateCodexContextDefaults();
        assert.strictEqual(state.get(codexMarker), 7);
        assert.strictEqual(values.size, 0);
        values.set('codexContextWindow', 180000);
        values.set('codexAutoCompactLimit', 150000);
        await controller.migrateCodexContextDefaults();
        assert.strictEqual(values.get('codexContextWindow'), 180000);
        assert.strictEqual(values.get('codexAutoCompactLimit'), 150000);
    });

    for (const [generation, inheritedWindow, inheritedLimit] of [
        [0, 250000, 212500], [2, 250000, 212500], [3, 180000, 150000],
        [4, 180000, 150000], [5, 272000, 231200], [6, 272000, 231200],
    ]) {
        test(`preserves half-customized Codex settings from generation ${generation}`, async () => {
            state.set(codexMarker, generation);
            values.set('codexContextWindow', 400000);
            await controller.migrateCodexContextDefaults();
            assert.strictEqual(values.get('codexContextWindow'), 400000);
            assert.strictEqual(values.get('codexAutoCompactLimit'), inheritedLimit);
            state.set(codexMarker, generation);
            values.clear();
            values.set('codexAutoCompactLimit', 120000);
            await controller.migrateCodexContextDefaults();
            assert.strictEqual(values.get('codexContextWindow'), inheritedWindow);
            assert.strictEqual(values.get('codexAutoCompactLimit'), 120000);
        });
    }
    for (const [generation, inheritedWindow, inheritedPercent] of [[0, 240000, 90], [1, 240000, 90], [2, 250000, 85]]) {
        test(`preserves half-customized Claude settings from generation ${generation}`, async () => {
            state.set(claudeMarker, generation);
            values.set('claudeContextWindow', 400000);
            await controller.migrateClaudeContextDefaults();
            assert.strictEqual(values.get('claudeContextWindow'), 400000);
            assert.strictEqual(values.get('claudeAutoCompactPercent'), inheritedPercent);
            state.set(claudeMarker, generation);
            values.clear();
            values.set('claudeAutoCompactPercent', 70);
            await controller.migrateClaudeContextDefaults();
            assert.strictEqual(values.get('claudeContextWindow'), inheritedWindow);
            assert.strictEqual(values.get('claudeAutoCompactPercent'), 70);
        });
    }
    for (const provider of ['codex', 'claude'] as const) {
        test(`retries a partial ${provider} failure without blocking the other provider`, async () => {
            setPreviousDefaults();
            const marker = provider === 'codex' ? codexMarker : claudeMarker;
            const priorGeneration = state.get(marker);
            failSetting = provider === 'codex' ? 'codexAutoCompactLimit' : 'claudeAutoCompactPercent';
            await controller.migrateContextDefaults();
            assert.strictEqual(state.get(marker), priorGeneration);
            assert.strictEqual(state.get(provider === 'codex' ? claudeMarker : codexMarker), provider === 'codex' ? 3 : 7);
            assert.strictEqual(errors.length, 1);
            failSetting = undefined;
            await controller.migrateContextDefaults();
            assert.strictEqual(state.get(codexMarker), 7);
            assert.strictEqual(state.get(claudeMarker), 3);
            assert.strictEqual(values.size, 0);
        });
    }
    test('retries malformed TOML after repair while Claude migrates independently', async () => {
        setPreviousDefaults();
        const file = path.join(home, 'codex', 'config.toml');
        fs.writeFileSync(file, '[broken');
        await controller.migrateContextDefaults();
        assert.strictEqual(state.get(codexMarker), 6);
        assert.strictEqual(state.get(claudeMarker), 3);
        assert.strictEqual(errors.length, 1);
        fs.writeFileSync(file, 'model = "chosen"\n');
        await controller.migrateCodexContextDefaults();
        assert.strictEqual(state.get(codexMarker), 7);
    });
    test('applies migrated settings through both provider queues and preserves Claude rollback', async () => {
        setPreviousDefaults();
        const codexPath = path.join(home, 'codex', 'config.toml');
        const claudePath = path.join(home, 'claude', 'settings.json');
        fs.writeFileSync(codexPath, 'model = "chosen"\nmodel_context_window = 272000\n'
            + 'model_auto_compact_token_limit = 231200\n[features.context_management]\nexperimental_mode = true\n');
        const original = JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', OTHER: 'keep' } });
        state.set('otakUsage.claudeOptimizeOwnership', {
            version: 3, phase: 'applied', filePresent: true, backup: captureClaudeOptimizeBackup(original),
        });
        fs.writeFileSync(claudePath, JSON.stringify({ env: {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85', OTHER: 'keep',
        } }));
        await controller.ensureContextDefaultsMigrated();
        assert.strictEqual(await controller.syncCodexOptimize(false, false), true);
        assert.strictEqual(await controller.syncClaudeOptimize(false, false), true);
        const codex = fs.readFileSync(codexPath, 'utf8');
        assert.match(codex, /^model_context_window = 320000$/m);
        assert.match(codex, /^model_auto_compact_token_limit = 272000$/m);
        assert.match(codex, /^model = "chosen"$/m);
        const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
        assert.strictEqual(claude.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '320000');
        assert.strictEqual(claude.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '85');
        assert.strictEqual(claude.env.OTHER, 'keep');
        values.set('optimizeClaudeContext', false);
        assert.strictEqual(await controller.syncClaudeOptimize(false, false), true);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudePath, 'utf8')), JSON.parse(original));
        assert.strictEqual(errors.length, 0);
    });
    test('keeps providers opted out and leaves their configuration files unchanged', async () => {
        setPreviousDefaults();
        values.set('optimizeCodexContext', false);
        values.set('optimizeClaudeContext', false);
        const codexPath = path.join(home, 'codex', 'config.toml');
        const claudePath = path.join(home, 'claude', 'settings.json');
        const codex = 'model_context_window = 400000\n';
        const claude = '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"}}';
        fs.writeFileSync(codexPath, codex);
        fs.writeFileSync(claudePath, claude);
        await controller.ensureContextDefaultsMigrated();
        assert.strictEqual(await controller.syncCodexOptimize(false, false), true);
        assert.strictEqual(await controller.syncClaudeOptimize(false, false), true);
        assert.strictEqual(values.get('optimizeCodexContext'), false);
        assert.strictEqual(values.get('optimizeClaudeContext'), false);
        assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), codex);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), claude);
        assert.strictEqual(errors.length, 0);
    });
});
