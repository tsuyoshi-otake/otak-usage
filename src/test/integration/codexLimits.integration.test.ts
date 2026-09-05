import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fetchCodexBankedResets, readCodexLimits } from '../../limits';
import { ScannedFile } from '../../scanner/scanIndex';

suite('API integration: Codex rollout limits', () => {
    let dir: string;
    setup(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'otak-codex-contract-')); });
    teardown(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

    function line(percent: number, timestamp = '2026-08-14T00:00:00Z'): string {
        return JSON.stringify({
            timestamp,
            payload: {
                rate_limits: {
                    primary: { used_percent: percent, resets_at: 1_800_000_000, window_minutes: 300 },
                    plan_type: 'pro',
                },
            },
        });
    }

    async function rollout(name: string, content: string, mtimeMs: number): Promise<ScannedFile> {
        const filePath = path.join(dir, name);
        await fsp.writeFile(filePath, content, 'utf8');
        const stat = await fsp.stat(filePath);
        return { path: filePath, size: stat.size, mtimeMs };
    }

    test('uses supplied scan metadata and the last valid protocol event wins', async () => {
        const file = await rollout('rollout.jsonl', [line(1), '{"payload":{"rate_limits":', line(2), line(3)].join('\n'), 3);
        const result = await readCodexLimits(dir, Date.now(), [file]);
        assert.strictEqual(result?.primary?.usedPercent, 3);
        assert.strictEqual(result?.planType, 'pro');
    });

    test('candidate order is explicit and supports reordered arrival without merging snapshots', async () => {
        const first = await rollout('first.jsonl', line(10, '2026-08-14T01:00:00Z'), 10);
        const second = await rollout('second.jsonl', line(20, '2026-08-14T02:00:00Z'), 20);
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [first, second]))?.primary?.usedPercent, 10);
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [second, first]))?.primary?.usedPercent, 20);
    });

    test('missing and crash-truncated newest files fall through, then a restarted writer recovers', async () => {
        const missing: ScannedFile = { path: path.join(dir, 'missing.jsonl'), size: 100, mtimeMs: 3 };
        const newest = await rollout('newest.jsonl', line(99).slice(0, 40), 2);
        const older = await rollout('older.jsonl', line(7), 1);
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [missing, newest, older]))?.primary?.usedPercent, 7);

        await fsp.appendFile(newest.path, line(99).slice(40), 'utf8');
        newest.size = (await fsp.stat(newest.path)).size;
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [newest, older]))?.primary?.usedPercent, 99);
    });

    test('the bounded tail omits old events but accepts a complete event at the tail boundary', async () => {
        const old = line(4);
        const recent = line(8);
        const padding = 'x'.repeat(256 * 1024 + 32);
        const file = await rollout('large.jsonl', `${old}\n${padding}\n${recent}\n`, 1);
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [file]))?.primary?.usedPercent, 8);

        const withoutRecent = await rollout('large-old-only.jsonl', `${old}\n${padding}\n`, 2);
        assert.strictEqual(await readCodexLimits(dir, Date.now(), [withoutRecent]), undefined);
    });

    test('duplicate and omitted events have deterministic semantics and file handles are finalized', async () => {
        const duplicate = await rollout('duplicate.jsonl', `${line(5)}\n${line(5)}\n`, 1);
        const omitted = await rollout('omitted.jsonl', '{"payload":{"type":"token_count"}}\n', 2);
        assert.strictEqual((await readCodexLimits(dir, Date.now(), [duplicate]))?.primary?.usedPercent, 5);
        assert.strictEqual(await readCodexLimits(dir, Date.now(), [omitted]), undefined);
        await fsp.rename(duplicate.path, duplicate.path + '.closed');
    });
});

suite('API integration: Codex banked resets', () => {
    let dir: string;
    setup(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'otak-codex-banked-')); });
    teardown(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

    test('sends the ChatGPT usage request with the stored bearer token and account id', async () => {
        await fsp.writeFile(path.join(dir, 'auth.json'), JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: 'test-token', account_id: 'acct-1' },
        }), 'utf8');
        let calls = 0;
        const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            calls++;
            assert.strictEqual(String(input), 'https://chatgpt.com/backend-api/wham/usage');
            assert.deepStrictEqual(init?.headers, {
                Authorization: 'Bearer test-token',
                'ChatGPT-Account-Id': 'acct-1',
            });
            return {
                ok: true,
                json: async () => ({ rate_limit_reset_credits: { available_count: 2 } }),
            } as Response;
        }) as typeof fetch;
        assert.strictEqual(await fetchCodexBankedResets(dir, fakeFetch), 2);
        assert.strictEqual(calls, 1);
    });

    test('omitted credentials and HTTP failure stop without inventing a count', async () => {
        let calls = 0;
        const fakeFetch = (async () => { calls++; throw new Error('must not run'); }) as typeof fetch;
        assert.strictEqual(await fetchCodexBankedResets(dir, fakeFetch), undefined);
        await fsp.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }), 'utf8');
        assert.strictEqual(await fetchCodexBankedResets(dir, fakeFetch), undefined);
        await fsp.writeFile(path.join(dir, 'auth.json'), JSON.stringify({
            tokens: { access_token: 'x', account_id: 'acct-1' },
        }), 'utf8');
        const failing = (async () => ({ ok: false } as Response)) as typeof fetch;
        assert.strictEqual(await fetchCodexBankedResets(dir, failing), undefined);
        assert.strictEqual(calls, 0);
    });
});
