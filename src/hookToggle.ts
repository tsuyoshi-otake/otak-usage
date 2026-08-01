export interface HookToggleRequest<Key extends string> {
    key: Key;
    enabled: boolean;
    revision: number;
}

export interface EnqueuedHookToggle<Key extends string> extends HookToggleRequest<Key> {
    completion: Promise<void>;
}

/**
 * Serializes toggle mutations while keeping the latest requested value visible
 * immediately. Two rapid clicks therefore request on then off, rather than
 * both reading the same persisted value and requesting on twice.
 */
export class HookToggleQueue<Key extends string> {
    private readonly pending = new Map<Key, HookToggleRequest<Key>>();
    private tail: Promise<void> = Promise.resolve();
    private revision = 0;

    enqueue(
        key: Key,
        current: boolean,
        run: (request: HookToggleRequest<Key>) => Promise<void>,
        onSettled?: (request: HookToggleRequest<Key>) => void,
    ): EnqueuedHookToggle<Key> {
        const enabled = !(this.pending.get(key)?.enabled ?? current);
        const request: HookToggleRequest<Key> = {
            key,
            enabled,
            revision: ++this.revision,
        };
        this.pending.set(key, request);

        const completion = this.tail
            .then(() => run(request))
            .finally(() => {
                if (this.isLatest(request)) {
                    this.pending.delete(key);
                }
                onSettled?.(request);
            });
        // A failed request reaches its caller, but never strands later clicks.
        this.tail = completion.then(() => undefined, () => undefined);
        return { ...request, completion };
    }

    value(key: Key, current: boolean): boolean {
        return this.pending.get(key)?.enabled ?? current;
    }

    isLatest(request: HookToggleRequest<Key>): boolean {
        return this.pending.get(request.key)?.revision === request.revision;
    }
}

export function hookToggleProgressMessage(label: string, enabled: boolean): string {
    return `otak-usage: turning ${label} ${enabled ? 'on' : 'off'}\u2026`;
}

export function hookToggleSuccessMessage(label: string, enabled: boolean): string {
    return `otak-usage: ${label} ${enabled ? 'enabled' : 'disabled'}`;
}

export function hookToggleUnsavedMessage(label: string, enabled: boolean): string {
    return `${hookToggleSuccessMessage(label, enabled)} for this window; setting not saved`;
}

export function hookToggleSyncFailureMessage(label: string, enabled: boolean): string {
    const consequence = enabled
        ? 'The feature is not applied yet.'
        : 'Existing hooks may still be active.';
    return `otak-usage: ${label} are ${enabled ? 'enabled' : 'disabled'} in Settings, but the optional hook files could not be updated. ${consequence} See Developer Tools for details.`;
}
