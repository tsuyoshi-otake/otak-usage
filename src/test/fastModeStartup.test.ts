import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import { writeTextFileIfChanged } from '../coordination/atomicFile';

/** Exercise the real controller queues and atomic files without user settings. */
function controllerFor(home: string, options: {
    enabled?: () => boolean;
    fence?: () => Promise<boolean>;
    readFile?: typeof fsp.readFile;
    writeFile?: typeof writeTextFileIfChanged;
} = {}) {
    const entry = path.join(__dirname, '..', 'extension.js');
    const realRequire = createRequire(entry);
    const exports: any = {};
    const errors: unknown[][] = [];
    const vscode = {
        window: { createStatusBarItem: () => ({}) }, StatusBarAlignment: { Right: 1 },
        ConfigurationTarget: { Global: 1 }, env: { language: 'en' },
        extensions: { getExtension() { } }, ExtensionKind: { UI: 1 },
    };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nexports.Controller = UsageController;', {
        exports,
        require: (name: string) => name === 'vscode' ? vscode
            : name === 'fs/promises' ? { ...fsp, readFile: options.readFile ?? fsp.readFile }
                : name === './coordination/atomicFile' ? {
                    ...realRequire(name), writeTextFileIfChanged: options.writeFile ?? writeTextFileIfChanged,
                } : realRequire(name),
        process, Error, console: { ...console, error: (...args: unknown[]) => errors.push(args) },
        setTimeout, clearTimeout, setInterval, clearInterval,
    }, { filename: entry });
    const controller = new exports.Controller({ globalState: {
        // Previous one-time migrations must not suppress a new startup reset.
        get: (_key: string, fallback: unknown) => fallback,
        update: async () => { throw new Error('Startup reset must not store a one-time marker'); },
    } });
    controller.config = () => ({ get: (key: string, fallback: unknown) =>
        key === 'disableFastModeOnStartup' ? (options.enabled?.() ?? true) : fallback });
    controller.claudeConfigDir = () => home;
    controller.codexHomeDir = () => home;
    controller.allowManagedFileCommit = options.fence ?? (async () => true);
    return { controller, errors };
}

