import * as fsp from 'fs/promises';
import { DIR_MAX_RECHECK_MS, FILE_MAX_RECHECK_MS, RecheckScheduler } from './scheduler';

/** A log file the scan should consider, as observed by the index. */
export interface ScannedFile {
    path: string;
    size: number;
    mtimeMs: number;
}

/**
 * A directory's contents plus the mtime they were read at. A directory's mtime
 * changes when an entry is created, deleted or renamed, but not when an
 * existing file is written to — which makes it exactly the right invalidation
 * signal for *discovery*. Appends to transcripts we already know about are
 * caught by the per-file stat instead.
 */
export interface DirListing {
    /** subdirectory names */
    dirs: string[];
    /** *.jsonl file names */
    files: string[];
    mtimeMs: number;
    /** when this listing was read (wall clock), for the unconditional re-read */
    readAtMs: number;
    /**
     * Read so soon after the directory changed that a create landing in the
     * same coarse-timestamp window might not move its mtime. Such a listing is
     * never trusted for skipping the next read.
     */
    provisional: boolean;
}

/**
 * Upper bound on filesystem timestamp granularity across the platforms this
 * extension runs on: 100 ns on NTFS and APFS, 1 ns–1 s on ext4 depending on
 * inode size, 1 s on HFS+, 2 s on FAT32. As long as this exceeds the
 * granularity, any create sharing a bucket with the recorded mtime happened
 * before a non-provisional read and is therefore already in the listing.
 */
export const MTIME_SETTLE_MS = 3_000;

/**
 * Re-read a directory this often no matter what its mtime says. Every
 * filesystem POSIX or Windows-native updates a directory's mtime on create,
 * but network mounts (NFS/SMB) can serve it from an attribute cache or from a
 * server clock skewed far enough to defeat the settle window above. This bound
 * keeps discovery correct without depending on any of that.
 */
export const DIR_FULL_RELIST_MS = 30 * 60_000;

/**
 * Caches directory listings and decides which entries are worth a syscall on
 * this pass. Both providers keep every session they have ever written, so a
 * naive walk re-lists ~400 directories and re-stat()s ~2,000 files every tick
 * to find the two or three that moved. The index turns that into a cache
 * lookup for anything that has been quiet, with the re-check interval growing
 * with idle age (see scheduler.ts) so activity is still noticed immediately.
 *
 * Purely in-memory: losing it costs one full walk, never correctness.
 */
export class ScanIndex {
    private readonly listings = new Map<string, DirListing>();
    private readonly dirSchedule = new RecheckScheduler(DIR_MAX_RECHECK_MS);
    private readonly fileSchedule = new RecheckScheduler(FILE_MAX_RECHECK_MS);
    private syscalls = 0;

    /** Syscalls issued since the last resetStats() — for tests and diagnostics. */
    get statCount(): number {
        return this.syscalls;
    }

    resetStats(): void {
        this.syscalls = 0;
    }

    /** Forget everything; the next pass walks the tree in full. */
    reset(): void {
        this.listings.clear();
        this.dirSchedule.clear();
        this.fileSchedule.clear();
    }

    /**
     * The directory's entries, from cache when it is not yet due or its mtime
     * has not moved. Undefined means the directory is missing or unreadable,
     * which is a normal case (a provider that is not installed).
     */
    async listDir(dir: string, nowMs: number): Promise<DirListing | undefined> {
        const cached = this.listings.get(dir);
        const trusted = cached !== undefined &&
            !cached.provisional &&
            nowMs - cached.readAtMs < DIR_FULL_RELIST_MS;
        if (trusted && !this.dirSchedule.isDue(dir, nowMs)) {
            return cached;
        }
        let mtimeMs: number;
        try {
            this.syscalls++;
            mtimeMs = (await fsp.stat(dir)).mtimeMs;
        } catch {
            this.listings.delete(dir);
            this.dirSchedule.forget(dir);
            return undefined;
        }
        this.dirSchedule.observed(dir, mtimeMs, nowMs);
        if (trusted && cached.mtimeMs === mtimeMs) {
            return cached;
        }
        // stat() deliberately runs before the read: an entry created in between
        // shows up in the listing while the recorded mtime stays behind it, so
        // the next pass sees a newer mtime and reads again. Reading first would
        // pair a stale listing with a fresh mtime and strand that entry.
        this.syscalls++;
        const fresh = await readDir(dir, mtimeMs, nowMs);
        if (!fresh) {
            this.listings.delete(dir);
            return undefined;
        }
        this.listings.set(dir, fresh);
        return fresh;
    }

    /**
     * stat() a known file, but only when its backoff says it is worth looking
     * at. Undefined means "nothing to consider this pass" — either not due, or
     * the file vanished between the listing and the stat.
     */
    async statFile(filePath: string, nowMs: number): Promise<ScannedFile | undefined> {
        if (!this.fileSchedule.isDue(filePath, nowMs)) {
            return undefined;
        }
        let st: Awaited<ReturnType<typeof fsp.stat>>;
        try {
            this.syscalls++;
            st = await fsp.stat(filePath);
        } catch {
            this.fileSchedule.forget(filePath);
            return undefined;
        }
        this.fileSchedule.observed(filePath, st.mtimeMs, nowMs);
        return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
    }
}

async function readDir(dir: string, mtimeMs: number, nowMs: number): Promise<DirListing | undefined> {
    const dirs: string[] = [];
    const files: string[] = [];
    let handle: Awaited<ReturnType<typeof fsp.opendir>>;
    try {
        handle = await fsp.opendir(dir);
    } catch {
        return undefined;
    }
    try {
        for await (const entry of handle) {
            if (entry.isDirectory()) {
                dirs.push(entry.name);
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(entry.name);
            }
        }
    } catch {
        return undefined; // directory changed while being read
    }
    // A negative age means the filesystem clock runs ahead of ours (network
    // mounts, VM guests); treat that as "just changed" rather than as settled.
    const age = nowMs - mtimeMs;
    return { dirs, files, mtimeMs, readAtMs: nowMs, provisional: age < MTIME_SETTLE_MS };
}
