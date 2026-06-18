import { addEvent, pruneDaysBefore } from './aggregator';
import { DedupeEntry, FileState, ScanCacheData, setDedupe } from './cache';
import { dayKey, startOfMonth } from './period';
import { UsageEvent, bucketKey, subtractUsage, totalTokens } from './types';
import { readNewLines } from './scanner/jsonlReader';
import { ScannedFile, listClaudeFiles, parseClaudeLine } from './scanner/claudeScanner';
import { CodexParseState, listCodexFiles, parseCodexLine } from './scanner/codexScanner';

export interface ScanTargets {
    /** undefined = provider directory not found / disabled */
    claudeDir?: string;
    codexHome?: string;
}

/**
 * Incrementally ingest new log lines into cache.days. Only files modified
 * this month are listed; within each file only bytes past the cached offset
 * are read. Returns true if anything in the cache changed (caller persists).
 */
export async function scanAll(cache: ScanCacheData, dedupe: Map<string, DedupeEntry>, targets: ScanTargets, nowMs: number): Promise<boolean> {
    const monthStartMs = startOfMonth(nowMs);
    const monthStartDay = dayKey(monthStartMs);
    let changed = pruneDaysBefore(cache.days, monthStartDay);

    const [claudeFiles, codexFiles] = await Promise.all([
        targets.claudeDir ? listClaudeFiles(targets.claudeDir, monthStartMs) : Promise.resolve([]),
        targets.codexHome ? listCodexFiles(targets.codexHome, nowMs, monthStartMs) : Promise.resolve([]),
    ]);

    for (const file of claudeFiles) {
        changed = (await ingestFile(cache, file, (line) => {
            const parsed = parseClaudeLine(line);
            if (!parsed || parsed.event.timestamp < monthStartMs) {
                return undefined;
            }
            const ev = parsed.event;
            // No dedupe key -> count as-is via the normal add path.
            if (!parsed.dedupeKey) {
                return ev;
            }
            const day = dayKey(ev.timestamp);
            const bucket = bucketKey(ev.provider, ev.model);
            const prev = dedupe.get(parsed.dedupeKey);
            if (!prev) {
                addEvent(cache.days, ev);
                setDedupe(dedupe, parsed.dedupeKey, { day, bucket, usage: { ...ev.usage } });
                return undefined; // already added directly
            }
            // Same request logged again: Claude streams a partial snapshot
            // (small output_tokens) then a final record that shares input/cache
            // but has the complete output. Keep the larger (final) one by
            // subtracting the earlier contribution and re-adding the final.
            if (totalTokens(ev.usage) > totalTokens(prev.usage)) {
                const priorBucket = cache.days[prev.day]?.[prev.bucket];
                if (priorBucket) {
                    subtractUsage(priorBucket, prev.usage);
                }
                addEvent(cache.days, ev);
                setDedupe(dedupe, parsed.dedupeKey, { day, bucket, usage: { ...ev.usage } });
            }
            return undefined; // handled directly; never double-add
        })) || changed;
    }

    for (const file of codexFiles) {
        changed = (await ingestFile(cache, file, (line, state) => {
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
            const dedupeKey = `codex:${event.timestamp}:${u.input}:${u.cachedInput}:${u.output}`;
            if (dedupe.has(dedupeKey)) {
                return undefined;
            }
            setDedupe(dedupe, dedupeKey, {
                day: dayKey(event.timestamp),
                bucket: bucketKey(event.provider, event.model),
                usage: { ...u },
            });
            return event;
        })) || changed;
    }

    changed = pruneStaleFileStates(cache, monthStartMs) || changed;
    return changed;
}

type LineHandler = (line: string, state: FileState) => UsageEvent | undefined;

async function ingestFile(cache: ScanCacheData, file: ScannedFile, handle: LineHandler): Promise<boolean> {
    let state: FileState | undefined = cache.files[file.path];
    if (state && state.offset > file.size) {
        // Truncated or replaced — should not happen for append-only logs.
        state = undefined;
    }
    if (state && state.offset === file.size) {
        // Nothing new; refresh metadata only if it drifted.
        if (state.size !== file.size || state.mtimeMs !== file.mtimeMs) {
            state.size = file.size;
            state.mtimeMs = file.mtimeMs;
            return true;
        }
        return false;
    }
    const next: FileState = state ?? { size: 0, mtimeMs: 0, offset: 0 };
    let result;
    try {
        result = await readNewLines(file.path, next.offset);
    } catch {
        return false; // unreadable right now; retry next tick
    }
    for (const line of result.lines) {
        const event = handle(line, next);
        if (event) {
            addEvent(cache.days, event);
        }
    }
    next.size = file.size;
    next.mtimeMs = file.mtimeMs;
    next.offset = result.newOffset;
    cache.files[file.path] = next;
    return true;
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
