import { addEvent, pruneDaysBefore } from './aggregator';
import {
    FileState,
    PEND_RETENTION_MS,
    SEEN_CAP_CLAUDE,
    SEEN_CAP_CODEX,
    ScanCacheData,
    hashKey,
} from './cache';
import { DedupeWindow, closeWindow, hasSeen, openWindow, pendingFor, remember } from './dedupe';
import { dayKey, startOfMonth } from './period';
import { UsageEvent, bucketKey, subtractUsage, totalTokens } from './types';
import { visitNewLines } from './scanner/jsonlReader';
import { iterClaudeFiles, parseClaudeLine } from './scanner/claudeScanner';
import { CodexParseState, iterCodexFiles, parseCodexLine } from './scanner/codexScanner';
import { ScanIndex, ScannedFile } from './scanner/scanIndex';

export interface ScanTargets {
    /** undefined = provider directory not found / disabled */
    claudeDir?: string;
    codexHome?: string;
}

/**
 * Incrementally ingest new log lines into cache.days. Only files modified
 * this month are listed; within each file only bytes past the cached offset
 * are read. Returns true if anything in the cache changed (caller persists).
 *
 * `index` carries the directory listings and stat backoff between ticks; pass
 * the same instance every tick to get them. Omitting it walks the tree in full,
 * which is what a one-shot caller wants.
 */
export async function scanAll(
    cache: ScanCacheData,
    targets: ScanTargets,
    nowMs: number,
    index: ScanIndex = new ScanIndex(),
): Promise<boolean> {
    const monthStartMs = startOfMonth(nowMs);
    const monthStartDay = dayKey(monthStartMs);
    const month = monthStartDay.slice(0, 7);
    let changed = false;

    // Nothing can age out of the retained window until the month rolls over,
    // so the two O(files) prunes run on that tick alone. Dropping the index
    // here both clears bookkeeping for paths that just fell out of scope and
    // forces one full walk a month as a backstop against a missed listing.
    if (cache.month !== month) {
        pruneDaysBefore(cache.days, monthStartDay);
        pruneStaleFileStates(cache, monthStartMs);
        index.reset();
        cache.month = month;
        changed = true;
    }

    const [claudeChanged, codexChanged] = await Promise.all([
        targets.claudeDir
            ? scanClaudeFiles(cache, iterClaudeFiles(targets.claudeDir, monthStartMs, index, nowMs), monthStartMs, nowMs)
            : Promise.resolve(false),
        targets.codexHome
            ? scanCodexFiles(cache, iterCodexFiles(targets.codexHome, nowMs, monthStartMs, index), monthStartMs, nowMs)
            : Promise.resolve(false),
    ]);

    return claudeChanged || codexChanged || changed;
}

async function scanClaudeFiles(cache: ScanCacheData, files: AsyncIterable<ScannedFile>, monthStartMs: number, nowMs: number): Promise<boolean> {
    let changed = false;
    for await (const file of files) {
        changed = (await ingestFile(cache, file, nowMs, SEEN_CAP_CLAUDE, true, (line, _state, window) => {
            const parsed = parseClaudeLine(line);
            if (!parsed || parsed.event.timestamp < monthStartMs) {
                return undefined;
            }
            const ev = parsed.event;
            // No dedupe key -> count as-is via the normal add path.
            if (!parsed.dedupeKey) {
                return ev;
            }
            const h = hashKey(parsed.dedupeKey);
            const day = dayKey(ev.timestamp);
            const bucket = bucketKey(ev.provider, ev.model);
            if (!hasSeen(window, h)) {
                addEvent(cache.days, ev);
                remember(window, h, { h, d: day, b: bucket, u: { ...ev.usage } });
                return undefined; // already added directly
            }
            // Same request logged again: Claude streams a partial snapshot
            // (small output_tokens) then a final record that shares input/cache
            // but has the complete output. Keep the larger (final) one by
            // subtracting the earlier contribution and re-adding the final.
            // A repeat with no supersede state left is a replayed history
            // record, which never grows — presence alone settles it.
            const prev = pendingFor(window, h);
            if (prev && totalTokens(ev.usage) > totalTokens(prev.u)) {
                const priorBucket = cache.days[prev.d]?.[prev.b];
                if (priorBucket) {
                    subtractUsage(priorBucket, prev.u);
                }
                addEvent(cache.days, ev);
                remember(window, h, { h, d: day, b: bucket, u: { ...ev.usage } });
            }
            return undefined; // handled directly; never double-add
        })) || changed;
    }
    return changed;
}

