export const DAILY_ALERT_DEFAULT_THRESHOLD_USD = 10;
export const LIMIT_ALERT_DEFAULT_THRESHOLD_PERCENT = 80;

/**
 * Which signal fires the desktop notification: the daily USD total (`cost`),
 * a subscription rate-limit window crossing its percentage (`limit`), both,
 * or nothing (`off`).
 */
export type AlertMode = 'off' | 'cost' | 'limit' | 'both';

export function normalizeAlertMode(value: unknown): AlertMode {
    return value === 'off' || value === 'cost' || value === 'limit' || value === 'both' ? value : 'both';
}

export function alertModeIncludesCost(mode: AlertMode): boolean {
    return mode === 'cost' || mode === 'both';
}

export function alertModeIncludesLimit(mode: AlertMode): boolean {
    return mode === 'limit' || mode === 'both';
}

export function normalizeLimitAlertThresholdPercent(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return LIMIT_ALERT_DEFAULT_THRESHOLD_PERCENT;
    }
    return Math.min(100, Math.max(0, value));
}

export interface DailyAlertState {
    day: string;
    thresholdUsd: number;
    costUsd: number;
}

export interface DailyAlertDecision {
    shouldNotify: boolean;
    nextState: DailyAlertState | undefined;
}

export function normalizeDailyAlertThresholdUsd(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DAILY_ALERT_DEFAULT_THRESHOLD_USD;
    }
    return Math.max(0, value);
}

export function isValidDailyAlertState(raw: unknown): raw is DailyAlertState {
    const state = raw as DailyAlertState | undefined;
    return !!state &&
        typeof state.day === 'string' &&
        typeof state.thresholdUsd === 'number' &&
        Number.isFinite(state.thresholdUsd) &&
        typeof state.costUsd === 'number' &&
        Number.isFinite(state.costUsd);
}

export function sameDailyAlertState(a: DailyAlertState | undefined, b: DailyAlertState | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.day === b.day && a.thresholdUsd === b.thresholdUsd && a.costUsd === b.costUsd;
}

export function evaluateDailyAlert(
    todayCostUsd: number,
    thresholdUsd: number,
    day: string,
    state: DailyAlertState | undefined,
): DailyAlertDecision {
    const currentDayState = state?.day === day ? state : undefined;

    if (!Number.isFinite(todayCostUsd) || todayCostUsd < 0) {
        return { shouldNotify: false, nextState: currentDayState };
    }
    if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
        return { shouldNotify: false, nextState: currentDayState };
    }
    if (todayCostUsd < thresholdUsd) {
        return { shouldNotify: false, nextState: currentDayState };
    }
    if (currentDayState && currentDayState.thresholdUsd >= thresholdUsd) {
        return { shouldNotify: false, nextState: currentDayState };
    }

    return {
        shouldNotify: true,
        nextState: { day, thresholdUsd, costUsd: todayCostUsd },
    };
}

// ---------------------------------------------------------------------------
// Subscription rate-limit alerts
// ---------------------------------------------------------------------------

/** One candidate rate-limit window to evaluate for the percentage alert. */
export interface LimitAlertWindow {
    /** stable per-window identity, e.g. "claude:primary" */
    id: string;
    /** provider display name for the notification, e.g. "Claude" */
    provider: string;
    /** window display name for the notification, e.g. "5h" */
    window: string;
    /** 0-100 utilization of the window */
    usedPercent: number;
    /** window reset time; identifies the current window instance */
    resetsAtMs?: number;
}

/** Record of the last notification fired for a given window id. */
export interface LimitAlertNotified {
    /** window instance identity; null when the provider did not report a reset time */
    resetsAtMs: number | null;
    /** the threshold at which we last notified; higher = more severe already sent */
    thresholdPercent: number;
}

export interface LimitAlertState {
    notified: Record<string, LimitAlertNotified>;
}

export interface LimitAlertDecision {
    /** windows that crossed the threshold and should notify now */
    triggered: LimitAlertWindow[];
    nextState: LimitAlertState;
}

export function isValidLimitAlertState(raw: unknown): raw is LimitAlertState {
    const state = raw as LimitAlertState | undefined;
    if (!state || typeof state !== 'object' || typeof state.notified !== 'object' || state.notified === null) {
        return false;
    }
    for (const entry of Object.values(state.notified)) {
        const e = entry as LimitAlertNotified | undefined;
        if (!e ||
            (e.resetsAtMs !== null && (typeof e.resetsAtMs !== 'number' || !Number.isFinite(e.resetsAtMs))) ||
            typeof e.thresholdPercent !== 'number' || !Number.isFinite(e.thresholdPercent)) {
            return false;
        }
    }
    return true;
}

export function sameLimitAlertState(a: LimitAlertState | undefined, b: LimitAlertState | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    const aKeys = Object.keys(a.notified);
    const bKeys = Object.keys(b.notified);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        const ea = a.notified[key];
        const eb = b.notified[key];
        if (!eb || ea.resetsAtMs !== eb.resetsAtMs || ea.thresholdPercent !== eb.thresholdPercent) {
            return false;
        }
    }
    return true;
}

/**
 * Fire once per window instance when it reaches the threshold. A window is
 * re-armed only when its reset time changes (a fresh instance) or the user
 * raises the threshold above the level already notified — mirroring the daily
 * cost alert's suppression. State for windows no longer present is dropped, so
 * the record cannot grow unbounded.
 */
export function evaluateLimitAlert(
    windows: LimitAlertWindow[],
    thresholdPercent: number,
    state: LimitAlertState | undefined,
): LimitAlertDecision {
    const prev = state?.notified ?? {};
    const nextNotified: Record<string, LimitAlertNotified> = {};
    const triggered: LimitAlertWindow[] = [];

    for (const w of windows) {
        const resetsAtMs = w.resetsAtMs ?? null;
        const previous = prev[w.id];
        // Only carry the previous record while the same window instance is live.
        const carried = previous && previous.resetsAtMs === resetsAtMs ? previous : undefined;

        const crosses = thresholdPercent > 0 && Number.isFinite(w.usedPercent) && w.usedPercent >= thresholdPercent;
        if (crosses) {
            const alreadyNotified = !!carried && carried.thresholdPercent >= thresholdPercent;
            if (!alreadyNotified) {
                triggered.push(w);
            }
            nextNotified[w.id] = {
                resetsAtMs,
                thresholdPercent: Math.max(thresholdPercent, carried?.thresholdPercent ?? 0),
            };
        } else if (carried) {
            nextNotified[w.id] = carried;
        }
    }

    return { triggered, nextState: { notified: nextNotified } };
}
