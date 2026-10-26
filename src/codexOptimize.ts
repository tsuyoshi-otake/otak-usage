/**
 * Optimization toggle for the Codex CLI's context settings. When enabled, the
 * extension keeps two top-level keys in `~/.codex/config.toml` pinned to the
 * configured values; when disabled it removes those keys again.
 * Legacy experimental context-management settings are removed in either mode.
 *
 * Editing is done in place on the raw TOML text so the rest of the file — and
 * its ordering, comments, and unrelated keys — is preserved. TOML forbids
 * duplicate keys, so an existing occurrence is rewritten rather than appended.
 * The window keys live in the file preamble (everything before the first
 * `[table]` header). Legacy cleanup may also edit `[features]` or
 * `[features.context_management]` without adding experimental settings.
 */

export const CODEX_CONTEXT_WINDOW_KEY = 'model_context_window';
export const CODEX_AUTO_COMPACT_KEY = 'model_auto_compact_token_limit';
export const CODEX_EXPERIMENTAL_MODE_KEY = 'experimental_mode';
const DEFAULT_CODEX_MODEL = 'gpt-6.1-terra';
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { editToml } from './tomlEdit';

/**
 * The 320k default and the Custom flow's suggestion start compaction at this
 * share of the configured window. The compact 180k preset retains its round
 * 150k transition point and 30k of configured headroom.
 */
export const CODEX_AUTO_COMPACT_RATIO = 0.85;

// Both providers use 320k with an 85% transition, leaving 48k of headroom.
export const DEFAULT_CODEX_CONTEXT_WINDOW = 320000;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 272000;

/**
 * The pair that shipped as the default immediately before the current one. An
 * unset setting used to mean exactly this, so the migration reads a missing key
 * as this value and pins it when the rest of the pair was chosen by hand.
 */
export const PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW = 272000;
export const PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 231200;

/** The compact default inherited by migration generations 3 and 4. */
export const COMPACT_CODEX_CONTEXT_DEFAULTS: CodexOptimizeValues = {
    contextWindow: 180000,
    autoCompactLimit: 150000,
};

/** Defaults inherited by installations that skipped the 180k release. */
export const LEGACY_CODEX_CONTEXT_DEFAULTS: CodexOptimizeValues = {
    contextWindow: 250000,
    autoCompactLimit: 212500,
};

/**
 * Every pair otak-usage has ever shipped as its Codex default, oldest first.
 * Holding one of these numbers proves nothing about intent — it is what an
 * installation was handed — so the migration clears such a pair and lets the
 * current default take over. The 320k / 272k pair is deliberately absent:
 * before this release it could only come from a real choice.
 */
export const SHIPPED_CODEX_CONTEXT_DEFAULTS: readonly CodexOptimizeValues[] = [
    { contextWindow: 250000, autoCompactLimit: 230000 },
    { contextWindow: 272000, autoCompactLimit: 250000 },
    { contextWindow: 200000, autoCompactLimit: 184000 },
    { contextWindow: 230000, autoCompactLimit: 195500 },
    { contextWindow: 240000, autoCompactLimit: 216000 },
    LEGACY_CODEX_CONTEXT_DEFAULTS,
    COMPACT_CODEX_CONTEXT_DEFAULTS,
    { contextWindow: PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW, autoCompactLimit: PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT },
];

/** Whether a pair is one this extension once shipped rather than a choice. */
export function isShippedCodexContextDefault(values: CodexOptimizeValues): boolean {
    return SHIPPED_CODEX_CONTEXT_DEFAULTS.some((shipped) =>
        shipped.contextWindow === values.contextWindow &&
        shipped.autoCompactLimit === values.autoCompactLimit,
    );
}

export function suggestedCodexAutoCompactLimit(contextWindow: number): number {
    return Math.max(1, Math.floor(contextWindow * CODEX_AUTO_COMPACT_RATIO));
}

export interface CodexOptimizePreset {
    id: '180k' | '320k';
    contextWindow: number;
    autoCompactLimit: number;
}

/**
 * Curated context-size pairs exposed by the Optimize quick pick, default first.
 * The compact 180k choice keeps its explicit 150k hand-off point.
 */
