import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { OtakUsageApi } from '../extension';
import { alertSnoozePathFor, readAlertSnooze, writeAlertSnooze } from '../coordination/alertSnooze';
import { readJsonFile, writeFileAtomic } from '../coordination/atomicFile';
import { fencedCacheKey, makeFencedCacheRecord, readFencedCacheRecord } from '../coordination/fencedCache';
import { groupKey, lockPathFor, snapshotPathFor } from '../coordination/group';
import { LEASE_MS, LeaderLock, isLockRecord, lockIsStale } from '../coordination/leaderLock';
import { SNAPSHOT_VERSION, SharedSnapshot, isSharedSnapshot, readFencedSnapshot, readSharedSnapshot, snapshotArtifactPath, writeFencedSnapshot, writeSharedSnapshot } from '../coordination/sharedSnapshot';
import { emptyUsage } from '../types';

/** Claims settle fast enough for tests without removing the read-back entirely. */
const SETTLE_MS = 30;

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'otak-usage-coord-'));
}

function lockIn(dir: string, instanceId: string, settleMs = SETTLE_MS): LeaderLock {
    return new LeaderLock(path.join(dir, 'test.lock'), instanceId, settleMs);
}

const NOW = 1_800_000_000_000;
const RTK_PERIOD = { commands: 3, inputTokens: 100, outputTokens: 40, savedTokens: 25 };

