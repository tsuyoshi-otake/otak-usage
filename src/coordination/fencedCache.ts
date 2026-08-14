import { ScanCacheData, isValidCache } from '../cache';
import { LeaseFence } from './leaderLock';

export const FENCED_CACHE_VERSION = 1;
export const FENCED_CACHE_PREFIX = 'otakUsage.scanCache.fenced';

export interface FencedCacheRecord {
    version: number;
    group: string;
    fence: LeaseFence;
    cache: ScanCacheData;
}

export function fencedCacheKey(group: string, fence: LeaseFence): string {
    const token = fence.leaseToken.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${FENCED_CACHE_PREFIX}.${group}.${fence.epoch}.${token}`;
}

export function fencedCacheGroupPrefix(group: string): string {
    return `${FENCED_CACHE_PREFIX}.${group}.`;
}

export function makeFencedCacheRecord(group: string, fence: LeaseFence, cache: ScanCacheData): FencedCacheRecord {
    return { version: FENCED_CACHE_VERSION, group, fence: { ...fence }, cache };
}

export function readFencedCacheRecord(raw: unknown, group: string, fence: LeaseFence): ScanCacheData | undefined {
    const record = raw as FencedCacheRecord | undefined;
    if (!record || typeof record !== 'object' || record.version !== FENCED_CACHE_VERSION ||
        record.group !== group || !sameFence(record.fence, fence) || !isValidCache(record.cache)) {
        return undefined;
    }
    return record.cache;
}

function sameFence(left: LeaseFence | undefined, right: LeaseFence): boolean {
    return !!left && left.epoch === right.epoch && left.holder === right.holder && left.leaseToken === right.leaseToken;
}
