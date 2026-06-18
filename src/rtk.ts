import { execFile } from 'child_process';

/** Aggregated RTK (Rust Token Killer) token stats for one period. */
export interface RtkPeriodStats {
    commands: number;
    inputTokens: number;
    outputTokens: number;
    savedTokens: number;
}

export interface RtkStats {
    today: RtkPeriodStats;
    month: RtkPeriodStats;
    allTime: RtkPeriodStats;
}

export function emptyRtkPeriod(): RtkPeriodStats {
    return { commands: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0 };
}

/**
 * Savings rate in percent using rtk's own formula (saved / input).
 * undefined when there is no input to compare against.
 */
export function rtkSavingsPct(s: RtkPeriodStats): number | undefined {
    return s.inputTokens > 0 ? (s.savedTokens / s.inputTokens) * 100 : undefined;
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Parse `rtk gain --daily --format json` output into today / this-month /
 * all-time aggregates. Daily entries carry local-time "YYYY-MM-DD" dates,
 * matching the extension's local-time day keys.
 */
export function parseRtkGain(raw: string, todayKey: string): RtkStats | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const summary = (parsed as Record<string, unknown>).summary;
    if (typeof summary !== 'object' || summary === null) {
        return undefined;
    }
    const s = summary as Record<string, unknown>;
    const allTime: RtkPeriodStats = {
        commands: num(s.total_commands),
        inputTokens: num(s.total_input),
        outputTokens: num(s.total_output),
        savedTokens: num(s.total_saved),
    };
    const today = emptyRtkPeriod();
    const month = emptyRtkPeriod();
    const monthPrefix = todayKey.slice(0, 7);
    const daily = (parsed as Record<string, unknown>).daily;
    if (Array.isArray(daily)) {
        for (const entry of daily) {
            if (typeof entry !== 'object' || entry === null) {
                continue;
            }
            const e = entry as Record<string, unknown>;
            const date = typeof e.date === 'string' ? e.date : '';
            if (!date.startsWith(monthPrefix)) {
                continue;
            }
            addPeriod(month, e);
            if (date === todayKey) {
                addPeriod(today, e);
            }
        }
    }
    return { today, month, allTime };
}

function addPeriod(target: RtkPeriodStats, e: Record<string, unknown>): void {
    target.commands += num(e.commands);
    target.inputTokens += num(e.input_tokens);
    target.outputTokens += num(e.output_tokens);
    target.savedTokens += num(e.saved_tokens);
}

/**
 * Run the rtk CLI and collect savings stats. Resolves to undefined when the
 * binary is missing, times out, or prints something unparseable — the caller
 * treats that as "rtk not available" and hides the segment.
 */
export function fetchRtkStats(rtkPath: string | undefined, todayKey: string): Promise<RtkStats | undefined> {
    const exe = rtkPath && rtkPath.trim() !== '' ? rtkPath.trim() : 'rtk';
    return new Promise((resolve) => {
        execFile(
            exe,
            ['gain', '--daily', '--format', 'json'],
            { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
                resolve(err ? undefined : parseRtkGain(stdout, todayKey));
            },
        );
    });
}