suite('coordination: group key', () => {
    test('the same directories always map to the same group', () => {
        const a = groupKey(path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.codex'));
        const b = groupKey(path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.codex'));
        assert.strictEqual(a, b);
    });

    test('a different provider directory elects its own leader', () => {
        const a = groupKey('/home/u/.claude', '/home/u/.codex');
        const b = groupKey('/home/u/work/.claude', '/home/u/.codex');
        assert.notStrictEqual(a, b);
    });

    test('equivalent spellings of one directory do not split a group', () => {
        const base = path.join(os.homedir(), '.claude');
        const indirect = path.join(os.homedir(), 'x', '..', '.claude');
        assert.strictEqual(
            groupKey(base, '/tmp/codex'),
            groupKey(indirect, '/tmp/codex'),
        );
        if (process.platform === 'win32') {
            assert.strictEqual(
                groupKey('C:\\Users\\u\\.claude', 'C:\\Users\\u\\.codex'),
                groupKey('c:\\users\\U\\.CLAUDE', 'c:\\users\\U\\.codex'),
            );
        }
    });

    test('lock and snapshot live beside each other under the group key', () => {
        const key = groupKey('/a', '/b');
        assert.ok(lockPathFor('/store', key).includes(key));
        assert.ok(snapshotPathFor('/store', key).includes(key));
        assert.notStrictEqual(lockPathFor('/store', key), snapshotPathFor('/store', key));
    });
});

suite('coordination: leader lock', () => {
    test('the first window becomes the leader and the second follows', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        assert.strictEqual(await a.acquire(NOW), true);
        assert.strictEqual(await b.acquire(NOW), false);
        assert.strictEqual(a.isHeld, true);
        assert.strictEqual(b.isHeld, false);
    });

    test('a live lease is renewable by its holder and not takeable by anyone else', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        assert.strictEqual(await a.renew(NOW + LEASE_MS * 4), true);
        // b's clock is well past the original heartbeat, but a kept renewing.
        assert.strictEqual(await b.acquire(NOW + LEASE_MS * 4), false);
    });

    test('an expired lease is taken over, and the old leader learns it lost', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        assert.strictEqual(await b.acquire(NOW + LEASE_MS), true);
        assert.strictEqual(await a.renew(NOW + LEASE_MS + 1), false);
        assert.strictEqual(a.isHeld, false);
    });

    test('a heartbeat from the future counts as live rather than stealable', () => {
        const record = { version: 2, holder: 'x', pid: 1, host: 'h', heartbeatMs: NOW + 60_000, epoch: 1, leaseToken: '0123456789abcdef' };
        assert.strictEqual(lockIsStale(record, NOW), false);
        assert.strictEqual(lockIsStale({ ...record, heartbeatMs: NOW - LEASE_MS }, NOW), true);
        assert.strictEqual(lockIsStale({ ...record, heartbeatMs: NOW - LEASE_MS + 1 }, NOW), false);
    });

    test('releasing hands the lock over without waiting out the lease', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        await a.release();
        assert.strictEqual(a.isHeld, false);
        assert.strictEqual(await b.acquire(NOW + 1), true);
    });

    test('releasing never evicts a window that already took over', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        await b.acquire(NOW + LEASE_MS);
        await a.release(); // a still believes it holds the lock
        assert.strictEqual(await b.renew(NOW + LEASE_MS + 1), true);
    });

    test('dispose-time release is best effort and leaves a newer holder alone', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        a.releaseSync();
        // Release is a fenced heartbeat marker, not an unlink: unlinking after
        // a check could delete a successor's lock during a takeover race.
        assert.strictEqual(fs.existsSync(path.join(dir, 'test.lock')), true);
        await b.acquire(NOW + 1);
        const c = lockIn(dir, 'window-c');
        await c.acquire(NOW + LEASE_MS + 1); // c takes it from b
        b.releaseSync();
        assert.ok(fs.existsSync(path.join(dir, 'test.lock')), 'c must keep the lock b no longer owns');
    });

    test('a manual refresh steals the lock and the previous leader steps down', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        await a.acquire(NOW);
        assert.strictEqual(await b.steal(NOW + 1), true);
        assert.strictEqual(await a.renew(NOW + 2), false);
    });

    // Five windows restored at once is the ordinary case, not the exotic one.
    // On Windows a rename onto a target another process is replacing fails with
    // EPERM, so this also covers losing the election in the filesystem rather
    // than in the file's contents.
    test('simultaneous claims settle on exactly one leader', async () => {
        const dir = tempDir();
        const contenders = ['a', 'b', 'c', 'd', 'e'].map((id) => lockIn(dir, `window-${id}`, 120));
        const results = await Promise.all(contenders.map((lock) => lock.acquire(NOW)));
        assert.strictEqual(results.filter(Boolean).length, 1, `expected one leader, got ${results.filter(Boolean).length}`);
        const raw = await readJsonFile(path.join(dir, 'test.lock'));
        assert.ok(isLockRecord(raw));
        const winner = contenders.find((lock) => lock.isHeld);
        assert.strictEqual(raw.holder, winner?.instanceId);
    });

    test('the leader keeps its lease while the others keep polling', async () => {
        const dir = tempDir();
        const leader = lockIn(dir, 'window-a');
        const followers = ['b', 'c', 'd'].map((id) => lockIn(dir, `window-${id}`));
        await leader.acquire(NOW);
        for (let beat = 1; beat <= 5; beat++) {
            const at = NOW + beat * (LEASE_MS / 3);
            const [renewed, ...taken] = await Promise.all([
                leader.renew(at),
                ...followers.map((lock) => lock.acquire(at)),
            ]);
            assert.strictEqual(renewed, true, `leader lost its lease on beat ${beat}`);
            assert.deepStrictEqual(taken, [false, false, false], `a follower took over on beat ${beat}`);
        }
    });

    test('every claim gets a new fencing token and epoch', async () => {
        const dir = tempDir();
        const a = lockIn(dir, 'window-a');
        const b = lockIn(dir, 'window-b');
        assert.strictEqual(await a.acquire(NOW), true);
        const first = a.fence;
        assert.ok(first);
        assert.strictEqual(await b.acquire(NOW + LEASE_MS), true);
        const second = b.fence;
        assert.ok(second);
        assert.ok(second.epoch > first.epoch);
        assert.notStrictEqual(second.leaseToken, first.leaseToken);
        assert.strictEqual(await a.isCurrent(NOW + LEASE_MS + 1), false);
    });

    test('an old holder cannot release a newer claim with the same instance id', async () => {
        const dir = tempDir();
        const first = lockIn(dir, 'same-instance');
        const second = lockIn(dir, 'same-instance');
        assert.strictEqual(await first.acquire(NOW), true);
        assert.strictEqual(await second.steal(NOW + 1), true);
        await first.release();
        assert.strictEqual(await second.isCurrent(NOW + 2), true);
    });

    test('a corrupt lock file is treated as no lock at all', async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'test.lock'), '{ not json', 'utf8');
        assert.strictEqual(await lockIn(dir, 'window-a').acquire(NOW), true);
    });

    test('an unwritable lock directory surfaces as an error, not as a lost election', async () => {
        const dir = path.join(tempDir(), 'missing');
        fs.writeFileSync(dir, 'not a directory', 'utf8');
        await assert.rejects(() => lockIn(dir, 'window-a').acquire(NOW));
    });
});

