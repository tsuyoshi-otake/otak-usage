import * as path from 'path';
import { AlertSnooze, isValidAlertSnooze } from '../alert';
import { readJsonFile, writeFileAtomic } from './atomicFile';

/**
 * Where the snooze deadline lives. Beside the lock and the snapshot, but with
 * no group key in the name: the lock is per set of provider directories, while
 * silence is something the user asks of otak-usage as a whole. One file per
 * installation means asking once, from whichever window happens to be showing
 * the notification, and having every other window honour it.
 *
 * It has to be a file rather than `globalState` because the window that raises
 * alerts is whichever one currently holds the leader lock, and that moves — on
 * a window closing, on a manual refresh stealing the lock, or after a few
 * missed heartbeats. Each window reads its `globalState` at activation and
 * never sees another window's write, so a snooze kept there would be silently
 * ignored by the next leader.
 */
export function alertSnoozePathFor(storageDir: string): string {
    return path.join(storageDir, 'alert-snooze.json');
}

/** The recorded deadline, or undefined when there is none or it is unusable. */
export async function readAlertSnooze(filePath: string): Promise<AlertSnooze | undefined> {
    const raw = await readJsonFile(filePath);
    return isValidAlertSnooze(raw) ? raw : undefined;
}

export async function writeAlertSnooze(filePath: string, tag: string, snooze: AlertSnooze): Promise<void> {
    await writeFileAtomic(filePath, tag, JSON.stringify(snooze));
}
