import { addEvent, pruneDaysBefore } from './aggregator';
import { FileState, ScanCacheData, addDedupeKey } from './cache';
import { dayKey, startOfMonth } from './period';
import { UsageEvent } from './types';
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
export async function scanAll(cache: ScanCacheData, dedupe: Set<string>, targets: ScanTargets, nowMs: number): Promise<boolean> {
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
            if (parsed.dedupeKey) {
                if (dedupe.has(parsed.dedupeKey)) {
                    return undefined;
                }
                addDedupeKey(dedupe, parsed.dedupeKey);
            }
            return parsed.event;
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
