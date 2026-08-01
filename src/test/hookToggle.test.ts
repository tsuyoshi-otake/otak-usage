import * as assert from 'assert';
import {
    HookToggleQueue,
    hookToggleProgressMessage,
    hookToggleSuccessMessage,
    hookToggleSyncFailureMessage,
    hookToggleUnsavedMessage,
} from '../hookToggle';

suite('hook toggle feedback', () => {
    test('rapid clicks retain parity and run serially', async () => {
        const queue = new HookToggleQueue<'repository'>();
        const applied: boolean[] = [];
        let current = false;
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

        const first = queue.enqueue('repository', current, async (request) => {
            await firstGate;
            current = request.enabled;
            applied.push(request.enabled);
        });
        const second = queue.enqueue('repository', current, async (request) => {
            current = request.enabled;
            applied.push(request.enabled);
        });

        assert.strictEqual(first.enabled, true);
        assert.strictEqual(second.enabled, false);
        assert.strictEqual(queue.value('repository', current), false);
        assert.strictEqual(queue.isLatest(first), false);
        assert.strictEqual(queue.isLatest(second), true);

        releaseFirst();
        await Promise.all([first.completion, second.completion]);

        assert.deepStrictEqual(applied, [true, false]);
        assert.strictEqual(current, false);
        assert.strictEqual(queue.value('repository', current), false);
    });

    test('a failed mutation does not strand the next click', async () => {
        const queue = new HookToggleQueue<'sounds'>();
        const failed = queue.enqueue('sounds', false, async () => {
            throw new Error('write failed');
        });
        const next = queue.enqueue('sounds', false, async () => undefined);

        await assert.rejects(failed.completion, /write failed/);
        await next.completion;
        assert.strictEqual(next.enabled, false);
    });

    test('messages name the target state and distinguish failure outcomes', () => {
        assert.strictEqual(hookToggleProgressMessage('hook sounds', true), 'otak-usage: turning hook sounds on\u2026');
        assert.strictEqual(hookToggleSuccessMessage('hook sounds', false), 'otak-usage: hook sounds disabled');
        assert.strictEqual(
            hookToggleUnsavedMessage('repository names', true),
            'otak-usage: repository names enabled for this window; setting not saved',
        );
        assert.match(hookToggleSyncFailureMessage('repository names', true), /not applied yet/);
        assert.match(hookToggleSyncFailureMessage('hook sounds', false), /may still be active/);
    });
});
