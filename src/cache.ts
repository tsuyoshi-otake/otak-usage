import { DayBuckets, TokenUsage } from './types';

/**
 * v2: fast-mode Claude usage moved to "<model>-fast" buckets.
 * v3: dedupe records carry the counted usage so a later (final) Claude
 * snapshot can supersede an earlier partial one instead of being dropped.
 * v4: force a one-time re-ingest after 1.2.0 installs that may have retained
 * stale file offsets while cost rendering was blocked by RTK stats refresh.
 * Older caches must be re-ingested.
 */
export const CACHE_VERSION = 4;

export interface FileState {
    size: number;
    mtimeMs: number;
    /** Byte offset just past the last complete line already ingested. */
    offset: number;
    /** Codex only: model announced by the last turn_context seen in this file. */
    lastModel?: string;
}

/**
 * What a dedupe key already contributed to the day buckets. Kept so that when
 * the same Claude request is logged again (a streaming partial then the final
 * record, which share input/cache but grow output_tokens), the earlier
 * contribution can be subtracted and replaced by the final one.
 */
export interface DedupeEntry {
    /** Day bucket (YYYY-MM-DD) the usage was added to. */
    day: string;
    /** provider/model bucket key the usage was added to. */
    bucket: string;
    /** The usage already accumulated for this key. */
    usage: TokenUsage;
}

/** Persisted dedupe record: a DedupeEntry plus its key, FIFO-ordered. */
export interface DedupeRecord extends DedupeEntry {
    k: string;
}

export interface ScanCacheData {
    version: number;
    files: Record<string, FileState>;
    days: DayBuckets;
    /** Dedupe records (Claude message.id:requestId / Codex timestamp+tokens), insertion-ordered, FIFO-capped. */
    dedupe: DedupeRecord[];
}

export const DEDUPE_CAP = 50_000;

export function emptyCache(): ScanCacheData {
    return { version: CACHE_VERSION, files: {}, days: {}, dedupe: [] };
}

export function isValidCache(raw: unknown): raw is ScanCacheData {
    const c = raw as ScanCacheData | undefined;
    return !!c &&
        c.version === CACHE_VERSION &&
        typeof c.files === 'object' && c.files !== null &&
        typeof c.days === 'object' && c.days !== null &&
        Array.isArray(c.dedupe);
}

/** Record (or update) a dedupe key, evicting the oldest entry past the cap. */
export function setDedupe(dedupe: Map<string, DedupeEntry>, key: string, entry: DedupeEntry): void {
    dedupe.set(key, entry);
    if (dedupe.size > DEDUPE_CAP) {
        const oldest = dedupe.keys().next().value;
        if (oldest !== undefined && oldest !== key) {
            dedupe.delete(oldest);
        }
    }
}
