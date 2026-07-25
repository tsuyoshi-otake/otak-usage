import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import { readJsonFile, writeFileAtomic } from './atomicFile';
import { delay } from './delay';

/**
 * How often the leader rewrites its heartbeat. Cheap enough (one small file
 * write) to keep failover quick without being a burden of its own.
 */
export const HEARTBEAT_MS = 10_000;

/**
 * How long a lock survives without a heartbeat before another window may take
 * it. Three missed heartbeats, so an ordinary hiccup — a slow disk, a laptop
 * that just woke, an extension host busy with a long scan — never costs the
 * leader its lease, while a killed window is replaced within half a minute.
 */
export const LEASE_MS = 3 * HEARTBEAT_MS;

/**
 * How long a claim waits before reading itself back. Two windows that claim at
 * the same instant both write successfully — the file ends up holding whichever
 * rename landed last — so each has to look again to learn whether it actually
 * won. The pause only has to outlast the other claimant's rename, and claims
 * happen once at startup and once per failover.
 */
export const CLAIM_SETTLE_MS = 250;

export const LOCK_VERSION = 1;

/** What a leader publishes about itself. Everything but `holder` is diagnostic. */
export interface LockRecord {
    version: number;
    /** Instance id of the holding window. */
    holder: string;
    pid: number;
    host: string;
    /** Epoch ms of the holder's last renewal. */
    heartbeatMs: number;
}

export function isLockRecord(raw: unknown): raw is LockRecord {
    const r = raw as LockRecord | undefined;
    return !!r && typeof r === 'object' &&
        r.version === LOCK_VERSION &&
        typeof r.holder === 'string' && r.holder !== '' &&
        typeof r.heartbeatMs === 'number' && Number.isFinite(r.heartbeatMs);
}

/**
 * True when the lease has run out and the lock is up for grabs. A heartbeat in
 * the future means the writer's clock moved, not that the holder is gone, so it
 * counts as fresh rather than as an invitation to steal a live window's lock.
 */
export function lockIsStale(record: LockRecord, nowMs: number, leaseMs: number = LEASE_MS): boolean {
    return nowMs - record.heartbeatMs >= leaseMs;
}

/**
 * A lease over one scan group, shared through a file that every VS Code window
 * of the same installation can see. Exactly one window holds it at a time and
 * does the scanning; the rest read the snapshot it publishes.
 *
 * Mutual exclusion rests on `rename()` being atomic plus a read-back, not on OS
 * advisory locks: those behave differently on Windows, macOS and network mounts
 * (and Codespaces' container filesystem), and a stuck one cannot be recovered
 * from without a lease anyway. Losing the race is harmless here — the loser
 * simply reads the winner's snapshot.
 */
export class LeaderLock {
    private held = false;
    private readonly tag: string;

    constructor(
        private readonly lockPath: string,
        readonly instanceId: string,
        private readonly settleMs: number = CLAIM_SETTLE_MS,
    ) {
        this.tag = `${process.pid}-${instanceId.slice(0, 8)}`;
    }

    get isHeld(): boolean {
        return this.held;
    }

    /**
     * Become the leader unless another window holds a live lease. Idempotent
     * while held. Throws when the lock file cannot be written at all, which the
     * caller treats as "coordination unavailable" rather than as "not leader".
     */
    async acquire(nowMs: number): Promise<boolean> {
        const current = await this.read();
        if (current && current.holder !== this.instanceId && !lockIsStale(current, nowMs)) {
            this.held = false;
            return false;
        }
        return this.claim(nowMs);
    }

    /**
     * Take the lock whoever holds it. Used by the explicit refresh command: the
     * window the user is acting in should be the one that rescans, and the
     * previous leader steps down at its next heartbeat.
     */
    async steal(nowMs: number): Promise<boolean> {
        return this.claim(nowMs);
    }

    /**
     * Extend our lease. Returns false when the lock has moved on to another
     * window — the caller must then stop scanning and go back to following.
     */
    async renew(nowMs: number): Promise<boolean> {
        const current = await this.read();
        if (current && current.holder !== this.instanceId) {
            this.held = false;
            return false;
        }
        // The record may be gone (a stale-lock sweep, a cleaned storage
        // directory); rewriting it re-establishes the same holder.
        try {
            await this.write(nowMs);
        } catch (err) {
            // Losing one heartbeat to a contended rename is survivable as long
            // as the lease already on disk is still ours and still current —
            // the next heartbeat retries. Anything else is a real failure.
            const after = await this.read();
            if (!after || after.holder !== this.instanceId || lockIsStale(after, nowMs)) {
                throw err;
            }
        }
        this.held = true;
        return true;
    }

    /** Hand the lock over immediately instead of making the next window wait out the lease. */
    async release(): Promise<void> {
        if (!this.held) {
            return;
        }
        this.held = false;
        const current = await this.read();
        if (current && current.holder !== this.instanceId) {
            return; // already someone else's — deleting it would evict them
        }
        await fsp.unlink(this.lockPath).catch(() => undefined);
    }

    /**
     * Best-effort release from `dispose()`, which cannot await. A window that is
     * killed outright skips this and is covered by the lease instead.
     */
    releaseSync(): void {
        if (!this.held) {
            return;
        }
        this.held = false;
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
            if (isLockRecord(raw) && raw.holder !== this.instanceId) {
                return;
            }
            fs.unlinkSync(this.lockPath);
        } catch {
            // Nothing readable to release.
        }
    }

    private async claim(nowMs: number): Promise<boolean> {
        let writeError: unknown;
        try {
            await this.write(nowMs);
        } catch (err) {
            // Simultaneous claims can collide in the filesystem itself rather
            // than in the file's contents. Losing that collision is losing the
            // election, not a broken storage directory — the read-back below
            // tells the two apart.
            writeError = err;
        }
        if (this.settleMs > 0) {
            await delay(this.settleMs);
        }
        const current = await this.read();
        this.held = current?.holder === this.instanceId;
        if (this.held) {
            return true;
        }
        if (writeError !== undefined && !(current && !lockIsStale(current, nowMs))) {
            throw writeError; // nothing leads and we cannot write: not a lost race
        }
        return false;
    }

    private async write(nowMs: number): Promise<void> {
        const record: LockRecord = {
            version: LOCK_VERSION,
            holder: this.instanceId,
            pid: process.pid,
            host: os.hostname(),
            heartbeatMs: nowMs,
        };
        await writeFileAtomic(this.lockPath, this.tag, JSON.stringify(record));
    }

    private async read(): Promise<LockRecord | undefined> {
        const raw = await readJsonFile(this.lockPath);
        return isLockRecord(raw) ? raw : undefined;
    }
}
