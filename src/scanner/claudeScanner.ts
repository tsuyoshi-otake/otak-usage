import * as path from 'path';
import { FAST_SUFFIX } from '../pricing';
import { TokenUsage, UsageEvent } from '../types';
import { ScanIndex } from './scanIndex';

export type { ScannedFile } from './scanIndex';
import type { ScannedFile } from './scanIndex';

/**
 * List Claude Code transcript files under <claudeDir>/projects modified at or
 * after minMtimeMs. Transcripts are append-only, so a file whose mtime is
 * older than the start of the month cannot contain records for this month.
 */
export async function listClaudeFiles(claudeDir: string, minMtimeMs: number): Promise<ScannedFile[]> {
    const out: ScannedFile[] = [];
    for await (const file of iterClaudeFiles(claudeDir, minMtimeMs)) {
        out.push(file);
    }
    return out;
}

/**
 * A caller that keeps its ScanIndex across passes gets incremental listing and
 * age-based stat backoff. The default is a throwaway index, i.e. a full walk.
 */
export async function* iterClaudeFiles(
    claudeDir: string,
    minMtimeMs: number,
    index: ScanIndex = new ScanIndex(),
    nowMs: number = Date.now(),
): AsyncGenerator<ScannedFile> {
    yield* walk(path.join(claudeDir, 'projects'), minMtimeMs, index, nowMs);
}

async function* walk(dir: string, minMtimeMs: number, index: ScanIndex, nowMs: number): AsyncGenerator<ScannedFile> {
    const listing = await index.listDir(dir, nowMs);
    if (!listing) {
        return;
    }
    for (const name of listing.dirs) {
        yield* walk(path.join(dir, name), minMtimeMs, index, nowMs);
    }
    for (const name of listing.files) {
        const file = await index.statFile(path.join(dir, name), nowMs);
        if (file && file.mtimeMs >= minMtimeMs) {
            yield file;
        }
    }
}

export interface ClaudeParseResult {
    event: UsageEvent;
    /**
     * Claude Code writes one transcript line per content block, each repeating
     * the same message.usage, so counting every line would overcount. Callers
     * must count a given dedupeKey only once.
     */
    dedupeKey: string | undefined;
}

export function parseClaudeLine(line: string): ClaudeParseResult | undefined {
    let rec: any;
    try {
        rec = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (rec?.type !== 'assistant') {
        return undefined;
    }
    const msg = rec.message;
    const usage = msg?.usage;
    if (typeof msg?.model !== 'string' || !usage || msg.model === '<synthetic>') {
        return undefined;
    }
    const timestamp = Date.parse(rec.timestamp);
    if (Number.isNaN(timestamp)) {
        return undefined;
    }
    // Prefer the 5m/1h cache-write breakdown when present (different prices).
    let cacheWrite5m = 0;
    let cacheWrite1h = 0;
    const cc = usage.cache_creation;
    if (cc && typeof cc === 'object') {
        cacheWrite5m = cc.ephemeral_5m_input_tokens ?? 0;
        cacheWrite1h = cc.ephemeral_1h_input_tokens ?? 0;
    } else {
        cacheWrite5m = usage.cache_creation_input_tokens ?? 0;
    }
    const tokenUsage: TokenUsage = {
        input: usage.input_tokens ?? 0,
        cachedInput: 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite5m,
        cacheWrite1h,
        output: usage.output_tokens ?? 0,
    };
    const dedupeKey = typeof msg.id === 'string' && typeof rec.requestId === 'string'
        ? `${msg.id}:${rec.requestId}`
        : undefined;
    // Fast mode is billed at premium rates — keep it as a separate
    // "<model>-fast" SKU for pricing and the per-model breakdown.
    const model = usage.speed === 'fast' ? msg.model + FAST_SUFFIX : msg.model;
    return {
        event: { provider: 'claude', model, timestamp, usage: tokenUsage },
        dedupeKey,
    };
}
