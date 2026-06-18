export const DAILY_ALERT_DEFAULT_THRESHOLD_USD = 10;

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
