import { DayBuckets, TokenUsage } from './types';

/**
 * v2: fast-mode Claude usage moved to "<model>-fast" buckets.
 * v3: dedupe records carry the counted usage so a later (final) Claude
 * snapshot can supersede an earlier partial one instead of being dropped.
 * v4: force a one-time re-ingest after 1.2.0 installs that may have retained
 * stale file offsets while cost rendering was blocked by RTK stats refresh.
 * v5: capture per-turn long-context pricing and skip replayed Codex usage that
 * appears before the first model-bearing turn_context in forked sessions.
 * v6: the month-wide dedupe map (50k records, ~10 MB of persisted state) is
 * replaced by the per-file `seen`/`pend` windows below.
 * Older caches must be re-ingested.
 */
export const CACHE_VERSION = 6;

/**
 * A record that may still be superseded. Claude logs a streaming partial
 * snapshot and then a final one under the same message.id:requestId, so the
 * partial's contribution has to be subtracted before the final one is added —
 * which needs the day and bucket it landed in plus the usage it contributed.
 */
export interface PendRecord {
    /** hashKey() of the dedupe key. */
    h: number;
    /** Day bucket (YYYY-MM-DD) the usage was added to. */
    d: string;
    /** provider/model bucket key the usage was added to. */
    b: string;
    /** The usage already accumulated for this key. */
    u: TokenUsage;
}

export interface FileState {
    size: number;
    mtimeMs: number;
    /** Byte offset just past the last complete line already ingested. */
    offset: number;
    /** Codex only: model announced by the last turn_context seen in this file. */
    lastModel?: string;
    /**
     * hashKey() of the dedupe keys most recently ingested from this file,
     * oldest first. A duplicate key never appears in two different files
     * (measured: 0 of 410k keys), so presence only has to be remembered per
     * file, and only as deep as the largest in-file gap between duplicates.
     */
    seen?: number[];
    /** The tail of `seen` that still carries supersede state (Claude only). */
    pend?: PendRecord[];
}

export interface ScanCacheData {
    version: number;
    files: Record<string, FileState>;
    days: DayBuckets;
    /**
     * Month (YYYY-MM) the retained day buckets belong to. Days and file states
     * can only fall out of retention when this rolls over, so the O(files)
     * prune runs on that tick alone instead of on every tick.
     */
    month?: string;
}

/**
 * Window depth for Claude transcripts. The deepest measured gap between two
 * occurrences of one message.id:requestId is 467 records — resumed sessions
 * replay their history verbatim — so 512 covers the observed worst case.
 */
export const SEEN_CAP_CLAUDE = 512;

/**
 * Window depth for Codex rollouts. Their dedupe key embeds the timestamp, so
 * duplicates are adjacent: the deepest measured gap is 2 records.
 */
export const SEEN_CAP_CODEX = 32;

/**
 * How many trailing records keep their supersede state. Every measured Claude
 * partial/final pair sits within 24 records of itself; deeper repeats are
 * history replays that never grow (0 of 1,281 observed), so presence alone is
 * the right answer for them.
 */
export const PEND_CAP = 32;

/**
 * Drop supersede state for files idle longer than this. A partial and its
 * final are written within one streamed response (13.2 min at the measured
 * worst case), and the partial itself refreshes mtime, so a file cannot go
 * this quiet while a pair is still open.
 */
export const PEND_RETENTION_MS = 30 * 60_000;

/**
 * 53-bit digest of a dedupe key. Keys run 40-90 characters, so retaining them
 * verbatim would cost more than the map this replaces, while a 53-bit value
 * still fits a plain JSON number. Collisions only matter within one file's
 * window (<= 512 keys), where the birthday probability is ~1.5e-11.
 */
export function hashKey(key: string): number {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h1 >>> 13);
    }
    // 21 high bits from h2 + 32 bits from h1 = 53 bits, the exact integer range.
    return (h2 >>> 11) * 0x1_0000_0000 + (h1 >>> 0);
}

export function emptyCache(): ScanCacheData {
    return { version: CACHE_VERSION, files: {}, days: {} };
}

export function isValidCache(raw: unknown): raw is ScanCacheData {
    const c = raw as ScanCacheData | undefined;
    return !!c &&
        c.version === CACHE_VERSION &&
        typeof c.files === 'object' && c.files !== null &&
        typeof c.days === 'object' && c.days !== null;
}
