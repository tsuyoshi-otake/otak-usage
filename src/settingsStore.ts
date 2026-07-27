/** The subset of vscode.WorkspaceConfiguration a SettingsStore needs. */
export interface SettingsBackend {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): Promise<void>;
}

/**
 * Reads and writes the settings the extension changes on the user's behalf,
 * tolerating a write VS Code refuses.
 *
 * VS Code rejects a write whose key is absent from the configuration registry
 * ("… is not a registered configuration"), which happens whenever an extension
 * host outlives its own manifest: the extension was just disabled, uninstalled
 * or updated, or the window switched settings profiles, and the window has not
 * reloaded yet. The status-bar item is still on screen and still clickable, so
 * an unguarded update turns a click into a raw VS Code error and changes
 * nothing. Keeping the value in memory instead lets the view keep toggling for
 * the rest of this window's life; a reload brings the persisted setting back.
 */
export class SettingsStore {
    /** Values that could not be persisted, keyed by setting name. */
    private readonly unsaved = new Map<string, unknown>();

    constructor(
        private readonly backend: SettingsBackend,
        private readonly onWriteFailed?: (key: string, err: unknown) => void,
    ) { }

    get<T>(key: string, fallback: T): T {
        return this.unsaved.has(key) ? this.unsaved.get(key) as T : this.backend.get<T>(key, fallback);
    }

    /** Persists a value; returns false when it only lives in memory. */
    async set(key: string, value: unknown): Promise<boolean> {
        try {
            await this.backend.update(key, value);
            this.unsaved.delete(key);
            return true;
        } catch (err) {
            this.unsaved.set(key, value);
            this.onWriteFailed?.(key, err);
            return false;
        }
    }

    /**
     * Drops in-memory values whose persisted setting changed under us — an
     * edit in settings.json, or a write that finally went through, always wins.
     */
    reconcile(changed: (key: string) => boolean): void {
        for (const key of [...this.unsaved.keys()]) {
            if (changed(key)) {
                this.unsaved.delete(key);
            }
        }
    }

    /** Setting names held in memory only; for tests and diagnostics. */
    unsavedKeys(): string[] {
        return [...this.unsaved.keys()];
    }
}
