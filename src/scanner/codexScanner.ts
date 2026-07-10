import * as fsp from 'fs/promises';
import * as path from 'path';
import { isLongContextRequest } from '../pricing';
import { TokenUsage, UsageEvent } from '../types';
import { ScannedFile } from './claudeScanner';

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

export async function* iterCodexFiles(codexHome: string, nowMs: number, minMtimeMs: number): AsyncGenerator<ScannedFile> {
    const now = new Date(nowMs);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    yield* walkMonth(monthDir(codexHome, now), 0);
    yield* walkMonth(monthDir(codexHome, prev), minMtimeMs);
}

function monthDir(codexHome: string, d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return path.join(codexHome, 'sessions', String(d.getFullYear()), mm);
}

async function* walkMonth(dir: string, minMtimeMs: number): AsyncGenerator<ScannedFile> {
    let monthHandle: Awaited<ReturnType<typeof fsp.opendir>>;
    try {
        monthHandle = await fsp.opendir(dir);
    } catch {
        return;
    }
    try {
        for await (const dayDir of monthHandle) {
            if (!dayDir.isDirectory()) {
                continue;
            }
            let dayHandle: Awaited<ReturnType<typeof fsp.opendir>>;
            try {
                dayHandle = await fsp.opendir(path.join(dir, dayDir.name));
            } catch {
                continue;
            }
            try {
                for await (const file of dayHandle) {
                    if (!file.isFile() || !file.name.endsWith('.jsonl')) {
                        continue;
                    }
                    const p = path.join(dir, dayDir.name, file.name);
                    try {
                        const st = await fsp.stat(p);
                        if (st.mtimeMs >= minMtimeMs) {
                            yield { path: p, size: st.size, mtimeMs: st.mtimeMs };
                        }
                    } catch {
                        // file vanished between opendir and stat
                    }
                }
            } catch {
                continue; // day directory changed while scanning
            }
        }
    } catch {
        return; // month directory changed while scanning
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
    if (isLongContextRequest(state.lastModel, rawInput)) {
        usage.longContextInput = usage.input;
        usage.longContextCachedInput = usage.cachedInput;
        usage.longContextOutput = usage.output;
    }
    return { provider: 'codex', model: state.lastModel, timestamp, usage };
}
