import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fetchClaudeLimits } from '../../limits';

suite('API integration: Claude limits', () => {
    let dir: string;

    setup(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'otak-claude-contract-'));
    });

    teardown(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    async function credentials(value: unknown): Promise<void> {
        await fsp.writeFile(path.join(dir, '.credentials.json'), JSON.stringify(value), 'utf8');
    }

    test('connects credentials to the OAuth protocol with the required URL and headers', async () => {
        const now = Date.parse('2026-08-14T00:00:00Z');
        await credentials({ claudeAiOauth: { accessToken: 'test-token', expiresAt: now + 1, subscriptionType: 'max' } });
        let calls = 0;
        const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            calls++;
            assert.strictEqual(String(input), 'https://api.anthropic.com/api/oauth/usage');
            assert.deepStrictEqual(init?.headers, {
                Authorization: 'Bearer test-token',
                'anthropic-beta': 'oauth-2025-04-20',
            });
            assert.ok(init?.signal instanceof AbortSignal);
            return {
                ok: true,
                json: async () => ({
                    seven_day: { utilization: 37, resets_at: '2026-08-20T00:00:00Z' },
                    five_hour: { utilization: 12, resets_at: '2026-08-14T05:00:00Z' },
                    limits: [{
                        kind: 'weekly_scoped',
                        percent: 68,
                        resets_at: '2026-08-20T00:00:00Z',
                        scope: { model: { display_name: 'Fable' } },
                    }],
                }),
            } as Response;
        }) as typeof fetch;

        const result = await fetchClaudeLimits(dir, now, fakeFetch);
        assert.strictEqual(calls, 1);
        assert.strictEqual(result?.primary?.usedPercent, 12);
        assert.strictEqual(result?.secondary?.usedPercent, 37);
        assert.strictEqual(result?.scoped?.[0].label, 'Fable');
        assert.strictEqual(result?.scoped?.[0].usedPercent, 68);
        assert.strictEqual(result?.planType, 'max');
    });

    test('omitted, malformed, and expired credentials stop before the external effect', async () => {
        let calls = 0;
        const fakeFetch = (async () => { calls++; throw new Error('must not run'); }) as typeof fetch;
        assert.strictEqual(await fetchClaudeLimits(dir, 10, fakeFetch), undefined);
        await fsp.writeFile(path.join(dir, '.credentials.json'), '{partial', 'utf8');
        assert.strictEqual(await fetchClaudeLimits(dir, 10, fakeFetch), undefined);
        await credentials({ claudeAiOauth: { accessToken: 'x', expiresAt: 10 } });
        assert.strictEqual(await fetchClaudeLimits(dir, 10, fakeFetch), undefined);
        assert.strictEqual(calls, 0);
    });

    test('partial response, HTTP failure, decoder exhaustion, and recovery are isolated per attempt', async () => {
        await credentials({ claudeAiOauth: { accessToken: 'x' } });
        const responses: Array<() => Promise<Response>> = [
            async () => ({ ok: false } as Response),
            async () => ({ ok: true, json: async () => { throw new RangeError('response too large'); } } as unknown as Response),
            async () => ({ ok: true, json: async () => ({ seven_day: { utilization: 9 } }) } as Response),
        ];
        const fakeFetch = (async () => responses.shift()!()) as typeof fetch;

        assert.strictEqual(await fetchClaudeLimits(dir, 1, fakeFetch), undefined);
        assert.strictEqual(await fetchClaudeLimits(dir, 2, fakeFetch), undefined);
        assert.strictEqual((await fetchClaudeLimits(dir, 3, fakeFetch))?.secondary?.usedPercent, 9);
        assert.strictEqual(responses.length, 0, 'the function performs no hidden retry or duplicate request');
    });

    test('the request deadline aborts a stalled protocol dependency', async () => {
        await credentials({ claudeAiOauth: { accessToken: 'x' } });
        const stalled = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            assert.ok(init?.signal);
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        })) as typeof fetch;
        const started = Date.now();
        assert.strictEqual(await fetchClaudeLimits(dir, 1, stalled, 10), undefined);
        assert.ok(Date.now() - started < 1000);
    });
});
