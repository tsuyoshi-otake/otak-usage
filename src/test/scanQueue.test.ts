import * as assert from 'assert';
import { ScanQueue } from '../scanner/scanQueue';

suite('scan/refresh ownership #62', () => {
    for (const fail of [false, true]) {
        test(`refresh waits, coalesces callers and owns completion (failed scan=${fail})`, async () => {
            const queue = new ScanQueue();
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const events: string[] = [];
            const scan = queue.tick(async () => { events.push('scan'); await gate; events.push('finished'); if (fail) { throw new Error('EIO'); } });
            const outcome = scan.catch(() => undefined);
            const refresh = queue.refresh(async () => { events.push('refresh'); });
            for (let i = 0; i < 100; i++) {
                assert.strictEqual(queue.refresh(async () => { throw new Error('duplicate'); }), refresh);
                assert.strictEqual(queue.tick(async () => { throw new Error('overlap'); }), refresh);
            }
            await Promise.resolve();
            assert.deepStrictEqual(events, ['scan']);
            release();
            await Promise.all([outcome, refresh]);
            assert.deepStrictEqual(events, ['scan', 'finished', 'refresh']);
            await queue.tick(async () => { events.push('next'); });
            assert.strictEqual(events.at(-1), 'next');
        });
    }
    test('refresh failure rejects callers and releases ownership', async () => {
        const queue = new ScanQueue();
        await assert.rejects(queue.refresh(async () => { throw new Error('failed'); }), /failed/);
        let ran = false;
        await queue.refresh(async () => { ran = true; });
        assert.ok(ran);
    });
});
