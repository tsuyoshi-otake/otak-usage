/**
 * How far a re-check interval scales with idle age: an entry untouched for an
 * hour is re-checked at most every 7.5 minutes. Measured on real logs, 70% of
 * transcript files are older than a week and only 2.3% are younger than a day,
 * so backing off by age removes almost the entire per-tick stat load while
 * leaving the handful of active files on every tick.
 */
export const AGE_DIVISOR = 8;

/**
 * Ceiling on how long a directory may go unchecked. A directory stat is the
 * gate on discovering a *new* session, so it is deliberately about one refresh
 * interval: there are only a few hundred directories, and the listing itself is
 * still skipped unless the mtime moved. Delaying this would mean a session you
 * just started shows no cost for minutes.
 */
export const DIR_MAX_RECHECK_MS = 60_000;

/**
 * Ceiling on how long a known file may go un-stat()ed. Files outnumber
 * directories four to one and carry the bulk of the cost, but a stale one only
 * matters when an old session is resumed — appends to the session you are in
 * keep its mtime at "now", which the age backoff already treats as hot.
 */
export const FILE_MAX_RECHECK_MS = 10 * 60_000;

/**
 * How long to wait before re-checking something last changed `ageMs` ago.
 * A non-positive or non-finite age (just changed, or a clock that jumped)
 * yields 0 so the entry stays due.
 */
export function recheckIntervalMs(ageMs: number, maxMs: number): number {
    if (!Number.isFinite(ageMs) || ageMs <= 0) {
        return 0;
    }
    return Math.min(maxMs, ageMs / AGE_DIVISOR);
}

/**
 * Deterministic 0..1 spread derived from the key. Thousands of files share
 * almost the same idle age, so without this they would all fall due on the
 * same tick and rebuild the burst the backoff was meant to remove.
 */
export function jitterFactor(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0) / 0x1_0000_0000;
}

/**
 * Tracks when each key should next be looked at. Pure bookkeeping — it never
 * touches the filesystem, so the backoff policy can be tested on its own.
 */
export class RecheckScheduler {
    private readonly dueAt = new Map<string, number>();

    constructor(private readonly maxMs: number) { }

    get size(): number {
        return this.dueAt.size;
    }

    /** Unknown keys are always due, so newly discovered entries are never delayed. */
    isDue(key: string, nowMs: number): boolean {
        const at = this.dueAt.get(key);
        return at === undefined || nowMs >= at;
    }

    /** Record a look at `key`, whose subject last changed at `mtimeMs`. */
    observed(key: string, mtimeMs: number, nowMs: number): void {
        const interval = recheckIntervalMs(nowMs - mtimeMs, this.maxMs);
        // Spread over a full interval, not a fraction of one. Thousands of
        // files pin to the same capped interval, and because the jitter is a
        // function of the key their phases never drift apart on their own: a
        // narrower spread leaves half of every period idle and the other half
        // carrying the entire fleet in one burst.
        this.dueAt.set(key, nowMs + interval * (0.5 + jitterFactor(key)));
    }

    /** Make `key` due again — something next to it changed. */
    touch(key: string): void {
        this.dueAt.delete(key);
    }

    forget(key: string): void {
        this.dueAt.delete(key);
    }

    clear(): void {
        this.dueAt.clear();
    }
}
