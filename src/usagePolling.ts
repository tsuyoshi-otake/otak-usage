import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { LeaderLock, LeaseFence } from './coordination/leaderLock';
import { readJsonFile, writeFileAtomic } from './coordination/atomicFile';

export interface PollResult<T> {
    kind: 'success' | 'retryable' | 'credentials' | 'unavailable';
    value?: T;
    retryAtMs?: number;
}
interface PollState<T> { nextAtMs: number; failures: number; result: PollResult<T> }
export const USAGE_POLL_INTERVAL_MS = 300_000;

export function httpFailure<T>(response: Response, nowMs: number): PollResult<T> {
    const retry = response.headers?.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry.trim()) ? Number(retry) : undefined;
    const date = retry ? Date.parse(retry) : NaN;
    const retryAtMs = seconds !== undefined ? nowMs + seconds * 1000 : Number.isFinite(date) ? date : undefined;
    return { kind: response.status === 401 || response.status === 403 ? 'credentials' : 'retryable',
        retryAtMs: retryAtMs !== undefined && Number.isFinite(retryAtMs) ? retryAtMs : undefined };
}

/** Durable cooldown per credential identity, independent of scan-group leadership. */
export class UsagePolling {
    private readonly memory = new Map<string, PollState<unknown>>();
    private readonly active = new Map<string, Promise<PollResult<unknown>>>();
    constructor(private readonly random: () => number = Math.random) { }

    poll<T>(storage: string, identity: string, now: number, request: () => Promise<PollResult<T>>): Promise<PollResult<T>> {
        const key = createHash('sha256').update(identity).digest('hex');
        const activeKey = `${storage}:${key}`;
        const pending = this.active.get(activeKey);
        if (pending) { return pending as Promise<PollResult<T>>; }
        const task = this.run(storage, key, now, request);
        this.active.set(activeKey, task);
        const done = () => { this.active.delete(activeKey); };
        void task.then(done, done);
        return task;
    }

    private async run<T>(storage: string, key: string, now: number, request: () => Promise<PollResult<T>>): Promise<PollResult<T>> {
        const base = path.join(storage, `usage-poll-${key}`);
        const lock = storage ? new LeaderLock(`${base}.lock`, randomUUID(), 10) : undefined;
        const artifact = (fence: LeaseFence) => `${base}.${fence.epoch}.${fence.leaseToken}.json`;
        let state = this.memory.get(base) as PollState<T> | undefined;
        let saved = false;
        try {
            if (lock) {
                if (!await lock.acquire(now)) { return { kind: 'unavailable' }; }
                const previous = lock.predecessorFence;
                const raw = previous ? await readJsonFile(artifact(previous)) as PollState<T> | undefined : undefined;
                if (raw && Number.isFinite(raw.nextAtMs) && Number.isSafeInteger(raw.failures) && raw.failures >= 0 && raw.result) { state = raw; }
            }
            const save = async (next: PollState<T>) => {
                this.memory.set(base, next);
                if (lock?.fence && await lock.isCurrent()) {
                    await writeFileAtomic(artifact(lock.fence), randomUUID(), JSON.stringify(next));
                    saved = true;
                }
            };
            if (state && now < state.nextAtMs) {
                // Forward cooldown to this lease so the next holder can recover it.
                await save(state);
                return state.result;
            }
            await save({ nextAtMs: now + USAGE_POLL_INTERVAL_MS, failures: state?.failures ?? 0, result: state?.result ?? { kind: 'unavailable' } });
            if (lock && !await lock.isCurrent()) { return { kind: 'unavailable' }; }
            let result: PollResult<T>;
            try { result = await request(); } catch { result = { kind: 'retryable' }; }
            const failures = result.kind === 'retryable' ? Math.min(10, (state?.failures ?? 0) + 1) : 0;
            const delay = result.kind === 'credentials' ? 3600_000
                : result.kind === 'retryable' ? Math.min(3600_000, USAGE_POLL_INTERVAL_MS * 2 ** failures) * (0.75 + this.random() * 0.25)
                    : USAGE_POLL_INTERVAL_MS;
            await save({ nextAtMs: Math.max(now + delay, result.retryAtMs ?? 0), failures, result });
            return result;
        } catch {
            // Storage failure must not bypass a provider's shared cooldown.
            return { kind: 'unavailable' };
        } finally {
            if (lock) {
                // Only the predecessor can be removed; never touch a successor.
                if (saved && lock.fence && await lock.isCurrent().catch(() => false) && lock.predecessorFence) {
                    await fsp.unlink(artifact(lock.predecessorFence)).catch(() => undefined);
                }
                await lock.release().catch(() => undefined);
            }
        }
    }
}

export const usagePolling = new UsagePolling();
