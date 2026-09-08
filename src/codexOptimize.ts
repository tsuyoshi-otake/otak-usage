/**
 * Optimization toggle for the Codex CLI's context settings. When enabled, the
 * extension keeps two top-level keys in `~/.codex/config.toml` pinned to the
 * configured values and turns on Astra's experimental context-management
 * feature; when disabled it removes those keys and that flag again.
 *
 * Editing is done in place on the raw TOML text so the rest of the file — and
 * its ordering, comments, and unrelated keys — is preserved. TOML forbids
 * duplicate keys, so an existing occurrence is rewritten rather than appended.
 * The window keys live in the file preamble (everything before the first
 * `[table]` header). The context-management flag is a table setting, so that
 * pass may also edit `[features]` / `[features.context_management]`.
 */

export const CODEX_CONTEXT_WINDOW_KEY = 'model_context_window';
export const CODEX_AUTO_COMPACT_KEY = 'model_auto_compact_token_limit';
export const CODEX_CONTEXT_MANAGEMENT_TABLE = 'features.context_management';
export const CODEX_EXPERIMENTAL_MODE_KEY = 'experimental_mode';

import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { editToml } from './tomlEdit';

/**
 * The wider preset and the Custom flow's suggestion start compaction at this
 * share of the configured window. The compact 180k default below deliberately
 * uses a round 150k transition point instead, leaving 30k of configured
 * headroom for context hand-off and the token-budget fallback buffer.
 */
export const CODEX_AUTO_COMPACT_RATIO = 0.85;

// Experimental context management can move long-running work into a fresh
// window and recover selected prior context through notes/history. Keep the
// configured Codex working set compact by default; 150k leaves 30k before the
// configured maximum for the hand-off. Claude remains independently tuned to
// its own native summary-compaction behaviour.
export const DEFAULT_CODEX_CONTEXT_WINDOW = 180000;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 150000;

/**
 * The pair that shipped as the default immediately before the current one. An
 * unset setting used to mean exactly this, so the migration reads a missing key
 * as this value and pins it when the rest of the pair was chosen by hand.
 */
export const PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW = 250000;
export const PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 212500;

/**
 * Every pair otak-usage has ever shipped as its Codex default, oldest first.
 * Holding one of these numbers proves nothing about intent — it is what an
 * installation was handed — so the migration clears such a pair and lets the
 * current default take over. The live 272k preset (which now pairs with
 * 231.2k) is deliberately absent: that pair can only come from a real choice.
 */
export const SHIPPED_CODEX_CONTEXT_DEFAULTS: readonly CodexOptimizeValues[] = [
    { contextWindow: 250000, autoCompactLimit: 230000 },
    { contextWindow: 272000, autoCompactLimit: 250000 },
    { contextWindow: 200000, autoCompactLimit: 184000 },
    { contextWindow: 230000, autoCompactLimit: 195500 },
    { contextWindow: 240000, autoCompactLimit: 216000 },
    {
        contextWindow: PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW,
        autoCompactLimit: PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT,
    },
];

/** Whether a pair is one this extension once shipped rather than a choice. */
export function isShippedCodexContextDefault(values: CodexOptimizeValues): boolean {
    return SHIPPED_CODEX_CONTEXT_DEFAULTS.some((shipped) =>
        shipped.contextWindow === values.contextWindow &&
        shipped.autoCompactLimit === values.autoCompactLimit,
    );
}

/**
 * OpenAI charges the long-context rate above this many input tokens, making it
 * the largest window still billed at the standard rate.
 */
export const STANDARD_RATE_CODEX_CONTEXT_WINDOW = 272000;

export function suggestedCodexAutoCompactLimit(contextWindow: number): number {
    return Math.max(1, Math.floor(contextWindow * CODEX_AUTO_COMPACT_RATIO));
}

export interface CodexOptimizePreset {
    id: '180k' | '272k';
    contextWindow: number;
    autoCompactLimit: number;
}

/**
 * Curated context-size pairs exposed by the Optimize quick pick, default first.
 * The compact default uses its explicit 180k / 150k hand-off pair. The wider
 * 272k choice and Custom suggestions retain the established 85% rule.
 */
export const CODEX_OPTIMIZE_PRESETS: readonly CodexOptimizePreset[] = [
    { id: '180k', contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW, autoCompactLimit: DEFAULT_CODEX_AUTO_COMPACT_LIMIT },
    {
        id: '272k',
        contextWindow: STANDARD_RATE_CODEX_CONTEXT_WINDOW,
        autoCompactLimit: suggestedCodexAutoCompactLimit(STANDARD_RATE_CODEX_CONTEXT_WINDOW),
    },
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
    return objectProperty(root, CODEX_CONTEXT_WINDOW_KEY) === PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW
        && objectProperty(root, CODEX_AUTO_COMPACT_KEY) === PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT
        && objectProperty(contextManagement, CODEX_EXPERIMENTAL_MODE_KEY) === true;
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
): CodexContextDefaultMigration {
    if (appliedPreviousDefaults) {
        return {
            clear: ['codexContextWindow', 'codexAutoCompactLimit'],
            write: {},
        };
    }
    const effective: CodexOptimizeValues = {
        contextWindow: normalizeCodexTokenLimit(contextWindow, PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW),
        autoCompactLimit: normalizeCodexTokenLimit(autoCompactLimit, PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT),
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
        write.codexContextWindow = PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW;
    }
    if (autoCompactLimit === undefined) {
        write.codexAutoCompactLimit = PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT;
    }
    return { clear: [], write };
}

/** Preserve TOML syntax and unrelated text through syntax-node edits. */
export function applyCodexOptimizeToml(text: string, values: CodexOptimizeValues): string {
    let next = editToml(text, [CODEX_AUTO_COMPACT_KEY], String(values.autoCompactLimit));
    next = editToml(next, [CODEX_CONTEXT_WINDOW_KEY], String(values.contextWindow));
    return editToml(next, ['features', 'context_management', CODEX_EXPERIMENTAL_MODE_KEY], 'true');
}

export function removeCodexOptimizeToml(text: string): string {
    let next = editToml(text, [CODEX_CONTEXT_WINDOW_KEY]);
    next = editToml(next, [CODEX_AUTO_COMPACT_KEY]);
    return editToml(next, ['features', 'context_management', CODEX_EXPERIMENTAL_MODE_KEY]);
}
