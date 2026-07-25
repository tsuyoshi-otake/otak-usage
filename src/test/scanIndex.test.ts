import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyCache } from '../cache';
import { scanAll } from '../engine';
import { DIR_FULL_RELIST_MS, ScanIndex } from '../scanner/scanIndex';
import { DIR_MAX_RECHECK_MS, FILE_MAX_RECHECK_MS, RecheckScheduler, jitterFactor, recheckIntervalMs } from '../scanner/scheduler';

/**
 * A fixed instant well inside the current month. These tests move a clock by
 * minutes, and straddling a month boundary would change what scanAll considers
 * in scope.
 */
function midMonthMs(): number {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 15, 12, 0, 0, 0).getTime();
}

function setMtime(target: string, ms: number): void {
    const t = new Date(ms);
    fs.utimesSync(target, t, t);
}

function claudeLine(id: string, requestId: string, iso: string, output: number): string {
    return JSON.stringify({
        type: 'assistant',
        requestId,
        timestamp: iso,
        message: {
            id,
            model: 'claude-opus-4-8',
            usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: output },
        },
    });
}

const CHANGED_AT = midMonthMs();
/** An hour of quiet after CHANGED_AT: long enough for the backoff to engage. */
const SETTLED = CHANGED_AT + 60 * 60_000;

suite('scanner.scheduler', () => {
    test('backs off proportionally to idle age, capped at the maximum', () => {
        assert.strictEqual(recheckIntervalMs(80_000, FILE_MAX_RECHECK_MS), 10_000);
        assert.strictEqual(recheckIntervalMs(7 * 24 * 3600_000, FILE_MAX_RECHECK_MS), FILE_MAX_RECHECK_MS);
        // Just changed, or a clock that jumped backwards -> stay due.
        assert.strictEqual(recheckIntervalMs(0, FILE_MAX_RECHECK_MS), 0);
        assert.strictEqual(recheckIntervalMs(-5_000, FILE_MAX_RECHECK_MS), 0);
        assert.strictEqual(recheckIntervalMs(NaN, FILE_MAX_RECHECK_MS), 0);
    });

    test('spreads equally aged keys across the interval instead of bunching them', () => {
        const keys = ['a/1.jsonl', 'a/2.jsonl', 'b/3.jsonl'];
        const factors = keys.map(jitterFactor);
        for (const f of factors) {
            assert.ok(f >= 0 && f < 1, `jitter ${f} out of range`);
        }
        assert.strictEqual(new Set(factors).size, keys.length);
        assert.strictEqual(jitterFactor(keys[0]), factors[0]); // deterministic
    });

    test('treats an unknown key as due and a just-observed one as not', () => {
        const s = new RecheckScheduler(FILE_MAX_RECHECK_MS);
        assert.strictEqual(s.isDue('x', 1_000), true);
        s.observed('x', 0, 1_000_000); // idle 1000 s -> ~125 s interval
        assert.strictEqual(s.isDue('x', 1_000_000), false);
        assert.strictEqual(s.isDue('x', 1_000_000 + FILE_MAX_RECHECK_MS), true);
        s.observed('x', 0, 1_000_000);
        s.touch('x');
        assert.strictEqual(s.isDue('x', 1_000_000), true);
    });

    test('keeps an entry that changed this instant due on every pass', () => {
        const s = new RecheckScheduler(FILE_MAX_RECHECK_MS);
        s.observed('hot', 5_000, 5_000);
        assert.strictEqual(s.isDue('hot', 5_000), true);
    });

    test('forgets one key and clears them all', () => {
        const s = new RecheckScheduler(DIR_MAX_RECHECK_MS);
        s.observed('a', 0, 1_000_000);
        s.observed('b', 0, 1_000_000);
        assert.strictEqual(s.size, 2);
        s.forget('a');
        assert.strictEqual(s.isDue('a', 1_000_000), true);
        assert.strictEqual(s.isDue('b', 1_000_000), false);
        s.clear();
        assert.strictEqual(s.size, 0);
    });
});

