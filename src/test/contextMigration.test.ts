import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';

suite('Codex context default migration #69', () => {
    test('retries the previous generation once, then preserves a later 180k choice', async () => {
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
            process, console, setTimeout, clearTimeout, setInterval, clearInterval,
        }, { filename: entry });

        const state = new Map<string, number>([['otakUsage.codexContextDefaultMigration', 5]]);
        const values = new Map<string, number>([
            ['codexContextWindow', 180000],
            ['codexAutoCompactLimit', 150000],
        ]);
        const controller = new exports.Controller({ globalState: {
            get: (key: string, fallback: number) => state.get(key) ?? fallback,
            update: async (key: string, value: number) => { state.set(key, value); },
        } });
        controller.config = () => ({
            inspect: (key: string) => ({ globalValue: values.get(key) }),
            update: async (key: string, value: number | undefined) => {
                if (value === undefined) {
                    values.delete(key);
                } else {
                    values.set(key, value);
                }
            },
        });

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-context-migration-'));
        const configPath = path.join(home, 'config.toml');
        fs.writeFileSync(configPath,
            'model_context_window = 180000\nmodel_auto_compact_token_limit = 150000\n'
            + '[features.context_management]\nexperimental_mode = true\n');
        controller.codexHomeDir = () => home;
        try {
            await controller.migrateCodexContextDefaults();
            assert.strictEqual(state.get('otakUsage.codexContextDefaultMigration'), 6);
            assert.strictEqual(values.has('codexContextWindow'), false);
            assert.strictEqual(values.has('codexAutoCompactLimit'), false);

            values.set('codexContextWindow', 180000);
            values.set('codexAutoCompactLimit', 150000);
            await controller.migrateCodexContextDefaults();
            assert.strictEqual(values.get('codexContextWindow'), 180000);
            assert.strictEqual(values.get('codexAutoCompactLimit'), 150000);
        } finally {
            fs.unlinkSync(configPath);
            fs.rmdirSync(home);
        }
    });
});
