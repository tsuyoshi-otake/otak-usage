/**
 * Shared Claude Code / Codex hook configuration.
 *
 * The hook files are user-owned JSON.  Keep the transformation semantic and
 * idempotent: only command entries carrying otak-usage's marker are managed,
 * while every other hook and setting is left intact.
 */

export type HookProvider = 'claude' | 'codex';
export type HookFeature = 'repository' | 'sounds';

export interface HookFeatureSettings {
    /** Prefix Claude/Codex conversation titles with the current repository. */
    repositoryName: boolean;
    /** Play a prompt/stop chime from UserPromptSubmit and Stop hooks. */
    sounds: boolean;
}

export const HOOK_RUNNER_FILE = 'otak-usage-hook.js';
export const HOOK_MARKER = '--otak-usage-hook';

type JsonObject = Record<string, unknown>;

const EVENTS_BY_FEATURE: Record<HookFeature, readonly string[]> = {
    repository: ['Stop'],
    sounds: ['Stop', 'UserPromptSubmit'],
};

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): JsonObject {
    if (text.trim() === '') {
        return {};
    }
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
        throw new Error('Hook settings must contain a JSON object.');
    }
    return parsed;
}

function detectIndent(text: string): string {
    const match = text.match(/\r?\n([\t ]+)"/);
    return match?.[1] ?? '  ';
}

function serializeJson(value: JsonObject, original: string): string {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const indent = detectIndent(original);
    const serialized = JSON.stringify(value, null, indent).replace(/\n/g, eol);
    return original === '' || /\r?\n$/.test(original) ? `${serialized}${eol}` : serialized;
}

function markerFor(provider: HookProvider, feature: HookFeature): string {
    return `${HOOK_MARKER} ${provider} ${feature}`;
}

/** Build the command stored in a user's hook JSON. */
export function hookCommand(runnerPath: string, provider: HookProvider, feature: HookFeature): string {
    // Hook commands are evaluated by the user's shell. Double quotes work on
    // POSIX shells and PowerShell/cmd for the paths VS Code can produce.
    return `node "${runnerPath}" ${markerFor(provider, feature)}`;
}

function hookObject(value: unknown, create: boolean): JsonObject | undefined {
    if (value === undefined) {
        return create ? {} : undefined;
    }
    if (!isObject(value)) {
        throw new Error('Hook settings "hooks" must contain an object.');
    }
    return value;
}

function eventArray(hooks: JsonObject, event: string, create: boolean): unknown[] | undefined {
    const value = hooks[event];
    if (value === undefined) {
        if (!create) {
            return undefined;
        }
        const entries: unknown[] = [];
        hooks[event] = entries;
        return entries;
    }
    if (!Array.isArray(value)) {
        throw new Error(`Hook settings "${event}" must contain an array.`);
    }
    return value;
}

function managedCommand(value: unknown, provider: HookProvider, feature: HookFeature): boolean {
    if (!isObject(value) || typeof value.command !== 'string') {
        return false;
    }
    const marker = markerFor(provider, feature);
    const index = value.command.indexOf(marker);
    if (index < 0) {
        return false;
    }
    const end = index + marker.length;
    return end === value.command.length || /\s/.test(value.command[end]);
}

function removeManaged(entries: unknown[], provider: HookProvider, feature: HookFeature): boolean {
    let changed = false;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!isObject(entry) || !Array.isArray(entry.hooks)) {
            continue;
        }
        const hooks = entry.hooks;
        const before = hooks.length;
        const remaining = hooks.filter((hook) => !managedCommand(hook, provider, feature));
        entry.hooks = remaining;
        if (remaining.length !== before) {
            changed = true;
        }
        // Remove only an empty group that was made empty by our command. A
        // matcher group containing another user's hook remains in place.
        if (remaining.length === 0 && before > 0) {
            entries.splice(index, 1);
        }
    }
    return changed;
}

function appendManaged(entries: unknown[], command: string): void {
    entries.push({ hooks: [{ type: 'command', command }] });
}

function enabledFeatures(settings: HookFeatureSettings): HookFeature[] {
    const features: HookFeature[] = [];
    if (settings.repositoryName) {
        features.push('repository');
    }
    if (settings.sounds) {
        features.push('sounds');
    }
    return features;
}

/**
 * Apply (or remove) otak-usage's hooks in a Claude `settings.json` or Codex
 * `hooks.json` document. The two files use the same `hooks` event shape.
 */
export function applyHookFeaturesJson(
    text: string,
    provider: HookProvider,
    runnerPath: string,
    settings: HookFeatureSettings,
): string {
    const root = parseJson(text);
    const desired = enabledFeatures(settings);
    const managedFeatures: HookFeature[] = ['repository', 'sounds'];
    const hooks = hookObject(root.hooks, desired.length > 0);
    if (!hooks) {
        return text;
    }
    if (root.hooks === undefined && desired.length > 0) {
        root.hooks = hooks;
    }

    let changed = false;
    for (const feature of managedFeatures) {
        for (const event of EVENTS_BY_FEATURE[feature]) {
            const entries = eventArray(hooks, event, false);
            if (entries) {
                const removed = removeManaged(entries, provider, feature);
                changed = removed || changed;
                if (removed && entries.length === 0) {
                    delete hooks[event];
                }
            }
        }
    }

    for (const feature of desired) {
        const command = hookCommand(runnerPath, provider, feature);
        for (const event of EVENTS_BY_FEATURE[feature]) {
            const entries = eventArray(hooks, event, true)!;
            appendManaged(entries, command);
            changed = true;
        }
    }

    if (Object.keys(hooks).length === 0) {
        delete root.hooks;
    }
    return changed ? serializeJson(root, text) : text;
}

/** Whether a hook JSON document contains one of our managed commands. */
export function hasManagedHook(text: string, provider: HookProvider, feature: HookFeature): boolean {
    const root = parseJson(text);
    const hooks = hookObject(root.hooks, false);
    if (!hooks) {
        return false;
    }
    for (const event of EVENTS_BY_FEATURE[feature]) {
        const entries = eventArray(hooks, event, false);
        if (entries?.some((entry) => isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => managedCommand(hook, provider, feature)))) {
            return true;
        }
    }
    return false;
}
