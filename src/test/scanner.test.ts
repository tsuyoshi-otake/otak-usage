import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    FileState,
    PEND_CAP,
    PEND_RETENTION_MS,
    SEEN_CAP_CODEX,
    emptyCache,
    hashKey,
    isValidCache,
} from '../cache';
import { closeWindow, hasSeen, openWindow, pendingFor, remember } from '../dedupe';
import { scanAll } from '../engine';
import { resolvePricing } from '../pricing';
import { UsageEvent } from '../types';
import { parseClaudeLine } from '../scanner/claudeScanner';
import { CODEX_AUTO_REVIEW_MODEL, CODEX_AUTO_REVIEW_PRICED_AS, resolveCodexModel } from '../scanner/codexAutoReview';
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

/** An empty <root>/claude/projects/p1/s1.jsonl transcript tree. */
function claudeFixture(): { root: string; claudeDir: string; claudeFile: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-eng-'));
    const claudeDir = path.join(root, 'claude');
    const projectDir = path.join(claudeDir, 'projects', 'p1');
    fs.mkdirSync(projectDir, { recursive: true });
    return { root, claudeDir, claudeFile: path.join(projectDir, 's1.jsonl') };
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

suite('parseCodexLine: codex-auto-review', () => {
    function autoReviewAt(iso: string): UsageEvent | undefined {
        const state: CodexParseState = { lastModel: CODEX_AUTO_REVIEW_MODEL };
        return parseCodexLine(codexTokenCount(iso, 1000, 0, 100), state);
    }

    test('resolves to the model auto-review bills as, whatever the line date', () => {
        const dates = [
            '2026-07-25T03:00:00.000Z',
            '2026-04-01T03:00:00.000Z',
            '2026-02-20T03:00:00.000Z',
            '2025-12-01T03:00:00.000Z',
            '2025-08-20T03:00:00.000Z',
            '2025-01-01T03:00:00.000Z',
        ];
        for (const iso of dates) {
            assert.strictEqual(autoReviewAt(iso)?.model, CODEX_AUTO_REVIEW_PRICED_AS, iso);
        }
        assert.strictEqual(CODEX_AUTO_REVIEW_PRICED_AS, 'gpt-5.4');
    });

    test('a timestamp that is not an ISO date resolves the same way', () => {
        // Date.parse accepts this, so the event survives; the slug never needed
        // the date, so an odd format cannot push it onto a different rate.
        const state: CodexParseState = { lastModel: CODEX_AUTO_REVIEW_MODEL };
        const line = JSON.stringify({
            timestamp: 'Jul 25, 2026 03:00:00 UTC',
            type: 'event_msg',
            payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } },
        });
        assert.strictEqual(parseCodexLine(line, state)?.model, CODEX_AUTO_REVIEW_PRICED_AS);
    });

    test('the resolved model is priceable, so auto-review never lands in n/a', () => {
        const pricing = resolvePricing(CODEX_AUTO_REVIEW_PRICED_AS);
        assert.ok(pricing);
        assert.strictEqual(pricing?.input, 2.5);
        assert.strictEqual(pricing?.cachedInput, 0.25);
        assert.strictEqual(pricing?.output, 15);
    });

    test('the resolved model drives long-context pricing, which the bare slug cannot', () => {
        // gpt-5.4 bills above 272K; codex-auto-review has no threshold of its own.
        const event = autoReviewAt('2026-07-25T03:00:00.000Z');
        assert.strictEqual(event?.usage.longContextInput, undefined);

        const state: CodexParseState = { lastModel: CODEX_AUTO_REVIEW_MODEL };
        const long = parseCodexLine(codexTokenCount('2026-07-25T03:00:01.000Z', 300_000, 0, 100), state);
        assert.strictEqual(long?.model, CODEX_AUTO_REVIEW_PRICED_AS);
        assert.strictEqual(long?.usage.longContextInput, 300_000);
    });

    test('the raw slug survives in parse state rather than the resolved model', () => {
        const state: CodexParseState = {};
        parseCodexLine(JSON.stringify({ type: 'turn_context', payload: { model: CODEX_AUTO_REVIEW_MODEL } }), state);
        assert.strictEqual(parseCodexLine(codexTokenCount('2026-04-22T23:00:00.000Z', 1000, 0, 100), state)?.model, CODEX_AUTO_REVIEW_PRICED_AS);
        assert.strictEqual(state.lastModel, CODEX_AUTO_REVIEW_MODEL);
    });

    test('an ordinary model id is returned untouched', () => {
        assert.strictEqual(resolveCodexModel('gpt-5.3-codex'), 'gpt-5.3-codex');
        assert.strictEqual(resolveCodexModel('gpt-5.5'), 'gpt-5.5');
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
        const changed = await scanAll(cache, { claudeDir, codexHome }, nowMs);
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
        assert.strictEqual(await scanAll(cache, { claudeDir, codexHome }, nowMs), false);

        // Append one more codex turn; the cached lastModel must survive the incremental read
        fs.appendFileSync(codexFile, codexTokenCount(iso, 100, 0, 10) + '\n');
        assert.strictEqual(await scanAll(cache, { claudeDir, codexHome }, nowMs), true);
        assert.strictEqual(cache.days[day]['codex/gpt-5.5'].output, 60);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('supersedes a partial snapshot when the final record lands on a later tick', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        fs.writeFileSync(claudeFile, claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1 }) + '\n');

        const cache = emptyCache();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 1);

        // The supersede state has to survive the tick boundary, so it must be on
        // the file state rather than in a scan-local map.
        assert.strictEqual(cache.files[claudeFile].pend?.length, 1);

        fs.appendFileSync(claudeFile, claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1000 }) + '\n');
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 1000);
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].input, 100);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('suppresses a replayed record that has aged past the supersede window', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        // Resumed sessions replay their history verbatim, hundreds of records
        // after the original. Presence has to outlive the supersede state.
        const total = PEND_CAP + 3;
        const lines: string[] = [];
        for (let i = 0; i < total; i++) {
            lines.push(claudeLine({ id: `msg_${i}`, requestId: `req_${i}`, iso, output: 10 }));
        }
        fs.writeFileSync(claudeFile, lines.join('\n') + '\n');

        const cache = emptyCache();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        const day = Object.keys(cache.days)[0];
        const bucket = cache.days[day]['claude/claude-opus-4-8'];
        assert.strictEqual(bucket.output, 10 * total);

        const state = cache.files[claudeFile];
        assert.strictEqual(state.seen?.length, total);
        assert.strictEqual(state.pend?.length, PEND_CAP); // the oldest record aged out

        // msg_0 is remembered but no longer superseding: replaying it must not add.
        fs.appendFileSync(claudeFile, lines[0] + '\n');
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        assert.strictEqual(bucket.output, 10 * total);
        assert.strictEqual(bucket.input, 100 * total);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('prunes days and file states only when the month rolls over', async () => {
        const cache = emptyCache();
        cache.month = '2026-05';
        const usage = { input: 1, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
        cache.days['2026-05-31'] = { 'codex/gpt-5.5': { ...usage } };
        cache.days['2026-06-01'] = { 'codex/gpt-5.5': { ...usage } };
        cache.files['/gone.jsonl'] = { size: 1, mtimeMs: new Date(2026, 4, 20).getTime(), offset: 1 };
        cache.files['/kept.jsonl'] = { size: 1, mtimeMs: new Date(2026, 5, 5).getTime(), offset: 1 };
        const nowMs = new Date(2026, 5, 10).getTime();

        assert.strictEqual(await scanAll(cache, {}, nowMs), true);
        assert.strictEqual(cache.month, '2026-06');
        assert.strictEqual(cache.days['2026-05-31'], undefined);
        assert.ok(cache.days['2026-06-01']);
        assert.strictEqual(cache.files['/gone.jsonl'], undefined);
        assert.ok(cache.files['/kept.jsonl']);

        // Nothing can age out again until the next rollover, so later ticks in
        // the same month must not report a change (and so must not re-persist).
        assert.strictEqual(await scanAll(cache, {}, nowMs + 60_000), false);
    });

    test('restarts a truncated file without recounting the records it kept', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        const line = (i: number) => claudeLine({ id: `msg_${i}`, requestId: `req_${i}`, iso, output: 10 });
        fs.writeFileSync(claudeFile, [line(1), line(2), line(3)].join('\n') + '\n');

        const cache = emptyCache();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 30);

        // Rewritten shorter: offset now points past EOF, so the file is re-read
        // from the start. The retained record must not be billed twice.
        fs.writeFileSync(claudeFile, line(1) + '\n');
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 30);
        assert.strictEqual(cache.files[claudeFile].offset, fs.statSync(claudeFile).size);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('leaves an incomplete trailing line uncounted and reports no change', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        const first = claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 10 });
        const second = claudeLine({ id: 'msg_2', requestId: 'req_2', iso, output: 10 });
        fs.writeFileSync(claudeFile, first + '\n' + second); // no terminating newline

        const cache = emptyCache();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 10);
        assert.strictEqual(cache.files[claudeFile].offset, Buffer.byteLength(first) + 1);

        // The half-written line is re-read every tick; that must not be reported
        // as a change, or an actively written log would re-persist the cache
        // on every single tick.
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), false);

        fs.appendFileSync(claudeFile, '\n');
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 20);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('skips unparsable lines and keeps ingesting the rest of the file', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        fs.writeFileSync(claudeFile, [
            '{ not json',
            claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 10 }),
            '',
            'null',
            '{"type":"assistant"}',
            claudeLine({ id: 'msg_2', requestId: 'req_2', iso, output: 10 }),
        ].join('\n') + '\n');

        const cache = emptyCache();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nowMs), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 20);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reports no change when neither provider directory exists', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-eng-'));
        const targets = { claudeDir: path.join(root, 'no-claude'), codexHome: path.join(root, 'no-codex') };
        const cache = emptyCache();

        // First tick only stamps the retained month onto a fresh cache.
        assert.strictEqual(await scanAll(cache, targets, Date.now()), true);
        assert.strictEqual(await scanAll(cache, targets, Date.now()), false);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('ignores codex usage replayed before the first turn_context', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-eng-'));
        const nowMs = Date.now();
        const now = new Date(nowMs);
        const iso = now.toISOString();
        const pad = (n: number) => String(n).padStart(2, '0');
        const codexHome = path.join(root, 'codex');
        const dayDir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
        fs.mkdirSync(dayDir, { recursive: true });
        // A forked rollout replays the parent's turns before announcing a model.
        fs.writeFileSync(path.join(dayDir, 'rollout-forked.jsonl'),
            codexTokenCount(iso, 5000, 0, 500) + '\n' +
            JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n' +
            codexTokenCount(iso, 1000, 600, 50) + '\n');

        const cache = emptyCache();
        await scanAll(cache, { codexHome }, nowMs);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['codex/gpt-5.5'].output, 50); // not 550

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('survives the globalState JSON round trip between ticks', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        fs.writeFileSync(claudeFile, claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1 }) + '\n');

        const cache = emptyCache();
        await scanAll(cache, { claudeDir }, nowMs);

        // globalState stores the cache as JSON, so every field the next tick
        // depends on has to be JSON-representable.
        const restored = JSON.parse(JSON.stringify(cache));
        assert.ok(isValidCache(restored));
        assert.strictEqual('dedupe' in restored, false);

        fs.appendFileSync(claudeFile, claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 1000 }) + '\n');
        assert.strictEqual(await scanAll(restored, { claudeDir }, nowMs), true);
        const day = Object.keys(restored.days)[0];
        assert.strictEqual(restored.days[day]['claude/claude-opus-4-8'].output, 1000);
        assert.strictEqual(restored.days[day]['claude/claude-opus-4-8'].input, 100);

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('drops supersede state once a file has gone quiet', async () => {
        const { root, claudeDir, claudeFile } = claudeFixture();
        const nowMs = Date.now();
        const iso = new Date(nowMs).toISOString();
        fs.writeFileSync(claudeFile, claudeLine({ id: 'msg_1', requestId: 'req_1', iso, output: 10 }) + '\n');

        const cache = emptyCache();
        await scanAll(cache, { claudeDir }, nowMs);
        assert.strictEqual(cache.files[claudeFile].pend?.length, 1);

        // A later tick finds the file unchanged and long past the retention
        // window; presence stays, the heavier supersede state goes.
        const later = nowMs + PEND_RETENTION_MS + 60_000;
        assert.strictEqual(await scanAll(cache, { claudeDir }, later), true);
        assert.strictEqual(cache.files[claudeFile].pend, undefined);
        assert.strictEqual(cache.files[claudeFile].seen?.length, 1);
        assert.strictEqual(await scanAll(cache, { claudeDir }, later), false);

        fs.rmSync(root, { recursive: true, force: true });
    });
});

