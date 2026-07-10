import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DedupeEntry, emptyCache } from '../cache';
import { scanAll } from '../engine';
import { parseClaudeLine } from '../scanner/claudeScanner';
import { CodexParseState, parseCodexLine } from '../scanner/codexScanner';
import { readNewLines, visitNewLines } from '../scanner/jsonlReader';

function claudeLine(opts: { id: string; requestId: string; model?: string; iso: string; output?: number; speed?: string }): string {
    return JSON.stringify({
        type: 'assistant',
        requestId: opts.requestId,
        timestamp: opts.iso,
        message: {
            id: opts.id,
            model: opts.model ?? 'claude-opus-4-8',
            usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 240,
                cache_read_input_tokens: 35369,
                output_tokens: opts.output ?? 336,
                cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 40 },
                ...(opts.speed ? { speed: opts.speed } : {}),
            },
        },
    });
}

function codexTokenCount(iso: string, input: number, cached: number, output: number): string {
    return JSON.stringify({
        timestamp: iso,
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: {
                total_token_usage: { input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999, total_tokens: 0 },
                last_token_usage: {
                    input_tokens: input,
                    cached_input_tokens: cached,
                    output_tokens: output,
                    reasoning_output_tokens: 0,
                    total_tokens: input + output,
                },
            },
        },
    });
}

suite('parseClaudeLine', () => {
    test('extracts model, tokens, cache breakdown, and dedupe key', () => {
        const r = parseClaudeLine(claudeLine({ id: 'msg_1', requestId: 'req_1', iso: '2026-06-10T03:00:00.000Z' }));
        assert.ok(r);
        assert.strictEqual(r.event.model, 'claude-opus-4-8');
        assert.strictEqual(r.event.usage.input, 100);
        assert.strictEqual(r.event.usage.cacheRead, 35369);
        assert.strictEqual(r.event.usage.cacheWrite5m, 200);
        assert.strictEqual(r.event.usage.cacheWrite1h, 40);
        assert.strictEqual(r.dedupeKey, 'msg_1:req_1');
    });

    test('falls back to cache_creation_input_tokens without breakdown', () => {
        const rec = JSON.parse(claudeLine({ id: 'm', requestId: 'r', iso: '2026-06-10T03:00:00.000Z' }));
        delete rec.message.usage.cache_creation;
        const r = parseClaudeLine(JSON.stringify(rec));
        assert.strictEqual(r?.event.usage.cacheWrite5m, 240);
        assert.strictEqual(r?.event.usage.cacheWrite1h, 0);
    });

    test('fast mode maps to a "<model>-fast" id', () => {
        const r = parseClaudeLine(claudeLine({ id: 'm', requestId: 'r', iso: '2026-06-10T03:00:00.000Z', speed: 'fast' }));
        assert.strictEqual(r?.event.model, 'claude-opus-4-8-fast');
        const normal = parseClaudeLine(claudeLine({ id: 'm', requestId: 'r', iso: '2026-06-10T03:00:00.000Z', speed: 'standard' }));
        assert.strictEqual(normal?.event.model, 'claude-opus-4-8');
    });

    test('skips non-assistant, synthetic, and garbage lines', () => {
        assert.strictEqual(parseClaudeLine('{"type":"user"}'), undefined);
        assert.strictEqual(parseClaudeLine('not json'), undefined);
        const synthetic = claudeLine({ id: 'm', requestId: 'r', model: '<synthetic>', iso: '2026-06-10T03:00:00.000Z' });
        assert.strictEqual(parseClaudeLine(synthetic), undefined);
    });
});

suite('parseCodexLine', () => {
    test('turn_context sets model, token_count uses last_token_usage with cached subtracted', () => {
        const state: CodexParseState = {};
        assert.strictEqual(parseCodexLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }), state), undefined);
        assert.strictEqual(state.lastModel, 'gpt-5.5');
        const event = parseCodexLine(codexTokenCount('2026-06-10T03:00:00.000Z', 93743, 93568, 49), state);
        assert.ok(event);
        assert.strictEqual(event.model, 'gpt-5.5');
        assert.strictEqual(event.usage.input, 175); // 93743 - 93568
        assert.strictEqual(event.usage.cachedInput, 93568);
        assert.strictEqual(event.usage.output, 49);
    });

    test('cached_input_tokens larger than input_tokens is capped', () => {
        const state: CodexParseState = { lastModel: 'gpt-5.5' };
        const event = parseCodexLine(codexTokenCount('2026-06-10T03:00:00.000Z', 100, 250, 10), state);
        assert.ok(event);
        assert.strictEqual(event.usage.input, 0);
        assert.strictEqual(event.usage.cachedInput, 100);
    });

    test('token_count before the first turn_context is skipped as replayed history', () => {
        const state: CodexParseState = {};
        const event = parseCodexLine(codexTokenCount('2026-07-10T03:00:00.000Z', 283_574, 281_344, 304), state);
        assert.strictEqual(event, undefined);
    });

    test('gpt-5.6 marks only requests above 272K for long-context pricing', () => {
        const state: CodexParseState = { lastModel: 'gpt-5.6-sol' };
        const boundary = parseCodexLine(codexTokenCount('2026-07-10T03:00:00.000Z', 272_000, 270_000, 100), state);
        assert.ok(boundary);
        assert.strictEqual(boundary.usage.longContextInput, undefined);

        const long = parseCodexLine(codexTokenCount('2026-07-10T03:00:01.000Z', 272_001, 270_000, 100), state);
        assert.ok(long);
        assert.strictEqual(long.usage.longContextInput, 2_001);
        assert.strictEqual(long.usage.longContextCachedInput, 270_000);
        assert.strictEqual(long.usage.longContextOutput, 100);
    });

    test('token_count without info is skipped', () => {
        const state: CodexParseState = {};
        const line = JSON.stringify({ timestamp: '2026-06-10T03:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } });
        assert.strictEqual(parseCodexLine(line, state), undefined);
    });
});

