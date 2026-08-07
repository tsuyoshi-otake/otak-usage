import * as path from 'path';
import { isLongContextRequest } from '../pricing';
import { TokenUsage, UsageEvent } from '../types';
import { resolveCodexModel } from './codexAutoReview';
import { ScanIndex, ScannedFile } from './scanIndex';

/**
 * List Codex rollout files for the current month plus the previous month
 * (previous-month files filtered by mtime >= minMtimeMs, to catch sessions
 * that started before the month boundary but continued past it). Session
 * directories are date-structured: <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl.
 */
export async function listCodexFiles(codexHome: string, nowMs: number, minMtimeMs: number): Promise<ScannedFile[]> {
    const out: ScannedFile[] = [];
    for await (const file of iterCodexFiles(codexHome, nowMs, minMtimeMs)) {
        out.push(file);
    }
    return out;
}

/**
 * A caller that keeps its ScanIndex across passes gets incremental listing and
 * age-based stat backoff. The default is a throwaway index, i.e. a full walk.
 */
export async function* iterCodexFiles(
    codexHome: string,
    nowMs: number,
    minMtimeMs: number,
    index: ScanIndex = new ScanIndex(),
): AsyncGenerator<ScannedFile> {
    const now = new Date(nowMs);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    yield* walkMonth(monthDir(codexHome, now), 0, index, nowMs);
    yield* walkMonth(monthDir(codexHome, prev), minMtimeMs, index, nowMs);
}

function monthDir(codexHome: string, d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return path.join(codexHome, 'sessions', String(d.getFullYear()), mm);
}

async function* walkMonth(dir: string, minMtimeMs: number, index: ScanIndex, nowMs: number): AsyncGenerator<ScannedFile> {
    const month = await index.listDir(dir, nowMs);
    if (!month) {
        return;
    }
    for (const day of month.dirs) {
        const dayDir = path.join(dir, day);
        const listing = await index.listDir(dayDir, nowMs);
        if (!listing) {
            continue;
        }
        for (const name of listing.files) {
            const file = await index.statFile(path.join(dayDir, name), nowMs);
            if (file && file.mtimeMs >= minMtimeMs) {
                yield file;
            }
        }
    }
}

/**
 * Per-file parse state. The model is announced by a separate turn_context
 * event, so it must survive across incremental reads of the same file —
 * callers persist lastModel in the scan cache.
 */
export interface CodexParseState {
    lastModel?: string;
}

/**
 * Parse one rollout line. token_count events carry both total_token_usage
 * (cumulative for the session — deliberately ignored) and last_token_usage
 * (this turn only — what we accumulate). In rollout data, cached_input_tokens
 * is a subset of input_tokens and reasoning tokens are included in
 * output_tokens (total_tokens == input_tokens + output_tokens), so cost is
 * (input - cached) * in + cached * cachedIn + output * out.
 */
export function parseCodexLine(line: string, state: CodexParseState): UsageEvent | undefined {
    let rec: any;
    try {
        rec = JSON.parse(line);
    } catch {
        return undefined;
    }
    const payload = rec?.payload;
    if (rec?.type === 'turn_context' && typeof payload?.model === 'string') {
        state.lastModel = payload.model;
        return undefined;
    }
    if (rec?.type !== 'event_msg' || payload?.type !== 'token_count') {
        return undefined;
    }
    const last = payload.info?.last_token_usage;
    if (!last) {
        return undefined;
    }
    // Forked/resumed rollout files can replay historical token_count records
    // before their first turn_context. They have no reliable model attribution
    // and were already counted in the source session, so do not ingest them.
    if (!state.lastModel) {
        return undefined;
    }
    const timestamp = Date.parse(rec.timestamp);
    if (Number.isNaN(timestamp)) {
        return undefined;
    }
    // Auto-review turns name a slug that no price table lists, so it is resolved
    // to the model those requests bill as. `lastModel` deliberately keeps the raw
    // slug so the resolution stays a rendering of it rather than state.
    const model = resolveCodexModel(state.lastModel);
    const rawInput = last.input_tokens ?? 0;
    // Cap defensively: a malformed record must not bill more cached tokens
    // than were actually sent.
    const cachedInput = Math.min(last.cached_input_tokens ?? 0, rawInput);
    const usage: TokenUsage = {
        input: rawInput - cachedInput,
        cachedInput,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: last.output_tokens ?? 0,
    };
    if (isLongContextRequest(model, rawInput)) {
        usage.longContextInput = usage.input;
        usage.longContextCachedInput = usage.cachedInput;
        usage.longContextOutput = usage.output;
    }
    return { provider: 'codex', model, timestamp, usage };
}
