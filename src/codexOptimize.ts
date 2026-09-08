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

import { editToml } from './tomlEdit';

/**
 * Every window is paired with a compact limit at this share of it, so
 * compaction starts with enough room left to write the summary. Presets and the
 * Custom flow's suggestion both derive from it, which keeps a hand-entered
 * window on the same rule as a preset one.
 *
 * The Claude Code side compacts at the same share of its own managed window
 * (`DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT`), so the two providers are aligned
 * even though one is configured in tokens and the other in percent.
 */
export const CODEX_AUTO_COMPACT_RATIO = 0.85;

// The window both providers share (`DEFAULT_CLAUDE_CONTEXT_WINDOW` is the same
// number), so a session behaves alike whichever CLI it runs on. It stays below
// 272k, the point above which OpenAI charges the long-context rate, so the
// default never parks a Codex session at that billing boundary. Its 85% trigger
// lands at 212.5k, which is past Anthropic's own 200k boundary on the other
// side — the wider working window is taken in exchange.
export const DEFAULT_CODEX_CONTEXT_WINDOW = 250000;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 212500;

/**
 * The pair that shipped as the default immediately before the current one. An
 * unset setting used to mean exactly this, so the migration reads a missing key
 * as this value and pins it when the rest of the pair was chosen by hand.
 */
export const PREVIOUS_DEFAULT_CODEX_CONTEXT_WINDOW = 240000;
export const PREVIOUS_DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 216000;

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
    id: '250k' | '272k';
    contextWindow: number;
    autoCompactLimit: number;
}

/**
 * Curated context-size pairs exposed by the Optimize quick pick, default first.
 * Both compact at `CODEX_AUTO_COMPACT_RATIO` of their window, so switching
 * presets — or typing a custom window — never changes how much headroom
 * compaction is given.
 */
export const CODEX_OPTIMIZE_PRESETS: readonly CodexOptimizePreset[] = [
    { id: '250k', contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW, autoCompactLimit: DEFAULT_CODEX_AUTO_COMPACT_LIMIT },
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
): CodexContextDefaultMigration {
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
