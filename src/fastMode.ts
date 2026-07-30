/**
 * Fast-mode detection for both providers. Fast mode bills at premium
 * per-token rates, so the extension warns once when it turns on and — the
 * first time only — re-enables context optimization for that provider (a
 * compact context matters more at premium prices).
 *
 * The two providers expose fast mode very differently:
 * - Claude Code keeps the /fast toggle out of any config file this extension
 *   reads; what it does leave behind is `usage.speed === "fast"` on transcript
 *   lines, which the scanner maps to "<model>-fast" buckets. Detection is
 *   therefore usage-based: any fast-billed tokens in today's bucket.
 * - Codex CLI declares it as `fast_mode = true` under `[features]` in
 *   `~/.codex/config.toml`, so detection is config-based.
 */

import { FAST_SUFFIX } from './pricing';
import { DayBuckets, Provider, parseBucketKey, totalTokens } from './types';

/** Which providers currently have fast mode on. */
export interface FastModeState {
    claude: boolean;
    codex: boolean;
}

export function isValidFastModeState(raw: unknown): raw is FastModeState {
    const s = raw as FastModeState | undefined;
    return !!s && typeof s === 'object' &&
        typeof s.claude === 'boolean' && typeof s.codex === 'boolean';
}

/** Whether any Claude tokens were billed at fast-mode rates on `day`. */
export function claudeFastActive(days: DayBuckets, day: string): boolean {
    const bucket = days[day];
    if (!bucket) {
        return false;
    }
    for (const key of Object.keys(bucket)) {
        const { provider, model } = parseBucketKey(key);
        if (provider === 'claude' && model.endsWith(FAST_SUFFIX) && totalTokens(bucket[key]) > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Whether `config.toml` sets the Codex fast-mode feature flag. Accepts the
 * table form (`[features]` + `fast_mode = true`) and the dotted preamble form
 * (`features.fast_mode = true`). TOML forbids duplicate keys, so the first
 * assignment found is authoritative.
 */
export function codexFastModeEnabled(toml: string): boolean {
    let table = '';
    for (const raw of toml.split(/\r?\n/)) {
        const line = raw.trim();
        const header = line.match(/^\[([^\]]+)\]/);
        if (header) {
            table = header[1].trim();
            continue;
        }
        const assignment = line.match(/^((?:[\w-]+\s*\.\s*)*)fast_mode\s*=\s*(true|false)\s*(?:#.*)?$/);
        if (!assignment) {
            continue;
        }
        const prefix = assignment[1].replace(/[\s.]+$/, '').replace(/\s/g, '');
        const keyPath = [table, prefix].filter(Boolean).join('.');
        if (keyPath === 'features') {
            return assignment[2] === 'true';
        }
    }
    return false;
}

/** Providers whose fast mode flipped off → on since `previous` was recorded. */
export function newlyActiveFastProviders(current: FastModeState, previous: FastModeState | undefined): Provider[] {
    const out: Provider[] = [];
    if (current.claude && !previous?.claude) {
        out.push('claude');
    }
    if (current.codex && !previous?.codex) {
        out.push('codex');
    }
    return out;
}
