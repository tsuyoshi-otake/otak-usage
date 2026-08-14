/**
 * Requirement-derived reference calculations for the domain-quality tests.
 *
 * This module deliberately imports no production function or pricing table.  It
 * expresses the billing requirements as a small, direct calculation so that a
 * defect in the implementation cannot be copied into the expected value.
 */
import type { TokenUsage } from '../../types';

export interface RequirementRates {
    input: number;
    cachedInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    longContextInputMultiplier?: number;
    longContextOutputMultiplier?: number;
}

export const TOKENS_PER_MILLION = 1_000_000;

export function requirementCost(usage: TokenUsage, rates: RequirementRates): number {
    const inputPremium = (rates.longContextInputMultiplier ?? 1) - 1;
    const outputPremium = (rates.longContextOutputMultiplier ?? 1) - 1;
    const billedUnits =
        usage.input * rates.input +
        usage.cachedInput * rates.cachedInput +
        usage.cacheRead * rates.cacheRead +
        usage.cacheWrite5m * rates.cacheWrite5m +
        usage.cacheWrite1h * rates.cacheWrite1h +
        usage.output * rates.output +
        (usage.longContextInput ?? 0) * rates.input * inputPremium +
        (usage.longContextCachedInput ?? 0) * rates.cachedInput * inputPremium +
        (usage.longContextOutput ?? 0) * rates.output * outputPremium;
    return billedUnits / TOKENS_PER_MILLION;
}

export function requirementAdd(left: TokenUsage, right: TokenUsage): TokenUsage {
    return {
        input: left.input + right.input,
        cachedInput: left.cachedInput + right.cachedInput,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite5m: left.cacheWrite5m + right.cacheWrite5m,
        cacheWrite1h: left.cacheWrite1h + right.cacheWrite1h,
        output: left.output + right.output,
        longContextInput: (left.longContextInput ?? 0) + (right.longContextInput ?? 0),
        longContextCachedInput: (left.longContextCachedInput ?? 0) + (right.longContextCachedInput ?? 0),
        longContextOutput: (left.longContextOutput ?? 0) + (right.longContextOutput ?? 0),
    };
}

export function requirementTotal(usage: TokenUsage): number {
    // Long-context fields are billing classifications of tokens already present
    // in the six displayed counters; including them would double count.
    return usage.input + usage.cachedInput + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h + usage.output;
}

export function requirementLocalDay(epochMs: number): string {
    const value = new Date(epochMs);
    const year = value.getFullYear();
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const date = `${value.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${date}`;
}

export function requirementLocalMidnight(epochMs: number): number {
    const value = new Date(epochMs);
    return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function requirementMonthStart(epochMs: number): number {
    const value = new Date(epochMs);
    return new Date(value.getFullYear(), value.getMonth(), 1).getTime();
}

export function requirementPreviousMonthEnd(epochMs: number): number {
    const value = new Date(epochMs);
    return new Date(value.getFullYear(), value.getMonth(), 0).getTime();
}
