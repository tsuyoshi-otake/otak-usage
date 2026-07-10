import { TokenUsage } from './types';

/** Appended to a Claude model id when the transcript marks the response as fast mode. */
export const FAST_SUFFIX = '-fast';

/**
 * Prices in USD per million tokens.
 * Claude models use input/output/cacheRead/cacheWrite5m/cacheWrite1h.
 * OpenAI models use input/cachedInput/output.
 * Omitted cache prices fall back to the standard multipliers of the input price:
 * cacheWrite5m = 1.25x, cacheWrite1h = 2x, cacheRead = 0.1x, cachedInput = 0.1x.
 */
export interface ModelPricing {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    cachedInput?: number;
    longContextThreshold?: number;
    longContextInputMultiplier?: number;
    longContextOutputMultiplier?: number;
}

const GPT_LONG_CONTEXT_PRICING = {
    longContextThreshold: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
} as const;

/**
 * Verified against the official pricing pages:
 * - Claude prices on 2026-07-02: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI prices on 2026-07-10: https://developers.openai.com/api/docs/pricing
 * Models no longer on the official pages use their last published prices.
 * Lookup is exact match first, then longest prefix match, so dated ids like
 * "claude-opus-4-8-20250915" or variants like "gpt-5.3-codex-spark" resolve
 * to their base entry. Claude fast-mode lines are mapped by the scanner to
 * "<model>-fast" ids and priced by the explicit -fast entries.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
    // Anthropic (Claude Code)
    'claude-fable-5': { input: 10, output: 50 },
    'claude-mythos-5': { input: 10, output: 50 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-opus-4-5': { input: 5, output: 25 },
    'claude-opus-4-1': { input: 15, output: 75 },
    'claude-opus-4': { input: 15, output: 75 },
    // Fast mode (usage.speed === "fast"): premium prices; the cache-write/read
    // multipliers stack on top of the fast input price.
    'claude-opus-4-8-fast': { input: 10, output: 50 },
    'claude-opus-4-7-fast': { input: 30, output: 150 },
    'claude-opus-4-6-fast': { input: 30, output: 150 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-sonnet-4': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-3-7-sonnet': { input: 3, output: 15 },
    'claude-3-5-sonnet': { input: 3, output: 15 },
    'claude-3-5-haiku': { input: 0.8, output: 4 },
    'claude-3-opus': { input: 15, output: 75 },
    'claude-3-sonnet': { input: 3, output: 15 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    // OpenAI (Codex CLI)
    'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6, ...GPT_LONG_CONTEXT_PRICING },
    // The unsuffixed alias routes to GPT-5.6 Sol.
    'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.5-pro': { input: 30, output: 180, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.4-pro': { input: 30, output: 180, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
    'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15, ...GPT_LONG_CONTEXT_PRICING },
    'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
    'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
    'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
    'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
    'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
    'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
    'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
    'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
    'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
    'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
    // Older models the Codex CLI shipped with before GPT-5
    'codex-mini-latest': { input: 1.5, cachedInput: 0.375, output: 6 },
    'o3-pro': { input: 20, output: 80 },
    'o3-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
    'o3': { input: 2, cachedInput: 0.5, output: 8 },
    'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
    'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
    'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
    'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
    'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
};

const DEFAULT_PRICING_REVISIONS: Record<string, Array<{ from: string; pricing: Partial<ModelPricing> }>> = {
    'claude-sonnet-5': [
        { from: '2026-09-01', pricing: { input: 3, output: 15 } },
    ],
};

export type PricingOverrides = Record<string, Partial<ModelPricing>>;

/**
 * Exact match first, then longest prefix match, per table. Override entries are
 * merged on top of the default entry, so a partial override (e.g. only `input`)
 * still inherits the remaining prices. `effectiveDay`, when provided, is a
 * YYYY-MM-DD day used for scheduled pricing revisions. Returns undefined for
 * unknown models.
 */
export function resolvePricing(model: string, overrides?: PricingOverrides, effectiveDay?: string): ModelPricing | undefined {
    const base = lookup(model, DEFAULT_PRICING, effectiveDay, DEFAULT_PRICING_REVISIONS);
    const over = overrides ? lookup(model, overrides, effectiveDay) : undefined;
    if (!base && !over) {
        return undefined;
    }
    return withDefaults({ ...base, ...over });
}

