import * as assert from 'assert';
import { SettingsBackend, SettingsStore } from '../settingsStore';

/** A settings backend whose writes can be made to fail like VS Code's do. */
class FakeBackend implements SettingsBackend {
    readonly saved = new Map<string, unknown>();
    writable = true;
    writes = 0;

    get<T>(key: string, fallback: T): T {
        return this.saved.has(key) ? this.saved.get(key) as T : fallback;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.writes++;
        if (!this.writable) {
            throw new Error(`Unable to write to User Settings because otakUsage.${key} is not a registered configuration.`);
        }
        this.saved.set(key, value);
    }
}

suite('settingsStore', () => {
    test('reads the persisted value and writes through', async () => {
        const backend = new FakeBackend();
        const store = new SettingsStore(backend);

        assert.strictEqual(store.get('statusBarMode', 'cost'), 'cost');
        assert.strictEqual(await store.set('statusBarMode', 'limits'), true);
        assert.strictEqual(store.get('statusBarMode', 'cost'), 'limits');
        assert.strictEqual(backend.saved.get('statusBarMode'), 'limits');
        assert.deepStrictEqual(store.unsavedKeys(), []);
    });

    test('keeps a refused write in memory instead of throwing', async () => {
        const backend = new FakeBackend();
        backend.writable = false;
        const failures: string[] = [];
        const store = new SettingsStore(backend, (key) => failures.push(key));

        assert.strictEqual(await store.set('statusBarMode', 'limits'), false);
        assert.strictEqual(store.get('statusBarMode', 'cost'), 'limits');
        assert.strictEqual(backend.saved.has('statusBarMode'), false);
        assert.deepStrictEqual(store.unsavedKeys(), ['statusBarMode']);
        assert.deepStrictEqual(failures, ['statusBarMode']);
    });

    test('an in-memory value keeps cycling while writes stay refused', async () => {
        const backend = new FakeBackend();
        backend.writable = false;
        const store = new SettingsStore(backend);

        await store.set('period', 'month');
        assert.strictEqual(store.get('period', 'today'), 'month');
        await store.set('period', 'today');
        assert.strictEqual(store.get('period', 'today'), 'today');
        assert.strictEqual(backend.writes, 2);
    });

    test('a write that succeeds later drops the in-memory value', async () => {
        const backend = new FakeBackend();
        backend.writable = false;
        const store = new SettingsStore(backend);

        await store.set('statusBarMode', 'limits');
        backend.writable = true;
        assert.strictEqual(await store.set('statusBarMode', 'costAndLimits'), true);

        assert.deepStrictEqual(store.unsavedKeys(), []);
        assert.strictEqual(store.get('statusBarMode', 'cost'), 'costAndLimits');
    });

    test('reconcile drops only the keys whose real setting changed', async () => {
        const backend = new FakeBackend();
        backend.writable = false;
        const store = new SettingsStore(backend);
        await store.set('statusBarMode', 'limits');
        await store.set('period', 'month');

        backend.saved.set('statusBarMode', 'costAndLimits');
        store.reconcile((key) => key === 'statusBarMode');

        assert.strictEqual(store.get('statusBarMode', 'cost'), 'costAndLimits');
        assert.strictEqual(store.get('period', 'today'), 'month');
        assert.deepStrictEqual(store.unsavedKeys(), ['period']);
    });

    test('an in-memory undefined still shadows the persisted value', async () => {
        const backend = new FakeBackend();
        backend.saved.set('rtkPath', 'C:/rtk.exe');
        backend.writable = false;
        const store = new SettingsStore(backend);

        await store.set('rtkPath', undefined);
        assert.strictEqual(store.get<string | undefined>('rtkPath', ''), undefined);
    });
});
