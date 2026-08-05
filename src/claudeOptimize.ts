/**
 * Context optimization for Claude Code. Claude exposes auto-compaction controls
 * as environment variables, and officially supports setting them under `env`
 * in the user-level `settings.json` file.
 *
 * The transformer parses and re-serializes strict JSON so unrelated settings
 * remain semantically unchanged. Invalid JSON and a non-object `env` value are
 * rejected instead of being overwritten.
 */

export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const CLAUDE_AUTO_COMPACT_PERCENT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';

export const DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT = 90;

export interface ClaudeOptimizeValues {
    autoCompactPercent: number;
}

export interface ClaudeOptimizePreset extends ClaudeOptimizeValues {
    id: '90%';
}

export const CLAUDE_OPTIMIZE_PRESETS: readonly ClaudeOptimizePreset[] = [
    {
        id: '90%',
        autoCompactPercent: DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT,
    },
];

interface StoredJsonValue {
    present: boolean;
    value?: unknown;
}

/** Original percentage captured before otak-usage first takes ownership. */
export interface ClaudeOptimizeBackup {
    version: 2;
    envPresent: boolean;
    autoCompactPercent: StoredJsonValue;
}

/** Ownership format written by otak-usage versions that managed both values. */
export interface LegacyClaudeOptimizeBackup {
    version: 1;
    envPresent: boolean;
    contextWindow: StoredJsonValue;
    autoCompactPercent: StoredJsonValue;
}

type JsonObject = Record<string, unknown>;

export function normalizeClaudeAutoCompactPercent(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) {
        return fallback;
    }
    return Math.floor(value);
}

export function parseClaudeAutoCompactPercent(value: string): number | undefined {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
        return undefined;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

export function matchingClaudeOptimizePreset(values: ClaudeOptimizeValues): ClaudeOptimizePreset | undefined {
    return CLAUDE_OPTIMIZE_PRESETS.find((preset) =>
        preset.autoCompactPercent === values.autoCompactPercent,
    );
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(text: string): JsonObject {
    if (text.trim() === '') {
        return {};
    }
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
        throw new Error('Claude settings.json must contain a JSON object.');
    }
    return parsed;
}

function settingsEnv(settings: JsonObject, create: boolean): JsonObject | undefined {
    const value = settings.env;
    if (value === undefined) {
        if (!create) {
            return undefined;
        }
        const env: JsonObject = {};
        settings.env = env;
        return env;
    }
    if (!isObject(value)) {
        throw new Error('Claude settings.json "env" must contain a JSON object.');
    }
    return value;
}

function storedValue(object: JsonObject | undefined, key: string): StoredJsonValue {
    if (!object || !Object.prototype.hasOwnProperty.call(object, key)) {
        return { present: false };
    }
    return { present: true, value: object[key] };
}

function detectIndent(text: string): string {
    const match = text.match(/\r?\n([\t ]+)"/);
    return match?.[1] ?? '  ';
}

function serializeSettings(settings: JsonObject, original: string): string {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const indent = detectIndent(original);
    const serialized = JSON.stringify(settings, null, indent).replace(/\n/g, eol);
    // New settings files and files that already ended in a newline keep one.
    return original === '' || /\r?\n$/.test(original) ? `${serialized}${eol}` : serialized;
}

export function captureClaudeOptimizeBackup(text: string): ClaudeOptimizeBackup {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, false);
    return {
        version: 2,
        envPresent: env !== undefined,
        autoCompactPercent: storedValue(env, CLAUDE_AUTO_COMPACT_PERCENT_ENV),
    };
}

export function applyClaudeOptimizeJson(text: string, values: ClaudeOptimizeValues): string {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    env[CLAUDE_AUTO_COMPACT_PERCENT_ENV] = String(values.autoCompactPercent);
    return serializeSettings(settings, text);
}

/**
 * Stop managing the context window during a v1 -> v2 ownership migration.
 * Repeating this after an interrupted migration is safe and deterministic.
 */
export function migrateLegacyClaudeOptimizeJson(
    text: string,
    values: ClaudeOptimizeValues,
    backup: LegacyClaudeOptimizeBackup,
): string {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_WINDOW_ENV, backup.contextWindow);
    env[CLAUDE_AUTO_COMPACT_PERCENT_ENV] = String(values.autoCompactPercent);
    if (!backup.envPresent && Object.keys(env).length === 0) {
        delete settings.env;
    }
    return serializeSettings(settings, text);
}

export function upgradeLegacyClaudeOptimizeBackup(backup: LegacyClaudeOptimizeBackup): ClaudeOptimizeBackup {
    return {
        version: 2,
        envPresent: backup.envPresent,
        autoCompactPercent: backup.autoCompactPercent,
    };
}

function restoreStoredValue(object: JsonObject, key: string, stored: StoredJsonValue): void {
    if (stored.present) {
        object[key] = stored.value;
    } else {
        delete object[key];
    }
}

export function restoreClaudeOptimizeJson(text: string, backup: ClaudeOptimizeBackup): string {
    if (backup.version !== 2) {
        throw new Error('Unsupported Claude context optimization backup version.');
    }
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_PERCENT_ENV, backup.autoCompactPercent);
    if (!backup.envPresent && Object.keys(env).length === 0) {
        delete settings.env;
    }
    return serializeSettings(settings, text);
}

export function restoreLegacyClaudeOptimizeJson(text: string, backup: LegacyClaudeOptimizeBackup): string {
    if (backup.version !== 1) {
        throw new Error('Unsupported legacy Claude context optimization backup version.');
    }
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_WINDOW_ENV, backup.contextWindow);
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_PERCENT_ENV, backup.autoCompactPercent);
    if (!backup.envPresent && Object.keys(env).length === 0) {
        delete settings.env;
    }
    return serializeSettings(settings, text);
}