function lookup(
    model: string,
    table: Record<string, Partial<ModelPricing>>,
    effectiveDay?: string,
    revisions: Record<string, Array<{ from: string; pricing: Partial<ModelPricing> }>> = {},
): Partial<ModelPricing> | undefined {
    if (table[model]) {
        return applyRevisions(model, table[model], effectiveDay, revisions);
    }
    let best: Partial<ModelPricing> | undefined;
    let bestKey: string | undefined;
    let bestLen = -1;
    for (const key of Object.keys(table)) {
        if (matches(model, key) && key.length > bestLen) {
            best = table[key];
            bestKey = key;
            bestLen = key.length;
        }
    }
    return bestKey && best ? applyRevisions(bestKey, best, effectiveDay, revisions) : undefined;
}

function applyRevisions(
    key: string,
    pricing: Partial<ModelPricing>,
    effectiveDay: string | undefined,
    revisions: Record<string, Array<{ from: string; pricing: Partial<ModelPricing> }>>,
): Partial<ModelPricing> {
    if (!effectiveDay) {
        return pricing;
    }
    let resolved = pricing;
    for (const revision of revisions[key] ?? []) {
        if (effectiveDay >= revision.from) {
            resolved = { ...resolved, ...revision.pricing };
        }
    }
    return resolved;
}

/**
 * Plain prefix match, plus: "-fast" keys also match "-fast" models whose extra
 * id parts sit before the marker, so "claude-opus-4-7-20260120-fast" resolves
 * to "claude-opus-4-7-fast" (longest match) rather than the cheaper
 * "claude-opus-4-7".
 */
function matches(model: string, key: string): boolean {
    if (model.startsWith(key)) {
        return true;
    }
    return key.endsWith(FAST_SUFFIX) && model.endsWith(FAST_SUFFIX) &&
        model.slice(0, -FAST_SUFFIX.length).startsWith(key.slice(0, -FAST_SUFFIX.length));
}

function withDefaults(p: Partial<ModelPricing>): ModelPricing | undefined {
    if (p.input === undefined || p.output === undefined) {
        return undefined;
    }
    return {
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead ?? p.input * 0.1,
        cacheWrite: p.cacheWrite ?? p.input * 1.25,
        cacheWrite1h: p.cacheWrite1h ?? p.input * 2,
        cachedInput: p.cachedInput ?? p.input * 0.1,
        longContextThreshold: p.longContextThreshold,
        longContextInputMultiplier: p.longContextInputMultiplier,
        longContextOutputMultiplier: p.longContextOutputMultiplier,
    };
}

/** Whether one request crosses the model's long-context pricing threshold. */
export function isLongContextRequest(model: string, inputTokens: number): boolean {
    const threshold = resolvePricing(model)?.longContextThreshold;
    return threshold !== undefined && inputTokens > threshold;
}

const M = 1_000_000;

/** Cost in USD. Returns undefined for unknown models. */
export function calcCost(model: string, usage: TokenUsage, overrides?: PricingOverrides, effectiveDay?: string): number | undefined {
    const p = resolvePricing(model, overrides, effectiveDay);
    if (!p) {
        return undefined;
    }
    const longInputPremium = (p.longContextInputMultiplier ?? 1) - 1;
    const longOutputPremium = (p.longContextOutputMultiplier ?? 1) - 1;
    return (
        (usage.input * p.input +
            usage.cachedInput * (p.cachedInput ?? 0) +
            usage.cacheRead * (p.cacheRead ?? 0) +
            usage.cacheWrite5m * (p.cacheWrite ?? 0) +
            usage.cacheWrite1h * (p.cacheWrite1h ?? 0) +
            usage.output * p.output +
            (usage.longContextInput ?? 0) * p.input * longInputPremium +
            (usage.longContextCachedInput ?? 0) * (p.cachedInput ?? 0) * longInputPremium +
            (usage.longContextOutput ?? 0) * p.output * longOutputPremium) / M
    );
}
