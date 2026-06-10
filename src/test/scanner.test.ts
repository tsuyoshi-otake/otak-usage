import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyCache } from '../cache';
import { scanAll } from '../engine';
import { parseClaudeLine } from '../scanner/claudeScanner';
import { CodexParseState, parseCodexLine } from '../scanner/codexScanner';
import { readNewLines } from '../scanner/jsonlReader';

function claudeLine(opts: { id: string; requestId: string; model?: string; iso: string; output?: number }): string {
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
});

suite('engine.scanAll', () => {
    test('full + incremental scan over claude and codex fixtures with dedupe', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-eng-'));
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        const now = new Date(nowMs);
        const pad = (n: number) => String(n).padStart(2, '0');

        // Claude fixture: same message written twice (two content blocks) -> dedupe to one
        const claudeDir = path.join(root, 'claude');
        const projectDir = path.join(claudeDir, 'projects', 'p1');
        fs.mkdirSync(projectDir, { recursive: true });
        const claudeFile = path.join(projectDir, 's1.jsonl');
        fs.writeFileSync(claudeFile,
            claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1000 }) + '\n' +
            claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1000 }) + '\n');

        // Codex fixture under sessions/YYYY/MM/DD
        const codexHome = path.join(root, 'codex');
        const dayDir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
        fs.mkdirSync(dayDir, { recursive: true });
        const codexFile = path.join(dayDir, 'rollout-x.jsonl');
        fs.writeFileSync(codexFile,
            JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n' +
            codexTokenCount(iso, 1000, 600, 50) + '\n');

        const cache = emptyCache();
        const dedupe = new Set<string>();
        const changed = await scanAll(cache, dedupe, { claudeDir, codexHome }, nowMs);
        assert.strictEqual(changed, true);

        const day = Object.keys(cache.days)[0];
        const claudeUsage = cache.days[day]['claude/claude-opus-4-8'];
        assert.strictEqual(claudeUsage.output, 1000); // deduped, not 2000
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
});
