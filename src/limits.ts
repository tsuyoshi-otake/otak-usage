import * as fsp from 'fs/promises';
import * as path from 'path';
import { listCodexFiles } from './scanner/codexScanner';

/** One rate-limit window (e.g. the 5-hour session window or the weekly window). */
export interface LimitWindow {
    /** 0-100; how much of the window's allowance has been consumed */
    usedPercent: number;
    /** epoch milliseconds; undefined when the provider did not report it */
    resetsAtMs?: number;
    /** window length in minutes (300 = 5h, 10080 = 7d); undefined when unreported */
    windowMinutes?: number;
}

/** Subscription rate-limit snapshot for one provider. */
export interface ProviderLimits {
    /**
     * The provider's first reported window. Usually the short session window
     * (Claude "5-hour"), but Codex plans without a session limit report their
     * weekly window here — check windowMinutes rather than assuming 5h.
     */
    primary?: LimitWindow;
    /** long window (Claude "7-day", Codex secondary / 10080 min) */
    secondary?: LimitWindow;
    /** subscription plan, e.g. "max" (Claude) or "pro" (Codex) */
    planType?: string;
    /** when this snapshot was produced (epoch ms) */
    asOfMs: number;
}

/**
 * A window whose reset time has already passed carries no information about
 * the new window — treat it as fully available instead of showing a stale
 * (typically alarming) percentage. Codex snapshots come from the last session
 * log line, which can be hours old.
 */
export function effectiveLimits(limits: ProviderLimits | undefined, nowMs: number): ProviderLimits | undefined {
    if (!limits) {
        return undefined;
    }
    const primary = effectiveWindow(limits.primary, nowMs);
    const secondary = effectiveWindow(limits.secondary, nowMs);
    if (!primary && !secondary) {
        return undefined;
    }
    return { ...limits, primary, secondary };
}

function effectiveWindow(window: LimitWindow | undefined, nowMs: number): LimitWindow | undefined {
    if (!window) {
        return undefined;
    }
    if (window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs) {
        return { usedPercent: 0, windowMinutes: window.windowMinutes };
    }
    return window;
}

// ---------------------------------------------------------------------------
// Claude Code — OAuth usage endpoint (same source as the CLI's /usage command)
// ---------------------------------------------------------------------------

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

interface ClaudeCredentials {
    accessToken: string;
    expiresAt?: number;
    subscriptionType?: string;
}

/**
 * Claude Code does not log rate-limit state locally, so query the usage
 * endpoint with the OAuth token Claude Code itself stores in
 * <claudeDir>/.credentials.json. Never refreshes the token (that is Claude
 * Code's job); an expired or missing token yields undefined.
 * On macOS the credentials live in the Keychain instead of the file, in
 * which case Claude limits are simply unavailable.
 */
export async function fetchClaudeLimits(claudeDir: string, nowMs: number, fetchFn: typeof fetch = fetch): Promise<ProviderLimits | undefined> {
    const cred = await readClaudeCredentials(claudeDir);
    if (!cred || (cred.expiresAt !== undefined && cred.expiresAt <= nowMs)) {
        return undefined;
    }
    let body: unknown;
    try {
        const res = await fetchFn(CLAUDE_USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${cred.accessToken}`,
                'anthropic-beta': CLAUDE_OAUTH_BETA,
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            return undefined;
        }
        body = await res.json();
    } catch {
        return undefined;
    }
    return parseClaudeUsageResponse(body, nowMs, cred.subscriptionType);
}

async function readClaudeCredentials(claudeDir: string): Promise<ClaudeCredentials | undefined> {
    let raw: any;
    try {
        raw = JSON.parse(await fsp.readFile(path.join(claudeDir, '.credentials.json'), 'utf8'));
    } catch {
        return undefined;
    }
    const oauth = raw?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken === '') {
        return undefined;
    }
    return {
        accessToken: oauth.accessToken,
        expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
        subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    };
}

/** Parse the /api/oauth/usage response body ({ five_hour, seven_day, ... }). */
export function parseClaudeUsageResponse(body: unknown, nowMs: number, planType?: string): ProviderLimits | undefined {
    const b = body as any;
    const primary = windowFromClaude(b?.five_hour, 300);
    const secondary = windowFromClaude(b?.seven_day, 10080);
    if (!primary && !secondary) {
        return undefined;
    }
    return { primary, secondary, planType, asOfMs: nowMs };
}

function windowFromClaude(w: any, windowMinutes: number): LimitWindow | undefined {
    if (typeof w?.utilization !== 'number') {
        return undefined;
    }
    const resets = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return {
        usedPercent: w.utilization,
        resetsAtMs: Number.isNaN(resets) ? undefined : resets,
        windowMinutes,
    };
}

// ---------------------------------------------------------------------------
// Codex CLI — rate_limits embedded in rollout session logs
// ---------------------------------------------------------------------------

/** How much of a rollout file's tail to inspect for the last rate_limits record. */
const CODEX_TAIL_BYTES = 256 * 1024;
/** How many of the most recent rollout files to try before giving up. */
const CODEX_MAX_FILES = 5;
/** Ignore snapshots older than the weekly window — nothing in them is still current. */
const CODEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Codex token_count events carry the server-reported rate_limits, so the most
 * recent session log already contains the latest snapshot. Reads only the tail
 * of the newest few files.
 */
export async function readCodexLimits(codexHome: string, nowMs: number): Promise<ProviderLimits | undefined> {
    let files;
    try {
        files = await listCodexFiles(codexHome, nowMs, nowMs - CODEX_MAX_AGE_MS);
    } catch {
        return undefined;
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(0, CODEX_MAX_FILES)) {
        const found = await lastRateLimitsInFile(file.path, file.size);
        if (found) {
            return found;
        }
    }
    return undefined;
}

async function lastRateLimitsInFile(filePath: string, size: number): Promise<ProviderLimits | undefined> {
    const start = Math.max(0, size - CODEX_TAIL_BYTES);
    let text: string;
    try {
        const handle = await fsp.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(size - start);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
            await handle.close();
        }
    } catch {
        return undefined;
    }
    const lines = text.split('\n');
    // When reading from mid-file the first chunk is a partial line — drop it.
    const first = start > 0 ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
        if (!lines[i].includes('"rate_limits"')) {
            continue;
        }
        const parsed = parseCodexRateLimitLine(lines[i]);
        if (parsed) {
            return parsed;
        }
    }
    return undefined;
}

/** Parse one rollout line; returns limits when it carries payload.rate_limits. */
export function parseCodexRateLimitLine(line: string): ProviderLimits | undefined {
    let rec: any;
    try {
        rec = JSON.parse(line);
    } catch {
        return undefined;
    }
    const rl = rec?.payload?.rate_limits;
    if (!rl) {
        return undefined;
    }
    const asOfMs = Date.parse(rec?.timestamp);
    if (Number.isNaN(asOfMs)) {
        return undefined;
    }
    const primary = windowFromCodex(rl.primary);
    const secondary = windowFromCodex(rl.secondary);
    if (!primary && !secondary) {
        return undefined;
    }
    return {
        primary,
        secondary,
        planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
        asOfMs,
    };
}

function windowFromCodex(w: any): LimitWindow | undefined {
    if (typeof w?.used_percent !== 'number') {
        return undefined;
    }
    return {
        usedPercent: w.used_percent,
        // rollout logs store resets_at as epoch seconds
        resetsAtMs: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined,
        windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
    };
}