suite('coordination: shared snapshot', () => {
    function snapshot(overrides: Partial<SharedSnapshot> = {}): SharedSnapshot {
        return {
            version: SNAPSHOT_VERSION,
            updatedAtMs: NOW,
            leader: 'window-a',
            days: { '2026-07-25': { 'claude/claude-opus-5': { ...emptyUsage(), input: 10, output: 20 } } },
            claudeAvailable: true,
            codexAvailable: false,
            ...overrides,
        };
    }

    test('a published snapshot round-trips', async () => {
        const dir = tempDir();
        const target = path.join(dir, 'snap.json');
        const published = snapshot({
            rtk: { today: RTK_PERIOD, month: RTK_PERIOD, allTime: RTK_PERIOD },
            claudeLimits: { primary: { usedPercent: 42, resetsAtMs: NOW + 60_000, windowMinutes: 300 }, planType: 'max', asOfMs: NOW },
        });
        await writeSharedSnapshot(target, 'pid', published);
        assert.deepStrictEqual(await readSharedSnapshot(target), published);
    });

    test('a delayed old leader is fenced to its own immutable artifact', async () => {
        const dir = tempDir();
        const target = path.join(dir, 'snap.json');
        const first = lockIn(dir, 'window-a');
        const second = lockIn(dir, 'window-b');
        assert.strictEqual(await first.acquire(NOW), true);
        const firstFence = first.fence;
        assert.ok(firstFence);
        assert.strictEqual(await second.acquire(NOW + LEASE_MS), true);
        const secondFence = second.fence;
        assert.ok(secondFence);

        const oldSnapshot = snapshot({ leader: 'window-a', fence: firstFence });
        const newSnapshot = snapshot({ leader: 'window-b', fence: secondFence, updatedAtMs: NOW + LEASE_MS });
        // The old leader finishes after takeover. Its artifact must not be
        // readable as the current leader's snapshot.
        assert.strictEqual(await writeFencedSnapshot(target, 'old', oldSnapshot, firstFence, () => Promise.resolve(false)), false);
        assert.strictEqual(await writeFencedSnapshot(target, 'new', newSnapshot, secondFence, () => second.isCurrent(NOW + LEASE_MS + 1)), true);
        assert.deepStrictEqual(await readFencedSnapshot(target, secondFence), newSnapshot);
        assert.strictEqual(await readFencedSnapshot(target, firstFence), undefined);
        assert.ok(fs.existsSync(snapshotArtifactPath(target, secondFence)));
    });

    test('fenced writer refuses a mismatched snapshot identity', async () => {
        const dir = tempDir();
        const target = path.join(dir, 'snap.json');
        const lock = lockIn(dir, 'window-a');
        assert.strictEqual(await lock.acquire(NOW), true);
        const fence = lock.fence;
        assert.ok(fence);
        assert.strictEqual(await writeFencedSnapshot(target, 'bad', snapshot({ fence: { ...fence, epoch: fence.epoch + 1 } }), fence, () => lock.isCurrent(NOW)), false);
        assert.strictEqual(await readFencedSnapshot(target, fence), undefined);
    });

    test('a publish leaves no temp file behind', async () => {
        const dir = tempDir();
        await writeSharedSnapshot(path.join(dir, 'snap.json'), 'pid', snapshot());
        assert.deepStrictEqual(fs.readdirSync(dir), ['snap.json']);
    });

    test('a follower with nothing to read gets undefined rather than zeroes', async () => {
        assert.strictEqual(await readSharedSnapshot(path.join(tempDir(), 'absent.json')), undefined);
    });

    test('unusable snapshots are rejected instead of rendered', async () => {
        const dir = tempDir();
        const target = path.join(dir, 'snap.json');
        fs.writeFileSync(target, '{ truncated', 'utf8');
        assert.strictEqual(await readSharedSnapshot(target), undefined);

        assert.strictEqual(isSharedSnapshot({ ...snapshot(), version: SNAPSHOT_VERSION + 1 }), false);
        assert.strictEqual(isSharedSnapshot({ ...snapshot(), days: { '2026-07-25': 3 } }), false);
        assert.strictEqual(isSharedSnapshot({ ...snapshot(), claudeAvailable: 'yes' }), false);
        // A non-finite token count would otherwise reach summarize() and show
        // up as a NaN cost with nothing to trace it back to.
        assert.strictEqual(
            isSharedSnapshot({ ...snapshot(), days: { '2026-07-25': { 'claude/x': { ...emptyUsage(), input: Number.NaN } } } }),
            false,
        );
    });

    test('an atomic write replaces the previous content whole', async () => {
        const dir = tempDir();
        const target = path.join(dir, 'file.json');
        await writeFileAtomic(target, 'writer-1', '{"a":1}');
        await writeFileAtomic(target, 'writer-2', '{"b":2}');
        assert.deepStrictEqual(await readJsonFile(target), { b: 2 });
        assert.deepStrictEqual(fs.readdirSync(dir), ['file.json']);
    });
});

