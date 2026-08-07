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

/**
 * The working window both providers are pinned to. Current Claude models offer
 * far more, but pinning the window is what makes compaction land on a fixed
 * token count instead of a share of whatever model happens to be active. 240k
 * paired with the shared compact share below triggers at 216k, leaving 24k to
 * write the summary. That trigger sits above the 200k input tokens at which
 * Anthropic switches to the long-context rate — the larger working window is
 * taken in exchange. `DEFAULT_CODEX_CONTEXT_WINDOW` is the same number, so the
 * two providers behave alike regardless of which one a session runs on.
 */
export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 240000;

/**
 * Claude Code compacts at this share of the managed window, leaving the rest to
 * produce the summary. The Codex side compacts at the same share of its own
 * window (`CODEX_AUTO_COMPACT_RATIO`), so both providers compact at the same
 * point even though one is configured in percent and the other in tokens.
 */
export const DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT = 90;

export interface ClaudeOptimizeValues {
    contextWindow: number;
    autoCompactPercent: number;
}

export interface ClaudeOptimizePreset extends ClaudeOptimizeValues {
    id: '240k';
}

export const CLAUDE_OPTIMIZE_PRESETS: readonly ClaudeOptimizePreset[] = [
    {
        id: '240k',
        contextWindow: DEFAULT_CLAUDE_CONTEXT_WINDOW,
        autoCompactPercent: DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT,
    },
];

/** Tokens at which Claude Code starts compacting, for display only. */
export function claudeAutoCompactTokenLimit(values: ClaudeOptimizeValues): number {
    return Math.max(1, Math.floor(values.contextWindow * values.autoCompactPercent / 100));
}

interface StoredJsonValue {
    present: boolean;
    value?: unknown;
}

/** Original values captured before otak-usage first takes ownership. */
export interface ClaudeOptimizeBackup {
    version: 3;
    envPresent: boolean;
    contextWindow: StoredJsonValue;
    autoCompactPercent: StoredJsonValue;
}

/** Ownership format written while only the trigger percentage was managed. */
export interface ClaudeOptimizeBackupV2 {
    version: 2;
    envPresent: boolean;
    autoCompactPercent: StoredJsonValue;
}

/** Ownership format written by the first version that managed both values. */
export interface LegacyClaudeOptimizeBackup {
    version: 1;
    envPresent: boolean;
    contextWindow: StoredJsonValue;
    autoCompactPercent: StoredJsonValue;
}

type JsonObject = Record<string, unknown>;

export function normalizeClaudeTokenLimit(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}

export function normalizeClaudeAutoCompactPercent(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) {
        return fallback;
    }
    return Math.floor(value);
}

export function parseClaudeTokenLimit(value: string): number | undefined {
    const normalized = value.replace(/[,_\s]/g, '');
    if (!/^\d+$/.test(normalized)) {
        return undefined;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
        preset.contextWindow === values.contextWindow &&
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
        version: 3,
        envPresent: env !== undefined,
        contextWindow: storedValue(env, CLAUDE_AUTO_COMPACT_WINDOW_ENV),
        autoCompactPercent: storedValue(env, CLAUDE_AUTO_COMPACT_PERCENT_ENV),
    };
}

export function applyClaudeOptimizeJson(text: string, values: ClaudeOptimizeValues): string {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] = String(values.contextWindow);
    env[CLAUDE_AUTO_COMPACT_PERCENT_ENV] = String(values.autoCompactPercent);
    return serializeSettings(settings, text);
}

/** v1 ownership already backed up both values, so only the tag changes. */
export function upgradeLegacyClaudeOptimizeBackup(backup: LegacyClaudeOptimizeBackup): ClaudeOptimizeBackup {
    return {
        version: 3,
        envPresent: backup.envPresent,
        contextWindow: backup.contextWindow,
        autoCompactPercent: backup.autoCompactPercent,
    };
}

/**
 * v2 ownership left the window alone, restoring any pre-existing one when it
 * took over. Whatever the file holds now is therefore the user's own value, so
 * it has to be captured here — before this version starts writing a window
 * again — or turning the feature off would leave otak-usage's number behind.
 */
export function adoptClaudeOptimizeBackupV2(text: string, backup: ClaudeOptimizeBackupV2): ClaudeOptimizeBackup {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, false);
    return {
        version: 3,
        envPresent: backup.envPresent,
        contextWindow: storedValue(env, CLAUDE_AUTO_COMPACT_WINDOW_ENV),
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

function restoreBothJson(
    text: string,
    backup: { envPresent: boolean; contextWindow: StoredJsonValue; autoCompactPercent: StoredJsonValue },
): string {
    const settings = parseSettings(text);
    const env = settingsEnv(settings, true)!;
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_WINDOW_ENV, backup.contextWindow);
    restoreStoredValue(env, CLAUDE_AUTO_COMPACT_PERCENT_ENV, backup.autoCompactPercent);
    if (!backup.envPresent && Object.keys(env).length === 0) {
        delete settings.env;
    }
    return serializeSettings(settings, text);
}

export function restoreClaudeOptimizeJson(text: string, backup: ClaudeOptimizeBackup): string {
    if (backup.version !== 3) {
        throw new Error('Unsupported Claude context optimization backup version.');
    }
    return restoreBothJson(text, backup);
}

/** Give back only the percentage, which is all v2 ownership ever managed. */
export function restoreClaudeOptimizeV2Json(text: string, backup: ClaudeOptimizeBackupV2): string {
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
    return restoreBothJson(text, backup);
}