async function scanCodexFiles(cache: ScanCacheData, files: AsyncIterable<ScannedFile>, monthStartMs: number, nowMs: number): Promise<boolean> {
    let changed = false;
    for await (const file of files) {
        changed = (await ingestFile(cache, file, nowMs, SEEN_CAP_CODEX, false, (line, state, window) => {
            const parseState: CodexParseState = { lastModel: state.lastModel };
            const event = parseCodexLine(line, parseState);
            state.lastModel = parseState.lastModel;
            if (!event || event.timestamp < monthStartMs) {
                return undefined;
            }
            // Codex has no native turn id, but a token_count duplicated across
            // distinct lines (e.g. a turn logged twice) would otherwise be
            // double-billed. A distinct timestamp+token tuple identifies a turn:
            // two real turns never share a millisecond and an identical count.
            const u = event.usage;
            const h = hashKey(`codex:${event.timestamp}:${u.input}:${u.cachedInput}:${u.output}`);
            if (hasSeen(window, h)) {
                return undefined;
            }
            remember(window, h, undefined);
            return event;
        })) || changed;
    }
    return changed;
}

type LineHandler = (line: string, state: FileState, window: DedupeWindow) => UsageEvent | undefined;

async function ingestFile(
    cache: ScanCacheData,
    file: ScannedFile,
    nowMs: number,
    seenCap: number,
    wantPend: boolean,
    handle: LineHandler,
): Promise<boolean> {
    const state: FileState | undefined = cache.files[file.path];
    // Truncated or replaced — should not happen for append-only logs.
    const restart = !!state && state.offset > file.size;
    if (state && !restart && state.offset === file.size) {
        // Nothing new; refresh metadata only if it drifted.
        let touched = false;
        if (state.size !== file.size || state.mtimeMs !== file.mtimeMs) {
            state.size = file.size;
            state.mtimeMs = file.mtimeMs;
            touched = true;
        }
        // Supersede state is dead weight once the file has gone quiet, and
        // this path would otherwise keep it alive for the whole month.
        if (state.pend && nowMs - file.mtimeMs > PEND_RETENTION_MS) {
            delete state.pend;
            touched = true;
        }
        return touched;
    }
    const next: FileState = state ?? { size: 0, mtimeMs: 0, offset: 0 };
    // The dedupe window survives a restart: whatever the rewrite kept must not
    // be counted a second time, and keys from an unrelated file cannot collide.
    const window = openWindow(state, seenCap);
    if (restart) {
        next.offset = 0;
        delete next.lastModel;
    }
    let result;
    try {
        result = await visitNewLines(file.path, next.offset, (line) => {
            const event = handle(line, next, window);
            if (event) {
                addEvent(cache.days, event);
            }
        });
    } catch {
        return false; // unreadable right now; retry next tick
    }
    // An actively written log usually ends in a partial line, so `offset` stays
    // short of `size` and this path runs every tick. Reporting a change only
    // when one actually happened keeps those ticks from re-persisting the cache.
    const changed = restart ||
        result.newOffset !== next.offset ||
        next.size !== file.size ||
        next.mtimeMs !== file.mtimeMs;
    next.size = file.size;
    next.mtimeMs = file.mtimeMs;
    next.offset = result.newOffset;
    if (changed) {
        closeWindow(window, next, wantPend && nowMs - file.mtimeMs <= PEND_RETENTION_MS);
    }
    cache.files[file.path] = next;
    return changed;
}

/** Drop file states whose mtime fell out of the current month (no longer listed). */
function pruneStaleFileStates(cache: ScanCacheData, monthStartMs: number): boolean {
    let changed = false;
    for (const [p, state] of Object.entries(cache.files)) {
        if (state.mtimeMs < monthStartMs) {
            delete cache.files[p];
            changed = true;
        }
    }
    return changed;
}
