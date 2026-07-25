import { ProviderLimits } from '../limits';
import { RtkStats } from '../rtk';
import { DayBuckets } from '../types';
import { readJsonFile, writeFileAtomic } from './atomicFile';

export const SNAPSHOT_VERSION = 1;

/**
 * What the leader publishes for the other windows to render.
 *
 * It carries raw per-day, per-model token buckets rather than finished costs:
 * `pricingOverrides`, the visibility toggles, the period and the status-bar
 * mode are all per-window settings, and a workspace may legitimately set them
 * differently. The expensive half (walking the logs, the network calls, the
 * `rtk` child process) is what the leader owns; summarizing is pure arithmetic
 * every window can afford to do for itself.
 */
export interface SharedSnapshot {
    version: number;
    /** Epoch ms the leader produced this. */
    updatedAtMs: number;
    /** Instance id of the publishing leader; diagnostic only. */
    leader: string;
    days: DayBuckets;
    claudeAvailable: boolean;
    codexAvailable: boolean;
    claudeLimits?: ProviderLimits;
    codexLimits?: ProviderLimits;
    rtk?: RtkStats;
}

export function isSharedSnapshot(raw: unknown): raw is SharedSnapshot {
    const s = raw as SharedSnapshot | undefined;
    return !!s && typeof s === 'object' &&
        s.version === SNAPSHOT_VERSION &&
        typeof s.updatedAtMs === 'number' && Number.isFinite(s.updatedAtMs) &&
        typeof s.claudeAvailable === 'boolean' &&
        typeof s.codexAvailable === 'boolean' &&
        isDayBuckets(s.days);
}

/**
 * Reject a malformed `days` outright instead of letting a bad number reach the
 * arithmetic in `summarize()`, where it would surface as a `NaN` cost with no
 * hint of where it came from.
 */
function isDayBuckets(raw: unknown): raw is DayBuckets {
    if (!isRecord(raw)) {
        return false;
    }
    for (const bucket of Object.values(raw)) {
        if (!isRecord(bucket)) {
            return false;
        }
        for (const usage of Object.values(bucket)) {
            if (!isRecord(usage)) {
                return false;
            }
            for (const value of Object.values(usage)) {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    return false;
                }
            }
        }
    }
    return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The published snapshot, or undefined when there is none or it is unusable. */
export async function readSharedSnapshot(filePath: string): Promise<SharedSnapshot | undefined> {
    const raw = await readJsonFile(filePath);
    return isSharedSnapshot(raw) ? raw : undefined;
}

export async function writeSharedSnapshot(filePath: string, tag: string, snapshot: SharedSnapshot): Promise<void> {
    await writeFileAtomic(filePath, tag, JSON.stringify(snapshot));
}
