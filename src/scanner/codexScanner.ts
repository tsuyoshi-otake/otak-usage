import * as fsp from 'fs/promises';
import * as path from 'path';
import { TokenUsage, UsageEvent } from '../types';
import { ScannedFile } from './claudeScanner';

/**
 * List Codex rollout files for the current month plus the previous month
 * (previous-month files filtered by mtime >= minMtimeMs, to catch sessions
 * that started before the month boundary but continued past it). Session
 * directories are date-structured: <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl.
 */
export async function listCodexFiles(codexHome: string, nowMs: number, minMtimeMs: number): Promise<ScannedFile[]> {
    const now = new Date(nowMs);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const out: ScannedFile[] = [];
    await walkMonth(monthDir(codexHome, now), 0, out);
    await walkMonth(monthDir(codexHome, prev), minMtimeMs, out);
    return out;
}

function monthDir(codexHome: string, d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return path.join(codexHome, 'sessions', String(d.getFullYear()), mm);
}

async function walkMonth(dir: string, minMtimeMs: number, out: ScannedFile[]): Promise<void> {
    let dayDirs;
    try {
        dayDirs = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const dayDir of dayDirs) {
        if (!dayDir.isDirectory()) {
            continue;
        }
        let files;
        try {
            files = await fsp.readdir(path.join(dir, dayDir.name), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) {
                continue;
            }
            const p = path.join(dir, dayDir.name, file.name);
            try {
                const st = await fsp.stat(p);
                if (st.mtimeMs >= minMtimeMs) {
                    out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
                }
            } catch {
                // file vanished between readdir and stat
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
    const timestamp = Date.parse(rec.timestamp);
    if (Number.isNaN(timestamp)) {
        return undefined;
    }
    const cachedInput = last.cached_input_tokens ?? 0;
    const usage: TokenUsage = {
        input: Math.max(0, (last.input_tokens ?? 0) - cachedInput),
        cachedInput,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: last.output_tokens ?? 0,
    };
    return { provider: 'codex', model: state.lastModel ?? 'unknown', timestamp, usage };
}
