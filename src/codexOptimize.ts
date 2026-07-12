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

export const DEFAULT_CODEX_CONTEXT_WINDOW = 250000;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 230000;

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
