import * as assert from 'assert';
import { createHash } from 'crypto';
import { ClaudeCredentialReader, claudeKeychainService } from '../claudeCredentials';
import { fetchClaudeLimits } from '../limits';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';

const payload = JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-token', expiresAt: 2000, subscriptionType: 'max' } });
const missing = async (): Promise<string> => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

suite('Claude credential stores #64', () => {
    test('native lookup has a fixed executable, bounded timeout, and no shell or secret errors', async () => {
        const entry = path.join(__dirname, '..', 'claudeCredentials.js');
        const realRequire = createRequire(entry);
        const exports: any = {};
        let calls = 0;
        vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
            exports, process, console,
            require: (name: string) => name !== 'child_process' ? realRequire(name) : {
                execFile: (executable: string, args: string[], options: any, callback: Function) => {
                    calls++;
                    assert.strictEqual(executable, '/usr/bin/security');
                    assert.deepStrictEqual(Array.from(args), ['find-generic-password', '-a', 'test-user', '-w', '-s', 'Claude Code-credentials']);
                    assert.strictEqual(options.timeout, 3000);
                    assert.strictEqual(options.maxBuffer, 65536);
                    assert.ok(!options.shell);
                    callback({ code: 128, message: 'secret error text', stdout: payload }, payload);
                },
            },
        }, { filename: entry });
        const reader = new exports.ClaudeCredentialReader('darwin', undefined, missing, 'test-user');
        const result = await reader.read('/default', 1000, false);
        assert.strictEqual(JSON.stringify(result), '{"status":"denied"}');
        assert.strictEqual(calls, 1);
    });
    test('preserves file credentials on Windows and Linux', async () => {
        for (const platform of ['win32', 'linux'] as const) {
            const reader = new ClaudeCredentialReader(platform, async () => { throw new Error('must not call Keychain'); }, async () => payload);
            assert.strictEqual((await reader.read('/profile', 1000)).status, 'available');
            assert.strictEqual((await reader.read('/profile', 2000)).status, 'expired');
        }
    });
    test('prefers Keychain and chooses the exact custom profile and account', async () => {
        const reader = new ClaudeCredentialReader('darwin', async (service, account) => {
            assert.strictEqual(service, 'Claude Code-credentials-' + createHash('sha256').update('/custom').digest('hex').slice(0, 8));
            assert.strictEqual(account, 'test-user');
            return { status: 'available', text: payload };
        }, async () => { throw new Error('must not use stale file'); }, 'test-user');
        assert.strictEqual((await reader.read('/custom', 1000, true)).status, 'available');
        assert.strictEqual(claudeKeychainService('/default', false), 'Claude Code-credentials');
        assert.strictEqual(claudeKeychainService('/caf\u0065\u0301', true), claudeKeychainService('/caf\u00e9', true));
    });
    test('falls back to file only when the Keychain item is missing', async () => {
        const reader = new ClaudeCredentialReader('darwin', async () => ({ status: 'missing' }), async () => payload);
        assert.strictEqual((await reader.read('/profile', 1000)).status, 'available');
        const absent = new ClaudeCredentialReader('darwin', async () => ({ status: 'missing' }), missing);
        assert.deepStrictEqual(await absent.read('/profile', 1000), { status: 'missing' });
    });
    test('denial and store failure stop polling prompts until explicit retry', async () => {
        for (const status of ['denied', 'unavailable'] as const) {
            let calls = 0;
            const reader = new ClaudeCredentialReader('darwin', async () => { calls++; return { status }; }, async () => payload);
            assert.deepStrictEqual(await reader.read('/profile', 1000), { status });
            await reader.read('/profile', 1e9);
            assert.strictEqual(calls, 1);
            reader.retry();
            await reader.read('/profile', 1e9);
            assert.strictEqual(calls, 2);
        }
    });
    test('malformed, expired, and missing credentials have distinct sanitized outcomes', async () => {
        for (const [text, status] of [['{', 'invalid'], ['{}', 'invalid'], [payload, 'expired']] as const) {
            const reader = new ClaudeCredentialReader('darwin', async () => ({ status: 'available', text }), missing);
            assert.deepStrictEqual(await reader.read('/profile', 3000), { status });
        }
    });
    test('coalesces concurrent Keychain lookups and completes every caller', async () => {
        let release!: () => void;
        let calls = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const reader = new ClaudeCredentialReader('darwin', async () => { calls++; await gate; return { status: 'available', text: payload }; }, missing);
        const first = reader.read('/profile', 1000);
        const second = reader.read('/profile', 1000);
        assert.strictEqual(first, second);
        release();
        assert.strictEqual((await second).status, 'available');
        assert.strictEqual(calls, 1);
    });
    test('usage API uses Keychain token but reports only sanitized credential status', async () => {
        const reader = new ClaudeCredentialReader('darwin', async () => ({ status: 'available', text: payload }), missing);
        const statuses: string[] = [];
        const fakeFetch: typeof fetch = async (_url, options) => {
            assert.strictEqual((options?.headers as Record<string, string>).Authorization, 'Bearer test-only-token');
            return new Response(JSON.stringify({ five_hour: { utilization: 17 } }));
        };
        const limits = await fetchClaudeLimits('/profile', 1000, fakeFetch, 100, undefined, {
            reader, onCredentialStatus: status => statuses.push(status),
        });
        assert.strictEqual(limits?.primary?.usedPercent, 17);
        assert.deepStrictEqual(statuses, ['available']);
        assert.ok(!JSON.stringify(limits).includes('test-only-token'));
    });
});