suite('fast-mode startup migration #70', () => {
    let home: string;
    let claudePath: string;
    let codexPath: string;
    const enabledClaude = '{ "fastMode": true, "keep": 42 }\n';
    const enabledCodex = 'service_tier = "fast"\nmodel = "keep"\n[features]\nfast_mode = true\n';
    setup(() => {
        const taskTmpRoot = path.join(os.homedir(), 'tmp');
        fs.mkdirSync(taskTmpRoot, { recursive: true });
        home = fs.mkdtempSync(path.join(taskTmpRoot, 'otak-usage-fast-startup-'));
        claudePath = path.join(home, 'settings.json');
        codexPath = path.join(home, 'config.toml');
    });
    teardown(() => { fs.rmSync(home, { recursive: true, force: true }); });

    function enableBoth() {
        fs.writeFileSync(claudePath, enabledClaude);
        fs.writeFileSync(codexPath, enabledCodex);
    }

    function assertBothOff() {
        assert.strictEqual(JSON.parse(fs.readFileSync(claudePath, 'utf8')).fastMode, false);
        assert.match(fs.readFileSync(codexPath, 'utf8'), /fast_mode = false/);
        assert.doesNotMatch(fs.readFileSync(codexPath, 'utf8'), /service_tier/);
    }

    test('repeats for fresh startup instances and bypasses alert/optimization opt-outs', async () => {
        for (let startup = 0; startup < 2; startup++) {
            enableBoth();
            const { controller, errors } = controllerFor(home);
            assert.strictEqual(await controller.disableFastModeOnStartup(), true);
            assertBothOff();
            assert.deepStrictEqual(errors, []);
        }
    });

    test('setting false skips reads and writes; re-enabling applies on the next startup', async () => {
        enableBoth();
        let enabled = false;
        let reads = 0;
        const { controller } = controllerFor(home, {
            enabled: () => enabled,
            readFile: (async (...args: Parameters<typeof fsp.readFile>) => {
                reads++;
                return fsp.readFile(...args);
            }) as typeof fsp.readFile,
        });
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assert.strictEqual(reads, 0);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
        assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), enabledCodex);
        enabled = true;
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assertBothOff();
    });

    test('missing configs are not created and already-off configs are not rewritten', async () => {
        const { controller } = controllerFor(home);
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assert.deepStrictEqual(fs.readdirSync(home), []);
        fs.writeFileSync(claudePath, '{ "fastMode": false }\n');
        fs.writeFileSync(codexPath, '[features]\nfast_mode = false\n');
        const oldTime = new Date('2020-01-01T00:00:00Z');
        fs.utimesSync(claudePath, oldTime, oldTime);
        fs.utimesSync(codexPath, oldTime, oldTime);
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assert.strictEqual(fs.statSync(claudePath).mtimeMs, oldTime.getTime());
        assert.strictEqual(fs.statSync(codexPath).mtimeMs, oldTime.getTime());
    });

    test('a malformed provider leaves its bytes intact and does not block the other provider', async () => {
        enableBoth();
        fs.writeFileSync(claudePath, '{invalid');
        const { controller, errors } = controllerFor(home);
        assert.strictEqual(await controller.disableFastModeOnStartup(), false);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), '{invalid');
        assert.match(fs.readFileSync(codexPath, 'utf8'), /fast_mode = false/);
        assert.strictEqual(errors.length, 1);
        // The queue remains usable after repair, with no completed marker.
        fs.writeFileSync(claudePath, enabledClaude);
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assertBothOff();
    });

    test('a read failure remains observable and can retry after repair', async () => {
        enableBoth();
        let fail = true;
        const { controller, errors } = controllerFor(home, {
            readFile: (async (...args: Parameters<typeof fsp.readFile>) => {
                if (args[0] === claudePath && fail) {
                    throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
                }
                return fsp.readFile(...args);
            }) as typeof fsp.readFile,
        });
        assert.strictEqual(await controller.disableFastModeOnStartup(), false);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
        assert.strictEqual(errors.length, 1);
        fail = false;
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assertBothOff();
    });

    test('a write failure preserves the file, completes the other provider and permits retry', async () => {
        enableBoth();
        let fail = true;
        const { controller, errors } = controllerFor(home, {
            writeFile: async (filePath, tag, current, next) => {
                if (filePath === claudePath && fail) {
                    throw Object.assign(new Error('injected write EACCES'), { code: 'EACCES' });
                }
                return writeTextFileIfChanged(filePath, tag, current, next);
            },
        });
        assert.strictEqual(await controller.disableFastModeOnStartup(), false);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
        assert.match(fs.readFileSync(codexPath, 'utf8'), /fast_mode = false/);
        assert.strictEqual(errors.length, 1);
        fail = false;
        assert.strictEqual(await controller.disableFastModeOnStartup(), true);
        assertBothOff();
        assert.deepStrictEqual(fs.readdirSync(home).sort(), ['config.toml', 'settings.json']);
    });

    test('malformed Codex TOML remains unchanged while the Claude reset completes', async () => {
        enableBoth();
        fs.writeFileSync(codexPath, 'service_tier = "unterminated');
        const { controller, errors } = controllerFor(home);
        assert.strictEqual(await controller.disableFastModeOnStartup(), false);
        assert.strictEqual(JSON.parse(fs.readFileSync(claudePath, 'utf8')).fastMode, false);
        assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), 'service_tier = "unterminated');
        assert.strictEqual(errors.length, 1);
    });

    test('opting out while a file is being read prevents its commit', async () => {
        enableBoth();
        let enabled = true;
        const { controller } = controllerFor(home, {
            enabled: () => enabled,
            readFile: (async (...args: Parameters<typeof fsp.readFile>) => {
                const text = await fsp.readFile(...args);
                enabled = false;
                return text;
            }) as typeof fsp.readFile,
        });
        assert.strictEqual(await controller.disableFastModeOnStartup(), false);
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
        assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), enabledCodex);
    });

    test('a follower or a writer losing its fence cannot change enabled files', async () => {
        for (const allowFirstRead of [false, true]) {
            enableBoth();
            let calls = 0;
            const { controller } = controllerFor(home, {
                fence: async () => allowFirstRead && ++calls <= 2,
            });
            assert.strictEqual(await controller.disableFastModeOnStartup(), false);
            assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
            assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), enabledCodex);
        }
    });

    test('queued provider writes finish before reset; opting out while queued skips reset', async () => {
        for (const optOut of [false, true]) {
            enableBoth();
            let enabled = true;
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const { controller } = controllerFor(home, { enabled: () => enabled });
            controller.claudeConfigSyncQueue = gate.then(() => {
                fs.writeFileSync(claudePath, '{ "fastMode": true, "newHook": "keep" }\n');
            });
            const reset = controller.disableFastModeOnStartup();
            enabled = !optOut;
            release();
            assert.strictEqual(await reset, !optOut);
            const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
            assert.strictEqual(claude.newHook, 'keep');
            assert.strictEqual(claude.fastMode, optOut);
        }
    });

    test('role acquisition schedules reset and the leader tick awaits it', async () => {
        enableBoth();
        const { controller } = controllerFor(home);
        controller.loadCache = () => undefined;
        controller.syncClaudeOptimize = async () => true;
        controller.syncCodexOptimize = async () => true;
        controller.syncCodexModelFeatures = async () => true;
        controller.syncHookFeatures = async () => true;
        controller.ensureRole = async () => controller.setLeader(true);
        let ticks = 0;
        controller.leaderTick = async () => { assertBothOff(); ticks++; };
        await controller.performTick();
        assert.strictEqual(ticks, 1);
        // A regular tick must not undo a deliberate mid-session re-enable.
        enableBoth();
        controller.leaderTick = async () => { ticks++; };
        await controller.performTick();
        assert.strictEqual(fs.readFileSync(claudePath, 'utf8'), enabledClaude);
        assert.strictEqual(fs.readFileSync(codexPath, 'utf8'), enabledCodex);
        assert.strictEqual(ticks, 2);
    });
});
