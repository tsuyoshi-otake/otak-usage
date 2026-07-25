import { FileState, PEND_CAP, PendRecord } from './cache';

/**
 * The dedupe window for a single file, held open while that file's new lines
 * are ingested. Insertion order is the ingest order, so the oldest entry is
 * always the first key of the map — evicting it keeps the window anchored on
 * the most recent `cap` keys.
 *
 * A key maps to its supersede state when one is still worth keeping, and to
 * undefined when only its presence matters (Codex keys, and Claude keys that
 * have aged past PEND_CAP).
 */
export interface DedupeWindow {
    entries: Map<number, PendRecord | undefined>;
    cap: number;
}

/** Rebuild the window a previous scan left behind for this file. */
export function openWindow(state: FileState | undefined, cap: number): DedupeWindow {
    const entries = new Map<number, PendRecord | undefined>();
    for (const h of state?.seen ?? []) {
        entries.set(h, undefined);
    }
    // Re-attaching by key preserves each record's place in the ingest order.
    for (const p of state?.pend ?? []) {
        entries.set(p.h, p);
    }
    return { entries, cap };
}

export function hasSeen(window: DedupeWindow, h: number): boolean {
    return window.entries.has(h);
}

/** The supersede state for a key, or undefined when only presence is known. */
export function pendingFor(window: DedupeWindow, h: number): PendRecord | undefined {
    return window.entries.get(h);
}

/**
 * Record a key as ingested. A repeat is re-inserted at the end so that the
 * window stays anchored on its freshest occurrence, which is what a third
 * occurrence would have to reach back past.
 */
export function remember(window: DedupeWindow, h: number, pend: PendRecord | undefined): void {
    window.entries.delete(h);
    window.entries.set(h, pend);
    while (window.entries.size > window.cap) {
        const oldest = window.entries.keys().next().value;
        if (oldest === undefined) {
            return;
        }
        window.entries.delete(oldest);
    }
}

/**
 * Write the window back onto the file state. `keepPend` is false once the file
 * has been quiet long enough that no partial can still be awaiting its final,
 * which keeps supersede state off every idle file in the month.
 */
export function closeWindow(window: DedupeWindow, state: FileState, keepPend: boolean): void {
    const seen = Array.from(window.entries.keys());
    if (seen.length > 0) {
        state.seen = seen;
    } else {
        delete state.seen;
    }
    const pend: PendRecord[] = [];
    if (keepPend) {
        for (let i = Math.max(0, seen.length - PEND_CAP); i < seen.length; i++) {
            const record = window.entries.get(seen[i]);
            if (record) {
                pend.push(record);
            }
        }
    }
    if (pend.length > 0) {
        state.pend = pend;
    } else {
        delete state.pend;
    }
}
