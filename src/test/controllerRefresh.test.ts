import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';

suite('controller refresh #62', () => {
    test('does not replace a busy cache and completes a new scan before resolving', async () => {
        const entry = path.join(__dirname, '..', 'extension.js');
        const realRequire = createRequire(entry);
        const exports: any = {};
        const vscode = {
            window: { createStatusBarItem: () => ({}) }, StatusBarAlignment: { Right: 1 },
            env: { language: 'en' }, extensions: { getExtension() { } }, ExtensionKind: { UI: 1 },
        };
        vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nexports.Controller = UsageController;', {
            exports, require: (name: string) => name === 'vscode' ? vscode : realRequire(name),
            process, console, setTimeout, clearTimeout, setInterval, clearInterval,
        }, { filename: entry });
        const controller = new exports.Controller({ globalState: { get: (_key: string, fallback: unknown) => fallback } });
        controller.leader = true;
        controller.ensureRole = async () => {};
        controller.clearPersistedCaches = async () => {};
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { started = resolve; });
        let scans = 0;
        controller.leaderTick = async () => {
            const cache = controller.cache;
            scans++;
            if (scans === 1) { started(); await gate; }
            cache.month = 'complete';
            controller.initialScanDone = true;
        };
        const first = controller.tick();
        await ready;
        const original = controller.cache;
        const refreshed = controller.refresh();
        assert.strictEqual(controller.refresh(), refreshed);
        await Promise.resolve();
        assert.strictEqual(controller.cache, original);
        release();
        await Promise.all([first, refreshed]);
        assert.notStrictEqual(controller.cache, original);
        assert.strictEqual(controller.cache.month, 'complete');
        assert.strictEqual(scans, 2);
    });
});
