export type Period = 'today' | 'month';

/** Local-time day key, e.g. "2026-06-10". */
export function dayKey(epochMs: number): string {
    const d = new Date(epochMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Epoch ms of local midnight for the given time. */
export function startOfToday(nowMs: number): number {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Epoch ms of local midnight on the 1st of the current month. */
export function startOfMonth(nowMs: number): number {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d.getTime();
}

/** Epoch ms of local midnight on the last day of the previous month. */
export function lastDayOfPrevMonth(nowMs: number): number {
    const d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), 0).getTime();
}