suite('coordination: fenced cache', () => {
    test('only an exact group and lease identity can restore a cache', () => {
        const fence = { holder: 'window-a', epoch: 3, leaseToken: '0123456789abcdef0123456789abcdef' };
        const cache = { version: 7, files: {}, days: {} };
        const record = makeFencedCacheRecord('group-a', fence, cache);
        assert.deepStrictEqual(readFencedCacheRecord(record, 'group-a', fence), cache);
        assert.strictEqual(readFencedCacheRecord(record, 'group-b', fence), undefined);
        assert.strictEqual(readFencedCacheRecord(record, 'group-a', { ...fence, epoch: 4 }), undefined);
        assert.strictEqual(readFencedCacheRecord(record, 'group-a', { ...fence, leaseToken: `${fence.leaseToken}ff` }), undefined);
    });

    test('different claims use different immutable cache keys', () => {
        const first = { holder: 'window-a', epoch: 1, leaseToken: '0123456789abcdef0123456789abcdef' };
        const next = { holder: 'window-b', epoch: 2, leaseToken: 'fedcba9876543210fedcba9876543210' };
        assert.notStrictEqual(fencedCacheKey('group-a', first), fencedCacheKey('group-a', next));
        assert.notStrictEqual(fencedCacheKey('group-a', first), fencedCacheKey('group-b', first));
    });
});

suite('coordination: alert snooze', () => {
    test('one file per installation, not one per scan group', () => {
        const dir = tempDir();
        assert.strictEqual(alertSnoozePathFor(dir), path.join(dir, 'alert-snooze.json'));
        // Silencing alerts in a window pointed at another provider directory
        // must still silence them here — the user muted otak-usage, not a
        // directory — so the group key deliberately stays out of the name.
        assert.strictEqual(alertSnoozePathFor(dir), alertSnoozePathFor(dir));
    });

    test('a deadline set in one window is what the next leader reads', async () => {
        const dir = tempDir();
        const target = alertSnoozePathFor(dir);
        await writeAlertSnooze(target, 'window-a', { untilMs: NOW });
        assert.deepStrictEqual(await readAlertSnooze(target), { untilMs: NOW });
        assert.deepStrictEqual(fs.readdirSync(dir), ['alert-snooze.json']);

        await writeAlertSnooze(target, 'window-b', { untilMs: 0 });
        assert.deepStrictEqual(await readAlertSnooze(target), { untilMs: 0 });
    });

    test('no file and a corrupt file both mean "not snoozed"', async () => {
        const dir = tempDir();
        assert.strictEqual(await readAlertSnooze(alertSnoozePathFor(dir)), undefined);

        const target = alertSnoozePathFor(dir);
        fs.writeFileSync(target, '{ truncated', 'utf8');
        assert.strictEqual(await readAlertSnooze(target), undefined);

        fs.writeFileSync(target, '{"untilMs":"tomorrow"}', 'utf8');
        assert.strictEqual(await readAlertSnooze(target), undefined);
    });
});

suite('coordination: the running extension', () => {
    /**
     * The election only pays off across windows, and a test host is a single
     * window — so let the real extension be the first window and stand a bare
     * lock in for the second. If this window has taken the lock and published,
     * a second window finds the lock held and reads that snapshot instead of
     * walking the logs again.
     */
    test('this window scans, and a second window would follow it', async function () {
        this.timeout(60_000);
        const extension = vscode.extensions.getExtension<OtakUsageApi>('odangoo.otak-usage');
        assert.ok(extension, 'otak-usage is not installed in the test host');
        const api = await extension.activate();

        const state = await waitFor(() => {
            const current = api.coordination();
            return current.leader && current.snapshotPath ? current : undefined;
        }, 'the extension never took the scan lock');
        assert.ok(state.lockPath);

        const observer = new LeaderLock(state.lockPath, 'second-window', SETTLE_MS);
        const current = await waitFor(() => observer.readCurrent(), 'the leader lock was not readable');
        const fence = { holder: current.holder, epoch: current.epoch, leaseToken: current.leaseToken };
        const snapshot = await waitFor(
            () => readFencedSnapshot(state.snapshotPath!, fence),
            'the leader never published a snapshot',
        );
        assert.strictEqual(snapshot.version, SNAPSHOT_VERSION);
        assert.ok(snapshot.updatedAtMs > 0);

        assert.strictEqual(
            await observer.acquire(Date.now()),
            false,
            'a second window must follow the running one instead of scanning too',
        );
    });
});

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, whatFailed: string, timeoutMs = 40_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) {
            return value;
        }
        assert.ok(Date.now() < deadline, whatFailed);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
