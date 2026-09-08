import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpFailure, UsagePolling } from '../usagePolling';

suite('provider polling #63', () => {
    const now = 1_900_000_000_000;
    test('parses Retry-After seconds/date and defines authentication failure', () => {
        const response = (value: string, status = 429) => ({ status, headers: new Headers({ 'Retry-After': value }) }) as Response;
        assert.strictEqual(httpFailure(response('3600'), now).retryAtMs, now + 3600000);
        const date = new Date(now + 3600000).toUTCString();
        assert.strictEqual(httpFailure(response(date), now).retryAtMs, Date.parse(date));
        assert.strictEqual(httpFailure(response('invalid'), now).retryAtMs, undefined);
        assert.strictEqual(httpFailure(response('', 401), now).kind, 'credentials');
    });
    test('cooldown survives new windows and multiple groups sharing credentials', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-poll-'));
        let calls = 0;
        const request = async () => { calls++; return { kind: 'retryable' as const, retryAtMs: now + 3600000 }; };
        try {
            await new UsagePolling(() => 0).poll(dir, 'synthetic-credential', now, request);
            for (const delta of [300000, 600000, 3599999]) {
                await new UsagePolling(() => 0).poll(dir, 'synthetic-credential', now + delta, request);
            }
            assert.strictEqual(calls, 1);
            await new UsagePolling(() => 0).poll(dir, 'synthetic-credential', now + 3600000, request);
            assert.strictEqual(calls, 2);
            for (const name of fs.readdirSync(dir)) {
                assert.ok(!name.includes('synthetic-credential'));
                if (name.endsWith('.json')) { assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes('synthetic-credential')); }
            }
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    test('coalesces in-flight work and backs off thrown failures', async () => {
        const polling = new UsagePolling(() => 0);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        const request = async () => { calls++; await gate; throw new Error('network'); };
        const first = polling.poll('', 'same', now, request);
        assert.strictEqual(polling.poll('', 'same', now, request), first);
        release();
        await first;
        await polling.poll('', 'same', now + 300000, request);
        assert.strictEqual(calls, 1);
        await polling.poll('', 'same', now + 450000, request);
        assert.strictEqual(calls, 2);
    });
    test('success resets backoff; rejected credentials have a one-hour floor', async () => {
        const polling = new UsagePolling(() => 0);
        let calls = 0;
        const request = async () => { calls++; return { kind: 'success' as const, value: 0 }; };
        await polling.poll('', 'auth', now, async () => ({ kind: 'credentials' }));
        await polling.poll('', 'auth', now + 300000, request);
        assert.strictEqual(calls, 0);
        assert.strictEqual((await polling.poll('', 'auth', now + 3600000, request)).value, 0);
        await polling.poll('', 'auth', now + 3900000, request);
        assert.strictEqual(calls, 2);
    });
});