export const CODEX_OPTIMIZE_PRESETS: readonly CodexOptimizePreset[] = [
    {
        id: '320k',
        contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
        autoCompactLimit: DEFAULT_CODEX_AUTO_COMPACT_LIMIT,
    },
    { id: '180k', ...COMPACT_CODEX_CONTEXT_DEFAULTS },
];

export function matchingCodexOptimizePreset(contextWindow: number, autoCompactLimit: number): CodexOptimizePreset | undefined {
    return CODEX_OPTIMIZE_PRESETS.find((preset) =>
        preset.contextWindow === contextWindow && preset.autoCompactLimit === autoCompactLimit,
    );
}

export function parseCodexTokenLimit(value: string): number | undefined {
    const normalized = value.replace(/[,_\s]/g, '');
    if (!/^\d+$/.test(normalized)) {
        return undefined;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface CodexOptimizeValues {
    contextWindow: number;
    autoCompactLimit: number;
}

/** Coerce a configured token limit to a positive integer, else the fallback. */
export function normalizeCodexTokenLimit(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}

/** Resolve explicit VS Code settings without trusting a cached extension default. */
export function configuredCodexTokenLimit(
    inspected: { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
    fallback: number,
): number {
    const value = inspected?.workspaceFolderValue !== undefined ? inspected.workspaceFolderValue
        : inspected?.workspaceValue !== undefined ? inspected.workspaceValue
            : inspected?.globalValue;
    return normalizeCodexTokenLimit(value, fallback);
}

export type CodexContextSettingKey = 'codexContextWindow' | 'codexAutoCompactLimit';

/**
 * What the one-time default migration has to write, given the values a user
 * currently has in their global settings (`undefined` when a key is unset).
 */
export interface CodexContextDefaultMigration {
    /** Global values to remove so the new manifest defaults take over. */
    clear: readonly CodexContextSettingKey[];
    /** Global values to write so an existing configuration keeps its meaning. */
    write: Partial<Record<CodexContextSettingKey, number>>;
}

function objectProperty(value: unknown, key: string): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    return (value as Record<string, unknown>)[key];
}

/**
 * Whether config.toml still contains the exact default pair previously applied
 * by otak-usage, including the experimental flag that the extension owns.
 * The flag is essential: the two numeric values alone could be a manual choice.
 */
export function hasAppliedPreviousCodexContextDefaults(text: string): boolean {
    const root = getStaticTOMLValue(parseTOML(text)) as unknown;
    const features = objectProperty(root, 'features');
    const contextManagement = objectProperty(features, 'context_management');
    const contextWindow = objectProperty(root, CODEX_CONTEXT_WINDOW_KEY);
    const autoCompactLimit = objectProperty(root, CODEX_AUTO_COMPACT_KEY);
    const matchesPrevious = contextWindow === PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW
        && autoCompactLimit === PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT;
    const matchesLegacy = contextWindow === LEGACY_CODEX_CONTEXT_DEFAULTS.contextWindow
        && autoCompactLimit === LEGACY_CODEX_CONTEXT_DEFAULTS.autoCompactLimit;
    const matchesCompact = contextWindow === COMPACT_CODEX_CONTEXT_DEFAULTS.contextWindow
        && autoCompactLimit === COMPACT_CODEX_CONTEXT_DEFAULTS.autoCompactLimit;
    return (matchesPrevious || matchesLegacy || matchesCompact)
        && objectProperty(contextManagement, CODEX_EXPERIMENTAL_MODE_KEY) === true;
}

/**
 * Force saved Codex defaults to Terra / medium once, including explicit
 * profile overrides. Profiles without an override inherit the root defaults.
 * The caller owns the new one-time marker and fenced, atomic config.toml write;
 * later user choices survive once that marker is recorded.
 */
export function migrateCodexDefaultModelToml(text: string): string {
    const root = getStaticTOMLValue(parseTOML(text)) as unknown;
    let next = editToml(text, ['model'], JSON.stringify(DEFAULT_CODEX_MODEL));
    next = editToml(next, ['model_reasoning_effort'], JSON.stringify(DEFAULT_CODEX_REASONING_EFFORT));
    const profiles = objectProperty(root, 'profiles');
    if (typeof profiles === 'object' && profiles !== null && !Array.isArray(profiles)) {
        for (const [name, profile] of Object.entries(profiles)) {
            for (const [key, value] of [['model', DEFAULT_CODEX_MODEL], ['model_reasoning_effort', DEFAULT_CODEX_REASONING_EFFORT]]) {
                if (objectProperty(profile, key) !== undefined) {
                    next = editToml(next, ['profiles', name, key], JSON.stringify(value));
                }
            }
        }
    }
    return next;
}

/**
 * Moving the shipped defaults would not reach an installation that already has
 * the old numbers written into its settings, and would silently change the
 * meaning of a half-customized pair — someone who set only `codexContextWindow`
 * would suddenly compact at the new limit instead of the old one.
 *
 * So the migration decides per installation:
 *
 * - the pair reads as one this extension shipped (an unset key counts as the
 *   previous default, which is what it used to mean) → clear both values so the
 *   current defaults apply from now on;
 * - config.toml still holds the immediately previous pair together with the
 *   managed experimental flag → clear both values regardless of what the VS
 *   Code settings now say, because the applied file proves extension ownership;
 * - anything else is a chosen configuration → leave the chosen values alone and
 *   pin whatever is still unset to the previous default, so the pair keeps
 *   behaving exactly as it did before the defaults moved.
 *
 * A user who deliberately typed a pair this extension once shipped is
 * indistinguishable from one who never touched the setting, so they are
 * migrated as well and have to enter it again.
 */
export function planCodexContextDefaultMigration(
    contextWindow: unknown,
    autoCompactLimit: unknown,
    appliedPreviousDefaults = false,
    inheritedDefaults: CodexOptimizeValues = {
        contextWindow: PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW,
        autoCompactLimit: PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT,
    },
): CodexContextDefaultMigration {
    if (appliedPreviousDefaults) {
        return {
            clear: ['codexContextWindow', 'codexAutoCompactLimit'],
            write: {},
        };
    }
    const effective: CodexOptimizeValues = {
        contextWindow: normalizeCodexTokenLimit(contextWindow, inheritedDefaults.contextWindow),
        autoCompactLimit: normalizeCodexTokenLimit(autoCompactLimit, inheritedDefaults.autoCompactLimit),
    };
    if (isShippedCodexContextDefault(effective)) {
        const clear: CodexContextSettingKey[] = [];
        if (contextWindow !== undefined) {
            clear.push('codexContextWindow');
        }
        if (autoCompactLimit !== undefined) {
            clear.push('codexAutoCompactLimit');
        }
        return { clear, write: {} };
    }
    const write: Partial<Record<CodexContextSettingKey, number>> = {};
    if (contextWindow === undefined) {
        write.codexContextWindow = inheritedDefaults.contextWindow;
    }
    if (autoCompactLimit === undefined) {
        write.codexAutoCompactLimit = inheritedDefaults.autoCompactLimit;
    }
    return { clear: [], write };
}

/** Preserve TOML syntax and unrelated text through syntax-node edits. */
export function removeLegacyCodexContextManagementToml(text: string): string {
    const next = editToml(text, ['features', 'context_management', CODEX_EXPERIMENTAL_MODE_KEY]);
    const root = getStaticTOMLValue(parseTOML(next)) as unknown;
    const context = objectProperty(objectProperty(root, 'features'), 'context_management');
    // An empty map still fails on CLIs whose feature values must be booleans.
    // Keep user-owned siblings and valid boolean values rather than guessing.
    if (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length === 0) {
        return editToml(next, ['features', 'context_management']);
    }
    return next;
}

export function applyCodexOptimizeToml(text: string, values: CodexOptimizeValues): string {
    let next = editToml(text, [CODEX_AUTO_COMPACT_KEY], String(values.autoCompactLimit));
    next = editToml(next, [CODEX_CONTEXT_WINDOW_KEY], String(values.contextWindow));
    return removeLegacyCodexContextManagementToml(next);
}

export function removeCodexOptimizeToml(text: string): string {
    let next = editToml(text, [CODEX_CONTEXT_WINDOW_KEY]);
    next = editToml(next, [CODEX_AUTO_COMPACT_KEY]);
    return removeLegacyCodexContextManagementToml(next);
}
