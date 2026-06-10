import { DayBuckets } from './types';

export const CACHE_VERSION = 1;

export interface FileState {
    size: number;
    mtimeMs: number;
    /** Byte offset just past the last complete line already ingested. */
    offset: number;
    /** Codex only: model announced by the last turn_context seen in this file. */
    lastModel?: string;
}

export interface ScanCacheData {
    version: number;
    files: Record<string, FileState>;
    days: DayBuckets;
    /** Claude dedupe keys (message.id:requestId), insertion-ordered, FIFO-capped. */
    dedupe: string[];
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

export function addDedupeKey(dedupe: Set<string>, key: string): void {
    dedupe.add(key);
    if (dedupe.size > DEDUPE_CAP) {
        const oldest = dedupe.values().next().value;
        if (oldest !== undefined) {
            dedupe.delete(oldest);
        }
    }
}
