import * as assert from 'assert';
import { ExecFileException, execFile } from 'child_process';
import { fetchRtkStats } from '../../rtk';

suite('API integration: RTK process protocol', () => {
    const gain = (daily: unknown[] = []) => JSON.stringify({
        summary: { total_commands: 9, total_input: 100, total_output: 20, total_saved: 30 },
        daily,
    });

    type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
    function fakeExec(impl: (file: string, args: readonly string[], options: Record<string, unknown>, cb: Callback) => void): typeof execFile {
        return impl as unknown as typeof execFile;
    }

    test('invokes the CLI protocol with exact executable, arguments, deadline, buffer, and hidden window', async () => {
        const run = fakeExec((file, args, options, cb) => {
            assert.strictEqual(file, 'C:\\tools\\rtk.exe');
            assert.deepStrictEqual(args, ['gain', '--daily', '--format', 'json']);
            assert.strictEqual(options.timeout, 1234);
            assert.strictEqual(options.maxBuffer, 5678);
            assert.strictEqual(options.windowsHide, true);
            cb(null, gain([{ date: '2026-08-14', commands: 1, input_tokens: 10, output_tokens: 2, saved_tokens: 3 }]), '');
        });
        const result = await fetchRtkStats('  C:\\tools\\rtk.exe  ', '2026-08-14', {
            execFileFn: run, timeoutMs: 1234, maxBuffer: 5678,
        });
        assert.strictEqual(result?.today.inputTokens, 10);
        assert.strictEqual(result?.allTime.inputTokens, 100);
    });

    test('omitted path selects the protocol default executable', async () => {
        for (const value of [undefined, '   ']) {
            const run = fakeExec((file, _args, _options, cb) => {
                assert.strictEqual(file, 'rtk');
                cb(null, gain(), '');
            });
            assert.ok(await fetchRtkStats(value, '2026-08-14', { execFileFn: run }));
        }
    });

    test('duplicate and reordered daily events are accumulated deterministically', async () => {
        const entries = [
            { date: '2026-08-14', commands: 1, input_tokens: 10, output_tokens: 2, saved_tokens: 3 },
            { date: '2026-08-13', commands: 2, input_tokens: 20, output_tokens: 4, saved_tokens: 6 },
            { date: '2026-08-14', commands: 1, input_tokens: 10, output_tokens: 2, saved_tokens: 3 },
        ];
        const invoke = (daily: unknown[]) => fetchRtkStats(undefined, '2026-08-14', {
            execFileFn: fakeExec((_file, _args, _options, cb) => cb(null, gain(daily), '')),
        });
        const forward = await invoke(entries);
        const reverse = await invoke([...entries].reverse());
        assert.deepStrictEqual(forward, reverse);
        assert.strictEqual(forward?.today.inputTokens, 20);
        assert.strictEqual(forward?.month.inputTokens, 40);
    });

    test('timeout, crash, resource exhaustion, and malformed output map to unavailable', async () => {
        const failures: Array<ExecFileException | null> = [
            Object.assign(new Error('timed out'), { killed: true, code: null, signal: 'SIGTERM', cmd: 'rtk' }) as ExecFileException,
            Object.assign(new Error('crashed'), { killed: false, code: 1, signal: undefined, cmd: 'rtk' }) as unknown as ExecFileException,
            Object.assign(new Error('stdout maxBuffer exceeded'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: undefined, cmd: 'rtk' }) as unknown as ExecFileException,
            null,
        ];
        const outputs = ['', '', '', '{partial'];
        for (let i = 0; i < failures.length; i++) {
            const index = i;
            const run = fakeExec((_file, _args, _options, cb) => cb(failures[index], outputs[index], ''));
            assert.strictEqual(await fetchRtkStats(undefined, '2026-08-14', { execFileFn: run }), undefined);
        }
    });

    test('a fresh invocation recovers after a failed process; no hidden retry occurs', async () => {
        let calls = 0;
        const run = fakeExec((_file, _args, _options, cb) => {
            calls++;
            if (calls === 1) {
                cb(Object.assign(new Error('crash'), { killed: false, code: 1, signal: undefined, cmd: 'rtk' }) as unknown as ExecFileException, '', '');
            } else {
                cb(null, gain(), '');
            }
        });
        assert.strictEqual(await fetchRtkStats(undefined, '2026-08-14', { execFileFn: run }), undefined);
        assert.ok(await fetchRtkStats(undefined, '2026-08-14', { execFileFn: run }));
        assert.strictEqual(calls, 2);
    });
});
