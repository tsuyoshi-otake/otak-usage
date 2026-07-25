import * as fsp from 'fs/promises';
import * as path from 'path';
import { delay } from './delay';

/**
 * Backoff for a rename that lost a race rather than failing outright. Windows
 * rejects a rename with EPERM while another process is replacing the same
 * target (and again when a virus scanner or the search indexer happens to hold
 * it open) — which is precisely what several VS Code windows claiming the lock
 * at startup look like. POSIX renames never do this, so the retries cost
 * nothing there.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];

/**
 * Replace `filePath` in a single step: write a sibling temp file, then rename
 * it over the target. `rename(2)` is atomic on POSIX and maps to `MoveFileEx`
 * with `MOVEFILE_REPLACE_EXISTING` on Windows, so a reader in another VS Code
 * window never observes a half-written file — which is the whole point when
 * every window may be reading these files at any moment.
 *
 * `tag` must be unique per writer: two windows renaming concurrently is fine
 * (the last one wins) but they must not share a temp path.
 */
export async function writeFileAtomic(filePath: string, tag: string, data: string): Promise<void> {
    const tmp = `${filePath}.${tag}.tmp`;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tmp, data, 'utf8');
    try {
        await renameWithRetry(tmp, filePath);
    } catch (err) {
        await fsp.unlink(tmp).catch(() => undefined);
        throw err;
    }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await fsp.rename(from, to);
            return;
        } catch (err) {
            if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isContendedRename(err)) {
                throw err;
            }
            await delay(RENAME_RETRY_DELAYS_MS[attempt]);
        }
    }
}

function isContendedRename(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Parsed JSON, or undefined when the file is missing, unreadable or malformed.
 * Every one of those means the same thing to the callers here — there is no
 * usable shared state — and a torn read cannot happen because writers rename.
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
    } catch {
        return undefined;
    }
}