suite('cache.hashKey', () => {
    test('is stable and stays inside the safe-integer range', () => {
        const key = 'msg_01ABCdefGHIjklMNOpqrSTU:req_9f3c1b27-0d4e-4a51-9c2b-77aa1e5b6d80';
        assert.strictEqual(hashKey(key), hashKey(key));
        assert.ok(Number.isSafeInteger(hashKey(key)));
        assert.ok(hashKey(key) >= 0);
    });

    test('separates the near-identical keys the scanners actually produce', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 20_000; i++) {
            seen.add(hashKey(`msg_01ABCdefGHIjklMNOpqrST${i}:req_9f3c1b27-0d4e-4a51-9c2b-77aa1e5b6d${i}`));
            seen.add(hashKey(`codex:${1_780_000_000_000 + i}:${i}:${i * 3}:${i * 7}`));
        }
        assert.strictEqual(seen.size, 40_000);
    });
});

suite('dedupe window', () => {
    const pend = (h: number) => ({
        h,
        d: '2026-06-01',
        b: 'claude/claude-opus-5',
        u: { input: 1, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1 },
    });

    test('evicts the oldest key once the cap is exceeded', () => {
        const window = openWindow(undefined, 3);
        for (const h of [1, 2, 3, 4]) {
            remember(window, h, undefined);
        }
        assert.strictEqual(hasSeen(window, 1), false);
        assert.deepStrictEqual([...window.entries.keys()], [2, 3, 4]);
    });

    test('re-anchors a repeated key on its freshest occurrence', () => {
        const window = openWindow(undefined, 3);
        remember(window, 1, undefined);
        remember(window, 2, undefined);
        remember(window, 1, undefined); // repeat: must move to the back
        remember(window, 3, undefined);
        remember(window, 4, undefined);
        assert.strictEqual(hasSeen(window, 2), false); // evicted instead of key 1
        assert.strictEqual(hasSeen(window, 1), true);
    });

    test('keeps presence but drops supersede state when asked', () => {
        const window = openWindow(undefined, 8);
        remember(window, 11, pend(11));
        remember(window, 12, pend(12));
        const state: FileState = { size: 0, mtimeMs: 0, offset: 0 };

        closeWindow(window, state, true);
        assert.deepStrictEqual(state.seen, [11, 12]);
        assert.strictEqual(state.pend?.length, 2);

        closeWindow(window, state, false);
        assert.deepStrictEqual(state.seen, [11, 12]);
        assert.strictEqual(state.pend, undefined);
    });

    test('caps persisted supersede state at PEND_CAP regardless of window depth', () => {
        const window = openWindow(undefined, PEND_CAP * 4);
        for (let h = 1; h <= PEND_CAP * 2; h++) {
            remember(window, h, pend(h));
        }
        const state: FileState = { size: 0, mtimeMs: 0, offset: 0 };
        closeWindow(window, state, true);
        assert.strictEqual(state.seen?.length, PEND_CAP * 2);
        assert.strictEqual(state.pend?.length, PEND_CAP);
        assert.strictEqual(state.pend?.[PEND_CAP - 1].h, PEND_CAP * 2); // newest retained
    });

    test('reopens a state that was persisted and restored as JSON', () => {
        const window = openWindow(undefined, SEEN_CAP_CODEX);
        remember(window, 101, pend(101));
        remember(window, 102, undefined);
        const state: FileState = { size: 0, mtimeMs: 0, offset: 0 };
        closeWindow(window, state, true);

        const restored: FileState = JSON.parse(JSON.stringify(state));
        const reopened = openWindow(restored, SEEN_CAP_CODEX);
        assert.strictEqual(hasSeen(reopened, 101), true);
        assert.strictEqual(hasSeen(reopened, 102), true);
        assert.strictEqual(pendingFor(reopened, 101)?.u.output, 1);
        assert.strictEqual(pendingFor(reopened, 102), undefined);
        // Order must survive so eviction still drops the oldest key first.
        assert.deepStrictEqual([...reopened.entries.keys()], [101, 102]);
    });
});
