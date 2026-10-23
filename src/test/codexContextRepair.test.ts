import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

suite('Codex context-management repair #75', () => {
    let home: string;
    let file: string;
    let controller: any;
    let state: Map<string, unknown>;
    let desired: boolean;
    let fence: boolean;
    let failWrite: boolean;
    let afterRead: () => void;
    let writes: number;
    const original = 'model = "chosen"\nmodel_context_window = 400000\n'
        + 'model_auto_compact_token_limit = 300000\n[features]\nfast_mode = false\n'
        + '[features.context_management]\nexperimental_mode = true\n';

    setup(() => {
        const tmp = path.join(os.homedir(), 'tmp');
        fs.mkdirSync(tmp, { recursive: true });
        home = fs.mkdtempSync(path.join(tmp, 'otak-usage-context-repair-'));
        file = path.join(home, 'config.toml');
        state = new Map([['otakUsage.codexDefaultModelMigrated', true]]);
        desired = false; fence = true; failWrite = false; writes = 0;
        afterRead = () => {};
        const entry = path.join(__dirname, '..', 'extension.js');
        const realRequire = createRequire(entry);
        const exports: any = {};
        const vscode = {
            window: { createStatusBarItem: () => ({}) }, StatusBarAlignment: { Right: 1 },
            env: { language: 'en' }, extensions: { getExtension() {} }, ExtensionKind: { UI: 1 },
        };
        vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nexports.Controller = UsageController;', {
            exports, require: (name: string) => name === 'vscode' ? vscode
                : name === 'fs/promises' ? { ...fsp, readFile: async (...args: Parameters<typeof fsp.readFile>) => {
                    const result = await fsp.readFile(...args); afterRead(); return result;
                } } : name === './coordination/atomicFile' ? {
                    ...realRequire(name), writeTextFileIfChanged: async (...args: unknown[]) => {
                        if (failWrite) { throw new Error('injected write failure'); }
                        writes++;
                        return realRequire(name).writeTextFileIfChanged(...args);
                    },
                } : realRequire(name),
            process, Error, console: { ...console, error: () => {} },
            setTimeout, clearTimeout, setInterval, clearInterval,
        }, { filename: entry });
        controller = new exports.Controller({ globalState: {
            get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
            update: async (key: string, value: unknown) => { state.set(key, value); },
        } });
        controller.config = () => ({
            get: (key: string, fallback: unknown) => key === 'optimizeCodexContext' ? desired : fallback,
            inspect: () => undefined,
        });
        controller.codexHomeDir = () => home;
        controller.allowManagedFileCommit = async () => fence;
    });
    teardown(() => fs.rmSync(home, { recursive: true, force: true }));

    test('repairs with optimization off and no ownership marker, once across queued syncs', async () => {
        fs.writeFileSync(file, original);
        const results = await Promise.all([controller.syncCodexOptimize(false), controller.syncCodexOptimize(false)]);
        assert.deepStrictEqual(results, [true, true]);
        const parsed = getStaticTOMLValue(parseTOML(fs.readFileSync(file, 'utf8'))) as any;
        assert.strictEqual(parsed.features.context_management, undefined);
        assert.strictEqual(parsed.features.fast_mode, false);
        assert.strictEqual(parsed.model, 'chosen');
        assert.strictEqual(parsed.model_context_window, 400000);
        assert.strictEqual(parsed.model_auto_compact_token_limit, 300000);
        assert.strictEqual(writes, 1);
        assert.strictEqual(state.has('otakUsage.codexOptimizeApplied'), false);
    });
    test('opt-in and opt-out never regenerate the legacy feature', async () => {
        fs.writeFileSync(file, original);
        desired = true;
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
        let parsed = getStaticTOMLValue(parseTOML(fs.readFileSync(file, 'utf8'))) as any;
        assert.strictEqual(parsed.model_context_window, 320000);
        assert.strictEqual(parsed.features.context_management, undefined);
        desired = false;
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
        parsed = getStaticTOMLValue(parseTOML(fs.readFileSync(file, 'utf8'))) as any;
        assert.strictEqual(parsed.model_context_window, undefined);
        assert.strictEqual(parsed.model_auto_compact_token_limit, undefined);
        assert.strictEqual(parsed.features.context_management, undefined);
    });
    test('does not create a missing file when opted out', async () => {
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
        assert.strictEqual(fs.existsSync(file), false);
        assert.strictEqual(writes, 0);
    });
    test('failed write remains observable and retries without a completion marker', async () => {
        fs.writeFileSync(file, original);
        failWrite = true;
        assert.strictEqual(await controller.syncCodexOptimize(false), false);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        failWrite = false;
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /context_management/);
    });
    test('a lost fence during read prevents commit and retries on the next sync', async () => {
        fs.writeFileSync(file, original);
        afterRead = () => { fence = false; };
        assert.strictEqual(await controller.syncCodexOptimize(false), false);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        assert.strictEqual(writes, 0);
        afterRead = () => {}; fence = true;
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
    });
    test('invalid TOML stays unchanged and retries after external correction', async () => {
        fs.writeFileSync(file, '[broken');
        assert.strictEqual(await controller.syncCodexOptimize(false), false);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '[broken');
        fs.writeFileSync(file, original);
        assert.strictEqual(await controller.syncCodexOptimize(false), true);
    });
});
