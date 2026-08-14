import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
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

/** Version 1 records did not carry a fencing token and are deliberately ignored. */
export const LOCK_VERSION = 2;

export interface LeaseFence {
    /** Monotonically increasing claim number for this lock path. */
    epoch: number;
    /** Unpredictable token which identifies this particular claim. */
    leaseToken: string;
    holder: string;
}

/** What a leader publishes about itself. Everything but `holder` is diagnostic. */
export interface LockRecord {
    version: number;
    /** Instance id of the holding window. */
    holder: string;
    pid: number;
    host: string;
    /** Epoch ms of the holder's last renewal. */
    heartbeatMs: number;
    epoch: number;
    leaseToken: string;
    /** A voluntary release is represented in the holder's own heartbeat file. */
    released?: boolean;
}

export function isLockRecord(raw: unknown): raw is LockRecord {
    const r = raw as LockRecord | undefined;
    return !!r && typeof r === 'object' &&
        r.version === LOCK_VERSION &&
        typeof r.holder === 'string' && r.holder !== '' &&
        typeof r.heartbeatMs === 'number' && Number.isFinite(r.heartbeatMs) &&
        Number.isSafeInteger(r.epoch) && r.epoch >= 1 &&
        typeof r.leaseToken === 'string' && r.leaseToken.length >= 16;
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
    private currentFence: LeaseFence | undefined;
    private previousFence: LeaseFence | undefined;
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

    /** The epoch/token needed to fence writes made by this claim. */
    get fence(): LeaseFence | undefined {
        return this.held && this.currentFence ? { ...this.currentFence } : undefined;
    }

    /** The exact predecessor observed by this claim, used only to bootstrap its cache. */
    get predecessorFence(): LeaseFence | undefined {
        return this.held && this.previousFence ? { ...this.previousFence } : undefined;
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
            this.currentFence = undefined;
            this.previousFence = undefined;
            return false;
        }
        if (current && current.holder === this.instanceId && !lockIsStale(current, nowMs)) {
            this.held = true;
            this.currentFence = fenceOf(current);
            this.previousFence = undefined;
            return true;
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
        // A holder may renew after the nominal deadline as long as nobody has
        // claimed a newer epoch yet. This closes the ordinary slow-heartbeat
        // race without allowing an old holder to revive itself after takeover:
        // the exact epoch/token comparison below fails once ownership moved.
        if (!current || current.released || !this.currentFence || !sameFence(current, this.currentFence)) {
            this.held = false;
            this.currentFence = undefined;
            this.previousFence = undefined;
            return false;
        }
        // Heartbeats are written to an epoch-specific file, never back to the
        // shared lock pointer. Therefore a delayed old holder cannot overwrite
        // a successor's pointer between this read and the write.
        try {
            await this.writeHeartbeat(nowMs, this.currentFence);
        } catch (err) {
            // Losing one heartbeat to a contended rename is survivable as long
            // as the lease already on disk is still ours and still current —
            // the next heartbeat retries. Anything else is a real failure.
            const after = await this.read();
            if (!after || !this.currentFence || !sameFence(after, this.currentFence) || lockIsStale(after, nowMs)) {
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
        const fence = this.currentFence;
        if (!fence) {
            this.held = false;
            return;
        }
        this.held = false;
        const current = await this.read();
        if (current && !sameFence(current, fence)) {
            return; // already someone else's — deleting it would evict them
        }
        await this.writeReleaseMarker(fence);
    }

    /**
     * Best-effort release from `dispose()`, which cannot await. A window that is
     * killed outright skips this and is covered by the lease instead.
     */
    releaseSync(): void {
        if (!this.held) {
            return;
        }
        const fence = this.currentFence;
        if (!fence) {
            this.held = false;
            return;
        }
        this.held = false;
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
            if (isLockRecord(raw) && !sameFence(raw, fence)) {
                return;
            }
            fs.writeFileSync(this.releaseMarkerPath(fence), JSON.stringify({
                epoch: fence.epoch,
                leaseToken: fence.leaseToken,
                heartbeatMs: 0,
                released: true,
            }), 'utf8');
        } catch {
            // Nothing readable to release.
        }
    }

    private async claim(nowMs: number): Promise<boolean> {
        const observed = await this.read();
        const predecessor = observed ? fenceOf(observed) : undefined;
        const epoch = observed && Number.isSafeInteger(observed.epoch) ? observed.epoch + 1 : 1;
        const leaseToken = crypto.randomBytes(24).toString('hex');
        const fence: LeaseFence = { epoch, leaseToken, holder: this.instanceId };
        let writeError: unknown;
        try {
            await this.writeClaim(nowMs, fence);
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
        this.held = !!current && sameFence(current, fence);
        this.currentFence = this.held ? fence : undefined;
        this.previousFence = this.held ? predecessor : undefined;
        if (this.held) {
            return true;
        }
        if (writeError !== undefined && !(current && !lockIsStale(current, nowMs))) {
            throw writeError; // nothing leads and we cannot write: not a lost race
        }
        return false;
    }

    private async writeClaim(nowMs: number, fence: LeaseFence): Promise<void> {
        await this.writeHeartbeat(nowMs, fence);
        const record: LockRecord = {
            version: LOCK_VERSION,
            holder: this.instanceId,
            pid: process.pid,
            host: os.hostname(),
            heartbeatMs: nowMs,
            epoch: fence.epoch,
            leaseToken: fence.leaseToken,
        };
        await writeFileAtomic(this.lockPath, this.tag, JSON.stringify(record));
    }

    private async writeHeartbeat(nowMs: number, fence: LeaseFence): Promise<void> {
        await writeFileAtomic(this.heartbeatPath(fence), `${this.tag}-${fence.epoch}-${fence.leaseToken.slice(0, 12)}-heartbeat`, JSON.stringify({
            epoch: fence.epoch,
            leaseToken: fence.leaseToken,
            heartbeatMs: nowMs,
            released: false,
        }));
    }

    private async writeReleaseMarker(fence: LeaseFence): Promise<void> {
        await writeFileAtomic(this.releaseMarkerPath(fence), `${this.tag}-${fence.epoch}-${fence.leaseToken.slice(0, 12)}-release`, JSON.stringify({
            epoch: fence.epoch,
            leaseToken: fence.leaseToken,
            heartbeatMs: 0,
            released: true,
        }));
    }

    private heartbeatPath(fence: LeaseFence): string {
        return `${this.lockPath}.epoch-${fence.epoch}.${fence.leaseToken}.heartbeat`;
    }

    private releaseMarkerPath(fence: LeaseFence): string {
        return `${this.lockPath}.epoch-${fence.epoch}.${fence.leaseToken}.released`;
    }

    async readCurrent(): Promise<LockRecord | undefined> {
        const raw = await readJsonFile(this.lockPath);
        if (!isLockRecord(raw)) {
            return undefined;
        }
        const release = await readJsonFile(this.releaseMarkerPath(fenceOf(raw)));
        if (isHeartbeat(release, raw) && release.released) {
            return { ...raw, heartbeatMs: 0, released: true };
        }
        const heartbeat = await readJsonFile(this.heartbeatPath(fenceOf(raw)));
        if (isHeartbeat(heartbeat, raw)) {
            return { ...raw, heartbeatMs: heartbeat.heartbeatMs, released: heartbeat.released };
        }
        return raw;
    }

    /** True only when the on-disk claim is still exactly ours. */
    async isCurrent(nowMs: number = Date.now()): Promise<boolean> {
        const current = await this.readCurrent();
        return !!current && !current.released && !!this.currentFence && sameFence(current, this.currentFence) && !lockIsStale(current, nowMs);
    }

    private async read(): Promise<LockRecord | undefined> {
        return this.readCurrent();
    }
}

function fenceOf(record: LockRecord): LeaseFence {
    return { epoch: record.epoch, leaseToken: record.leaseToken, holder: record.holder };
}

function sameFence(record: LockRecord, fence: LeaseFence): boolean {
    return record.holder === fence.holder && record.epoch === fence.epoch && record.leaseToken === fence.leaseToken;
}

interface HeartbeatRecord {
    epoch: number;
    leaseToken: string;
    heartbeatMs: number;
    released: boolean;
}

function isHeartbeat(raw: unknown, lock: LockRecord): raw is HeartbeatRecord {
    const heartbeat = raw as HeartbeatRecord | undefined;
    return !!heartbeat && typeof heartbeat === 'object' &&
        heartbeat.epoch === lock.epoch && heartbeat.leaseToken === lock.leaseToken &&
        typeof heartbeat.heartbeatMs === 'number' && Number.isFinite(heartbeat.heartbeatMs) &&
        typeof heartbeat.released === 'boolean';
}
