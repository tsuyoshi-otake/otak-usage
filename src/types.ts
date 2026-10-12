export type Provider = 'claude' | 'codex';

/**
 * Token counts for a single usage event, normalized across providers.
 * - Claude: input (uncached), cacheRead, cacheWrite5m/1h, output.
 * - Codex:  input (uncached = input_tokens - cached_input_tokens),
 *           cachedInput, output (includes reasoning tokens).
 */
export interface TokenUsage {
    input: number;
    cachedInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    /** Subsets billed with a model's long-context premium; excluded from displayed token totals. */
    longContextInput?: number;
    longContextCachedInput?: number;
    longContextOutput?: number;
    longContextCacheRead?: number;
    longContextCacheWrite5m?: number;
    longContextCacheWrite1h?: number;
}

export interface UsageEvent {
    provider: Provider;
    model: string;
    /** epoch milliseconds */
    timestamp: number;
    usage: TokenUsage;
}

/** days["YYYY-MM-DD"]["provider/model"] -> accumulated TokenUsage */
export type DayBuckets = Record<string, Record<string, TokenUsage>>;

export function emptyUsage(): TokenUsage {
    return {
        input: 0,
        cachedInput: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        longContextInput: 0,
        longContextCachedInput: 0,
        longContextOutput: 0,
        longContextCacheRead: 0,
        longContextCacheWrite5m: 0,
        longContextCacheWrite1h: 0,
    };
}

export function addUsage(target: TokenUsage, source: TokenUsage): void {
    target.input += source.input;
    target.cachedInput += source.cachedInput;
    target.cacheRead += source.cacheRead;
    target.cacheWrite5m += source.cacheWrite5m;
    target.cacheWrite1h += source.cacheWrite1h;
    target.output += source.output;
    target.longContextInput = (target.longContextInput ?? 0) + (source.longContextInput ?? 0);
    target.longContextCachedInput = (target.longContextCachedInput ?? 0) + (source.longContextCachedInput ?? 0);
    target.longContextOutput = (target.longContextOutput ?? 0) + (source.longContextOutput ?? 0);
    target.longContextCacheRead = (target.longContextCacheRead ?? 0) + (source.longContextCacheRead ?? 0);
    target.longContextCacheWrite5m = (target.longContextCacheWrite5m ?? 0) + (source.longContextCacheWrite5m ?? 0);
    target.longContextCacheWrite1h = (target.longContextCacheWrite1h ?? 0) + (source.longContextCacheWrite1h ?? 0);
}

/** Reverse a prior addUsage so a superseded record's contribution can be replaced. */
export function subtractUsage(target: TokenUsage, source: TokenUsage): void {
    target.input -= source.input;
    target.cachedInput -= source.cachedInput;
    target.cacheRead -= source.cacheRead;
    target.cacheWrite5m -= source.cacheWrite5m;
    target.cacheWrite1h -= source.cacheWrite1h;
    target.output -= source.output;
    target.longContextInput = (target.longContextInput ?? 0) - (source.longContextInput ?? 0);
    target.longContextCachedInput = (target.longContextCachedInput ?? 0) - (source.longContextCachedInput ?? 0);
    target.longContextOutput = (target.longContextOutput ?? 0) - (source.longContextOutput ?? 0);
    target.longContextCacheRead = (target.longContextCacheRead ?? 0) - (source.longContextCacheRead ?? 0);
    target.longContextCacheWrite5m = (target.longContextCacheWrite5m ?? 0) - (source.longContextCacheWrite5m ?? 0);
    target.longContextCacheWrite1h = (target.longContextCacheWrite1h ?? 0) - (source.longContextCacheWrite1h ?? 0);
}

export function totalTokens(u: TokenUsage): number {
    return u.input + u.cachedInput + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;
}

export function bucketKey(provider: Provider, model: string): string {
    return `${provider}/${model}`;
}

export function parseBucketKey(key: string): { provider: Provider; model: string } {
    const slash = key.indexOf('/');
    return { provider: key.slice(0, slash) as Provider, model: key.slice(slash + 1) };
}
