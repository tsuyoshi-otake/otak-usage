/**
 * Optimization toggle for the Codex CLI's context settings. When enabled, the
 * extension keeps two top-level keys in `~/.codex/config.toml` pinned to the
 * configured values; when disabled it removes those keys again.
 *
 * Editing is done in place on the raw TOML text so the rest of the file — and
 * its ordering, comments, and unrelated keys — is preserved. TOML forbids
 * duplicate keys, so an existing occurrence is rewritten rather than appended.
 * Only the file preamble (everything before the first `[table]` header) is
 * touched, since both keys are top-level Codex settings.
 */

export const CODEX_CONTEXT_WINDOW_KEY = 'model_context_window';
export const CODEX_AUTO_COMPACT_KEY = 'model_auto_compact_token_limit';

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
export const CODEX_AUTO_COMPACT_RATIO = 0.9;

// The window both providers share (`DEFAULT_CLAUDE_CONTEXT_WINDOW` is the same
// number), so a session behaves alike whichever CLI it runs on. It stays below
// 272k, the point above which OpenAI charges the long-context rate, so the
// default never parks a Codex session at that billing boundary. Its 90% trigger
// lands at 216k, which is past Anthropic's own 200k boundary on the other side —
// the wider working window is taken in exchange.
export const DEFAULT_CODEX_CONTEXT_WINDOW = 240000;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 216000;

/**
 * The pair that was the default before the two providers were aligned. Kept so
 * the one-time migration can tell an untouched configuration from a chosen one.
 * It records what shipped once, so it stays put when the defaults move again.
 */
export const LEGACY_DEFAULT_CODEX_CONTEXT_WINDOW = 272000;
export const LEGACY_DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 250000;

/**
 * OpenAI charges the long-context rate above this many input tokens, making it
 * the largest window still billed at the standard rate.
 */
export const STANDARD_RATE_CODEX_CONTEXT_WINDOW = 272000;

export function suggestedCodexAutoCompactLimit(contextWindow: number): number {
    return Math.max(1, Math.floor(contextWindow * CODEX_AUTO_COMPACT_RATIO));
}

export interface CodexOptimizePreset {
    id: '240k' | '272k';
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
    { id: '240k', contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW, autoCompactLimit: DEFAULT_CODEX_AUTO_COMPACT_LIMIT },
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
 * Moving the shipped defaults off 272k/250k would not reach a user who already
 * has those numbers written into their settings, and would silently change the
 * meaning of a half-customized pair — someone who set only `codexContextWindow`
 * would suddenly compact at the new limit instead of 250k.
 *
 * So the migration decides per installation:
 *
 * - the pair still reads as the old default (an unset key counts as the old
 *   default, which is what it used to mean) → clear both values so the new
 *   defaults apply from now on;
 * - anything else is a chosen configuration → leave the chosen values alone and
 *   pin whatever is still unset to its old default, so the pair keeps behaving
 *   exactly as it did before the defaults moved.
 *
 * A user who deliberately picked the 272k preset is indistinguishable from one
 * who never touched the setting, so they are migrated as well and have to pick
 * 272k again.
 */
export function planCodexContextDefaultMigration(
    contextWindow: unknown,
    autoCompactLimit: unknown,
): CodexContextDefaultMigration {
    const effectiveWindow = normalizeCodexTokenLimit(contextWindow, LEGACY_DEFAULT_CODEX_CONTEXT_WINDOW);
    const effectiveLimit = normalizeCodexTokenLimit(autoCompactLimit, LEGACY_DEFAULT_CODEX_AUTO_COMPACT_LIMIT);
    if (effectiveWindow === LEGACY_DEFAULT_CODEX_CONTEXT_WINDOW &&
        effectiveLimit === LEGACY_DEFAULT_CODEX_AUTO_COMPACT_LIMIT) {
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
        write.codexContextWindow = LEGACY_DEFAULT_CODEX_CONTEXT_WINDOW;
    }
    if (autoCompactLimit === undefined) {
        write.codexAutoCompactLimit = LEGACY_DEFAULT_CODEX_AUTO_COMPACT_LIMIT;
    }
    return { clear: [], write };
}

function detectEol(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Index of the first table header line (`[section]`), or the line count. */
function preambleEnd(lines: string[]): number {
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i])) {
            return i;
        }
    }
    return lines.length;
}

function assignmentMatch(line: string, key: string): RegExpMatchArray | null {
    return line.match(new RegExp(`^(\\s*)${key}\\s*=`));
}

/**
 * Return `text` with the two managed keys set to the given values. Existing
 * top-level occurrences are rewritten; missing keys are inserted at the top.
 */
export function applyCodexOptimizeToml(text: string, values: CodexOptimizeValues): string {
    const eol = detectEol(text);
    const lines = text.split(/\r?\n/);
    const end = preambleEnd(lines);
    const desired: Array<[string, number]> = [
        [CODEX_CONTEXT_WINDOW_KEY, values.contextWindow],
        [CODEX_AUTO_COMPACT_KEY, values.autoCompactLimit],
    ];
    const present = new Set<string>();
    for (let i = 0; i < end; i++) {
        for (const [key, value] of desired) {
            const m = assignmentMatch(lines[i], key);
            if (m) {
                lines[i] = `${m[1]}${key} = ${value}`;
                present.add(key);
            }
        }
    }
    const toInsert = desired
        .filter(([key]) => !present.has(key))
        .map(([key, value]) => `${key} = ${value}`);
    if (toInsert.length > 0) {
        lines.splice(0, 0, ...toInsert);
    }
    return lines.join(eol);
}

/** Return `text` with the two managed keys removed from the preamble. */
export function removeCodexOptimizeToml(text: string): string {
    const eol = detectEol(text);
    const lines = text.split(/\r?\n/);
    const end = preambleEnd(lines);
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const managed = i < end &&
            (assignmentMatch(lines[i], CODEX_CONTEXT_WINDOW_KEY) !== null ||
                assignmentMatch(lines[i], CODEX_AUTO_COMPACT_KEY) !== null);
        if (!managed) {
            kept.push(lines[i]);
        }
    }
    return kept.join(eol);
}