suite('jsonlReader', () => {
    test('incremental reads hold back incomplete trailing lines', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-'));
        const file = path.join(dir, 'a.jsonl');
        fs.writeFileSync(file, 'line1\nline2\npart');
        const first = await readNewLines(file, 0);
        assert.deepStrictEqual(first.lines, ['line1', 'line2']);
        assert.strictEqual(first.newOffset, 'line1\nline2\n'.length);

        fs.appendFileSync(file, 'ial3\nline4\n');
        const second = await readNewLines(file, first.newOffset);
        assert.deepStrictEqual(second.lines, ['partial3', 'line4']);
        assert.strictEqual(second.newOffset, fs.statSync(file).size);

        const third = await readNewLines(file, second.newOffset);
        assert.deepStrictEqual(third.lines, []);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('multi-byte UTF-8 lines survive chunk splitting', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-'));
        const file = path.join(dir, 'b.jsonl');
        const line = 'あいうえお漢字テスト🎉'.repeat(10000); // big enough to span stream chunks
        fs.writeFileSync(file, line + '\n' + line + '\n');
        const r = await readNewLines(file, 0);
        assert.strictEqual(r.lines.length, 2);
        assert.strictEqual(r.lines[0], line);
        assert.strictEqual(r.lines[1], line);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('visitor reads complete lines without changing offset semantics', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-'));
        const file = path.join(dir, 'c.jsonl');
        fs.writeFileSync(file, 'one\ntwo\npartial');
        const lines: string[] = [];
        const result = await visitNewLines(file, 0, (line) => lines.push(line));
        assert.deepStrictEqual(lines, ['one', 'two']);
        assert.strictEqual(result.lineCount, 2);
        assert.strictEqual(result.newOffset, 'one\ntwo\n'.length);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('visitor errors reject the read', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-'));
        const file = path.join(dir, 'd.jsonl');
        fs.writeFileSync(file, 'one\ntwo\n');
        await assert.rejects(
            visitNewLines(file, 0, () => {
                throw new Error('visitor failed');
            }),
            /visitor failed/,
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

suite('engine.scanAll', () => {
    test('full + incremental scan over claude and codex fixtures with dedupe', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-eng-'));
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        const now = new Date(nowMs);
        const pad = (n: number) => String(n).padStart(2, '0');

        // Claude fixture: one request streamed as a partial snapshot (output 1)
        // then a final record (output 1000) -> last-wins keeps 1000, not 1, and
        // input is not doubled.
        const claudeDir = path.join(root, 'claude');
        const projectDir = path.join(claudeDir, 'projects', 'p1');
        fs.mkdirSync(projectDir, { recursive: true });
        const claudeFile = path.join(projectDir, 's1.jsonl');
        fs.writeFileSync(claudeFile,
            claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1 }) + '\n' +
            claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1000 }) + '\n');

        // Codex fixture under sessions/YYYY/MM/DD
        const codexHome = path.join(root, 'codex');
        const dayDir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
        fs.mkdirSync(dayDir, { recursive: true });
        const codexFile = path.join(dayDir, 'rollout-x.jsonl');
        // Same token_count written twice (identical timestamp+tokens) -> dedupe to one
        fs.writeFileSync(codexFile,
            JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n' +
            codexTokenCount(iso, 1000, 600, 50) + '\n' +
            codexTokenCount(iso, 1000, 600, 50) + '\n');

        const cache = emptyCache();
        const dedupe = new Map<string, DedupeEntry>();
        const changed = await scanAll(cache, dedupe, { claudeDir, codexHome }, nowMs);
        assert.strictEqual(changed, true);

        const day = Object.keys(cache.days)[0];
        const claudeUsage = cache.days[day]['claude/claude-opus-4-8'];
        assert.strictEqual(claudeUsage.output, 1000); // last-wins final, not the partial 1
        assert.strictEqual(claudeUsage.input, 100); // replaced, not doubled to 200
        const codexUsage = cache.days[day]['codex/gpt-5.5'];
        assert.strictEqual(codexUsage.input, 400);
        assert.strictEqual(codexUsage.cachedInput, 600);
        assert.strictEqual(codexUsage.output, 50);

        // No changes -> no work
        assert.strictEqual(await scanAll(cache, dedupe, { claudeDir, codexHome }, nowMs), false);

        // Append one more codex turn; the cached lastModel must survive the incremental read
        fs.appendFileSync(codexFile, codexTokenCount(iso, 100, 0, 10) + '\n');
        assert.strictEqual(await scanAll(cache, dedupe, { claudeDir, codexHome }, nowMs), true);
        assert.strictEqual(cache.days[day]['codex/gpt-5.5'].output, 60);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('prunes dedupe entries older than the retained month', async () => {
        const cache = emptyCache();
        const dedupe = new Map<string, DedupeEntry>([
            ['old', {
                day: '2026-05-31',
                bucket: 'codex/gpt-5.5',
                usage: { input: 1, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
            }],
            ['current', {
                day: '2026-06-01',
                bucket: 'codex/gpt-5.5',
                usage: { input: 1, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
            }],
        ]);

        const changed = await scanAll(cache, dedupe, {}, new Date(2026, 5, 10).getTime());

        assert.strictEqual(changed, true);
        assert.strictEqual(dedupe.has('old'), false);
        assert.strictEqual(dedupe.has('current'), true);
    });
});