suite('scanner.ScanIndex', () => {
    /** A directory holding `names`, with every mtime pinned to CHANGED_AT. */
    function dirFixture(names: string[]): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-idx-'));
        for (const name of names) {
            fs.writeFileSync(path.join(root, name), '');
            setMtime(path.join(root, name), CHANGED_AT);
        }
        setMtime(root, CHANGED_AT);
        return root;
    }

    test('reports a missing directory as absent rather than throwing', async () => {
        const missing = path.join(os.tmpdir(), 'otak-usage-idx-does-not-exist');
        assert.strictEqual(await new ScanIndex().listDir(missing, SETTLED), undefined);
    });

    test('splits entries into subdirectories and jsonl files, ignoring anything else', async () => {
        const root = dirFixture(['a.jsonl', 'notes.md']);
        fs.mkdirSync(path.join(root, 'sub'));
        setMtime(root, CHANGED_AT);

        const listing = await new ScanIndex().listDir(root, SETTLED);
        assert.deepStrictEqual(listing?.files, ['a.jsonl']);
        assert.deepStrictEqual(listing?.dirs, ['sub']);
        assert.strictEqual(listing?.provisional, false);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('serves a quiet directory from cache without any syscall', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        await index.listDir(root, SETTLED);

        // A create the filesystem failed to reflect in the mtime stays unseen
        // while the listing is trusted — that is the cost the bounds below cap.
        fs.writeFileSync(path.join(root, 'b.jsonl'), '');
        setMtime(root, CHANGED_AT);
        index.resetStats();
        assert.deepStrictEqual((await index.listDir(root, SETTLED + 1_000))?.files, ['a.jsonl']);
        assert.strictEqual(index.statCount, 0);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('re-reads once the directory falls due and its mtime has moved', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        await index.listDir(root, SETTLED);

        fs.writeFileSync(path.join(root, 'b.jsonl'), '');
        setMtime(root, CHANGED_AT + 60_000);
        const listing = await index.listDir(root, SETTLED + 2 * DIR_MAX_RECHECK_MS);
        assert.deepStrictEqual(listing?.files.slice().sort(), ['a.jsonl', 'b.jsonl']);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('skips the read when the directory is due but its mtime has not moved', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        const first = await index.listDir(root, SETTLED);
        index.resetStats();
        const second = await index.listDir(root, SETTLED + 2 * DIR_MAX_RECHECK_MS);
        assert.strictEqual(second, first); // same object: no re-read happened
        assert.strictEqual(index.statCount, 1); // the stat only
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('re-reads a directory that was read too soon after it changed', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        const listing = await index.listDir(root, CHANGED_AT);
        assert.strictEqual(listing?.provisional, true);

        // A provisional listing is never trusted, so the next look pays for a
        // stat and a read even though nothing is due yet.
        index.resetStats();
        await index.listDir(root, CHANGED_AT + 1);
        assert.strictEqual(index.statCount, 2);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('treats a filesystem clock running ahead of ours as just-changed', async () => {
        const root = dirFixture(['a.jsonl']);
        setMtime(root, SETTLED + 10 * 60_000); // mtime in our future
        const listing = await new ScanIndex().listDir(root, SETTLED);
        assert.strictEqual(listing?.provisional, true);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('re-reads once the listing ages out even if the mtime never moves', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        await index.listDir(root, SETTLED);

        fs.writeFileSync(path.join(root, 'b.jsonl'), '');
        setMtime(root, CHANGED_AT); // a filesystem that never updates the directory
        const listing = await index.listDir(root, SETTLED + DIR_FULL_RELIST_MS + 1_000);
        assert.deepStrictEqual(listing?.files.slice().sort(), ['a.jsonl', 'b.jsonl']);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('stat()s a file only when its backoff says it is due', async () => {
        const root = dirFixture(['a.jsonl']);
        const file = path.join(root, 'a.jsonl');
        const index = new ScanIndex();
        assert.strictEqual((await index.statFile(file, SETTLED))?.mtimeMs, CHANGED_AT);

        index.resetStats();
        assert.strictEqual(await index.statFile(file, SETTLED + 60_000), undefined);
        assert.strictEqual(index.statCount, 0);
        assert.ok(await index.statFile(file, SETTLED + 2 * FILE_MAX_RECHECK_MS));
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('absorbs a file that vanished between the listing and the stat', async () => {
        const root = dirFixture([]);
        const index = new ScanIndex();
        assert.strictEqual(await index.statFile(path.join(root, 'gone.jsonl'), SETTLED), undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reset() drops every cached listing and schedule', async () => {
        const root = dirFixture(['a.jsonl']);
        const index = new ScanIndex();
        await index.listDir(root, SETTLED);
        index.reset();
        index.resetStats();
        await index.listDir(root, SETTLED);
        assert.strictEqual(index.statCount, 2); // stat + read, as if never seen
        fs.rmSync(root, { recursive: true, force: true });
    });
});

suite('engine.scanAll with a retained ScanIndex', () => {
    /**
     * <root>/claude/projects/p1/s1.jsonl with one record, and every directory
     * and file aged an hour so the backoff has something to work with.
     */
    function quietTree(output: number): { root: string; claudeDir: string; file: string; iso: string } {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-idx-scan-'));
        const claudeDir = path.join(root, 'claude');
        const projectDir = path.join(claudeDir, 'projects', 'p1');
        fs.mkdirSync(projectDir, { recursive: true });
        const file = path.join(projectDir, 's1.jsonl');
        const iso = new Date(CHANGED_AT).toISOString();
        fs.writeFileSync(file, claudeLine('m1', 'r1', iso, output) + '\n');
        const quiet = CHANGED_AT - 60 * 60_000;
        setMtime(file, quiet);
        setMtime(projectDir, quiet);
        setMtime(path.join(claudeDir, 'projects'), quiet);
        return { root, claudeDir, file, iso };
    }

    test('makes a quiet tick syscall-free while still ingesting the first pass', async () => {
        const { root, claudeDir } = quietTree(10);
        const index = new ScanIndex();
        const cache = emptyCache();

        assert.strictEqual(await scanAll(cache, { claudeDir }, CHANGED_AT, index), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 10);

        // Inside the shortest jittered directory interval, so nothing is due.
        index.resetStats();
        assert.strictEqual(await scanAll(cache, { claudeDir }, CHANGED_AT + DIR_MAX_RECHECK_MS / 4, index), false);
        assert.strictEqual(index.statCount, 0);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('discovers a session created after the first pass', async () => {
        const { root, claudeDir, file, iso } = quietTree(10);
        const index = new ScanIndex();
        const cache = emptyCache();
        await scanAll(cache, { claudeDir }, CHANGED_AT, index);

        const projectDir = path.dirname(file);
        const second = path.join(projectDir, 's2.jsonl');
        fs.writeFileSync(second, claudeLine('m2', 'r2', iso, 7) + '\n');
        setMtime(second, CHANGED_AT + 5 * 60_000);
        setMtime(projectDir, CHANGED_AT + 5 * 60_000);

        assert.strictEqual(await scanAll(cache, { claudeDir }, CHANGED_AT + 10 * 60_000, index), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 17);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('picks up an append to a file it already knows about', async () => {
        const { root, claudeDir, file, iso } = quietTree(10);
        const index = new ScanIndex();
        const cache = emptyCache();
        await scanAll(cache, { claudeDir }, CHANGED_AT, index);

        fs.appendFileSync(file, claudeLine('m2', 'r2', iso, 5) + '\n');
        setMtime(file, CHANGED_AT + 60_000);
        assert.strictEqual(await scanAll(cache, { claudeDir }, CHANGED_AT + 2 * FILE_MAX_RECHECK_MS, index), true);
        const day = Object.keys(cache.days)[0];
        assert.strictEqual(cache.days[day]['claude/claude-opus-4-8'].output, 15);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('rebuilds the index when the month rolls over', async () => {
        const { root, claudeDir } = quietTree(10);
        const index = new ScanIndex();
        const cache = emptyCache();
        await scanAll(cache, { claudeDir }, CHANGED_AT, index);

        // Next month: the prune drops last month's file state, and the reset
        // means nothing is served from a listing taken under the old scope.
        const then = new Date(CHANGED_AT);
        const nextMonth = new Date(then.getFullYear(), then.getMonth() + 1, 15, 12).getTime();
        index.resetStats();
        assert.strictEqual(await scanAll(cache, { claudeDir }, nextMonth, index), true);
        assert.ok(index.statCount >= 2, `expected a full walk, got ${index.statCount} syscalls`);
        assert.deepStrictEqual(cache.files, {});
        fs.rmSync(root, { recursive: true, force: true });
    });
});
