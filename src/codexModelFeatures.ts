/**
 * Codex VS Code extension model-picker state.
 *
 * The Codex extension does not expose a public API for its hidden model
 * feature settings. Its global-state memento is still owned by VS Code, so
 * this module uses a narrowly feature-detected bridge to the same storage
 * service. The bridge fails closed when VS Code changes those private
 * implementation details; it never edits the storage database directly.
 */

export const CODEX_EXTENSION_ID = 'openai.chatgpt';
export const CODEX_PERSISTED_ATOM_STATE_KEY = 'persisted-atom-state';
export const CODEX_ENABLED_REASONING_EFFORTS_KEY = 'enabled-reasoning-efforts';
export const CODEX_MAX_REASONING_EFFORT = 'max';

/** Codex's current default levels, before Max is enabled. */
export const CODEX_DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra'] as const;

/** The small part of vscode.Memento used by the bridge and its tests. */
export interface MementoLike {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export interface CodexMaxMergeResult {
    state: Record<string, unknown>;
    changed: boolean;
    supported: boolean;
}

export type CodexMaxSyncResult =
    | 'updated'
    | 'already-enabled'
    | 'bridge-unavailable'
    | 'unsupported-state'
    | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add Max while retaining the user's existing reasoning-effort selection.
 * Missing state follows Codex's current defaults, so enabling Max does not
 * accidentally leave the picker with only Max available.
 */
export function addCodexMaxReasoningEffort(raw: unknown): CodexMaxMergeResult {
    if (raw === undefined || raw === null) {
        return {
            state: {
                [CODEX_ENABLED_REASONING_EFFORTS_KEY]: [
                    ...CODEX_DEFAULT_REASONING_EFFORTS,
                    CODEX_MAX_REASONING_EFFORT,
                ],
            },
            changed: true,
            supported: true,
        };
    }
    if (!isRecord(raw)) {
        return { state: {}, changed: false, supported: false };
    }

    const existing = raw[CODEX_ENABLED_REASONING_EFFORTS_KEY];
    if (existing === undefined) {
        return {
            state: {
                ...raw,
                [CODEX_ENABLED_REASONING_EFFORTS_KEY]: [
                    ...CODEX_DEFAULT_REASONING_EFFORTS,
                    CODEX_MAX_REASONING_EFFORT,
                ],
            },
            changed: true,
            supported: true,
        };
    }
    if (!Array.isArray(existing) || existing.some((value) => typeof value !== 'string')) {
        return { state: {}, changed: false, supported: false };
    }
    if (existing.includes(CODEX_MAX_REASONING_EFFORT)) {
        return { state: raw, changed: false, supported: true };
    }
    return {
        state: {
            ...raw,
            [CODEX_ENABLED_REASONING_EFFORTS_KEY]: [...existing, CODEX_MAX_REASONING_EFFORT],
        },
        changed: true,
        supported: true,
    };
}

interface ForeignMemento extends MementoLike {
    readonly whenReady?: PromiseLike<unknown>;
    dispose?: () => void;
}

interface ExtensionDescription {
    identifier: { value: string };
    version: string;
}

type ForeignMementoConstructor = new (description: ExtensionDescription, storage: unknown) => ForeignMemento;

function isMemento(value: unknown): value is ForeignMemento {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.get === 'function' && typeof value.update === 'function';
}

/**
 * Construct a global-state memento for another extension using the storage
 * service already backing this extension's own globalState. _storage and
 * whenReady are intentionally checked at runtime because they are private
 * VS Code implementation details, not part of the extension API contract.
 */
function createForeignGlobalState(source: MementoLike, version: string): ForeignMemento | undefined {
    const internals = source as unknown as { constructor?: unknown; _storage?: unknown };
    if (typeof internals.constructor !== 'function' || internals._storage === undefined) {
        return undefined;
    }

    try {
        const Constructor = internals.constructor as ForeignMementoConstructor;
        const target = new Constructor({
            identifier: { value: CODEX_EXTENSION_ID },
            version,
        }, internals._storage);
        if (!isMemento(target) || !target.whenReady || typeof target.whenReady.then !== 'function') {
            target.dispose?.();
            return undefined;
        }
        return target;
    } catch {
        return undefined;
    }
}

/**
 * Enable Max in Codex's persisted model-feature state.
 *
 * This operation is idempotent. A foreign memento is disposed after the
 * update so it does not keep a second storage listener alive in the host.
 */
export async function syncCodexMaxReasoningEffort(source: MementoLike, codexVersion: string): Promise<CodexMaxSyncResult> {
    const target = createForeignGlobalState(source, codexVersion);
    if (!target) {
        return 'bridge-unavailable';
    }

    try {
        const ready = target.whenReady;
        if (!ready) {
            return 'bridge-unavailable';
        }
        await ready;
        const current = target.get<unknown>(CODEX_PERSISTED_ATOM_STATE_KEY);
        const merged = addCodexMaxReasoningEffort(current);
        if (!merged.supported) {
            return 'unsupported-state';
        }
        if (!merged.changed) {
            return 'already-enabled';
        }
        await target.update(CODEX_PERSISTED_ATOM_STATE_KEY, merged.state);
        return 'updated';
    } catch {
        return 'failed';
    } finally {
        try {
            target.dispose?.();
        } catch {
            // Disposal is best effort when the host changes its internals.
        }
    }
}
