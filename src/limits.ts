import * as fsp from 'fs/promises';
import * as path from 'path';
import { listCodexFiles } from './scanner/codexScanner';
import { ScannedFile } from './scanner/scanIndex';

/** One rate-limit window (e.g. the 5-hour session window or the weekly window). */
export interface LimitWindow {
    /** 0-100; how much of the window's allowance has been consumed */
    usedPercent: number;
    /** epoch milliseconds; undefined when the provider did not report it */
    resetsAtMs?: number;
    /** window length in minutes (300 = 5h, 10080 = 7d); undefined when unreported */
    windowMinutes?: number;
    /**
     * Server-supplied name for a model-scoped window (e.g. "Fable"). Shared
     * session / all-models windows leave this unset.
     */
    label?: string;
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
    /**
     * Model-scoped weekly windows from Claude's usage endpoint (Fable, and any
     * later named sub-cap). Empty / omitted when the account has none.
     */
    scoped?: LimitWindow[];
    /**
     * Codex banked rate-limit resets still available to redeem. Omitted when
     * the account did not report a count (API-key plans, failed fetch).
     */
    bankedResets?: number;
    /** subscription plan, e.g. "max" (Claude) or "pro" (Codex) */
    planType?: string;
    /** when this snapshot was produced (epoch ms) */
    asOfMs: number;
}

/**
 * Codex snapshots are last-seen-in-log. After this age they are treated as
 * unknown rather than as a live remaining-%, even when `resetsAt` is still
 * in the future. Claude snapshots use fetch time as `asOfMs`, so they stay
 * inside the bound whenever the OAuth call succeeded.
 */
export const LIMITS_FRESHNESS_MS = 6 * 60 * 60 * 1000;

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
    if (nowMs - limits.asOfMs > LIMITS_FRESHNESS_MS) {
        return undefined;
    }
    const primary = effectiveWindow(limits.primary, nowMs);
    const secondary = effectiveWindow(limits.secondary, nowMs);
    const scoped = limits.scoped
        ?.map((window) => effectiveWindow(window, nowMs))
        .filter((window): window is LimitWindow => window !== undefined);
    if (!primary && !secondary && (!scoped || scoped.length === 0) && limits.bankedResets === undefined) {
        return undefined;
    }
    const next = { ...limits, primary, secondary };
    if (scoped && scoped.length > 0) {
        next.scoped = scoped;
    } else {
        delete next.scoped;
    }
    return next;
}

function effectiveWindow(window: LimitWindow | undefined, nowMs: number): LimitWindow | undefined {
    if (!window) {
        return undefined;
    }
    if (window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs) {
        return { usedPercent: 0, windowMinutes: window.windowMinutes, label: window.label };
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
export async function fetchClaudeLimits(
    claudeDir: string,
    nowMs: number,
    fetchFn: typeof fetch = fetch,
    timeoutMs = 10_000,
): Promise<ProviderLimits | undefined> {
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
            signal: AbortSignal.timeout(timeoutMs),
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

/** Parse the /api/oauth/usage response body ({ five_hour, seven_day, limits, ... }). */
export function parseClaudeUsageResponse(body: unknown, nowMs: number, planType?: string): ProviderLimits | undefined {
    const b = body as any;
    let primary = windowFromClaude(b?.five_hour, 300);
    let secondary = windowFromClaude(b?.seven_day, 10080);
    const fromLimits = windowsFromClaudeLimitsArray(b?.limits);
    if (!primary && fromLimits.session) {
        primary = fromLimits.session;
    }
    if (!secondary && fromLimits.weeklyAll) {
        secondary = fromLimits.weeklyAll;
    }
    const scoped = scopedWindowsFromClaude(b, fromLimits.scoped);
    if (!primary && !secondary && scoped.length === 0) {
        return undefined;
    }
    return {
        primary,
        secondary,
        scoped: scoped.length > 0 ? scoped : undefined,
        planType,
        asOfMs: nowMs,
    };
}

/**
 * Stable id fragment for a scoped window, used in limit-alert records
 * (`claude:scoped:fable`). Display names stay as the server sent them.
 */
export function scopedWindowSlug(label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'scoped';
}

function windowFromClaude(w: any, windowMinutes: number, label?: string): LimitWindow | undefined {
    const used = usedPercentFromClaude(w);
    if (used === undefined) {
        return undefined;
    }
    const resets = typeof w?.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return {
        usedPercent: used,
        resetsAtMs: Number.isNaN(resets) ? undefined : resets,
        windowMinutes,
        label,
    };
}

function usedPercentFromClaude(w: any): number | undefined {
    if (typeof w?.percent === 'number') {
        return w.percent;
    }
    if (typeof w?.utilization === 'number') {
        return w.utilization;
    }
    return undefined;
}

function windowsFromClaudeLimitsArray(limits: unknown): {
    session?: LimitWindow;
    weeklyAll?: LimitWindow;
    scoped: LimitWindow[];
} {
    const scoped: LimitWindow[] = [];
    let session: LimitWindow | undefined;
    let weeklyAll: LimitWindow | undefined;
    if (!Array.isArray(limits)) {
        return { scoped };
    }
    for (const entry of limits) {
        const kind = typeof entry?.kind === 'string' ? entry.kind : '';
        if (kind === 'session') {
            session = session ?? windowFromClaude(entry, 300);
            continue;
        }
        if (kind === 'weekly_all') {
            weeklyAll = weeklyAll ?? windowFromClaude(entry, 10080);
            continue;
        }
        if (kind !== 'weekly_scoped') {
            continue;
        }
        const name = typeof entry?.scope?.model?.display_name === 'string'
            ? entry.scope.model.display_name
            : '';
        if (name === '') {
            continue;
        }
        const window = windowFromClaude(entry, 10080, name);
        if (window) {
            scoped.push(window);
        }
    }
    return { session, weeklyAll, scoped };
}

function scopedWindowsFromClaude(body: any, fromLimits: LimitWindow[]): LimitWindow[] {
    const seen = new Set<string>();
    const out: LimitWindow[] = [];
    const add = (window: LimitWindow | undefined): void => {
        const key = (window?.label ?? '').toLowerCase();
        if (!window || key === '' || seen.has(key)) {
            return;
        }
        seen.add(key);
        out.push(window);
    };
    for (const window of fromLimits) {
        add(window);
    }
    if (Array.isArray(body?.model_scoped)) {
        for (const entry of body.model_scoped) {
            const name = typeof entry?.display_name === 'string'
                ? entry.display_name
                : typeof entry?.scope?.model?.display_name === 'string'
                    ? entry.scope.model.display_name
                    : '';
            if (name === '') {
                continue;
            }
            add(windowFromClaude(entry, 10080, name));
        }
    }
    add(windowFromClaude(body?.seven_day_fable, 10080, 'Fable'));
    return out;
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
 * Pick the newest rollout files out of metadata the scan already collected.
 * The scan stat()s every rollout file each tick, so walking the session tree a
 * second time here would double a tick's syscall count to rediscover the same
 * handful of paths. Returns an empty list when the cache knows of none, which
 * lets the caller fall back to a real walk.
 */
export function recentCodexFiles(
    files: Record<string, { size: number; mtimeMs: number }>,
    codexHome: string,
    nowMs: number,
    limit = CODEX_MAX_FILES,
): ScannedFile[] {
    const prefix = path.join(codexHome, 'sessions') + path.sep;
    const minMtimeMs = nowMs - CODEX_MAX_AGE_MS;
    const out: ScannedFile[] = [];
    for (const [p, state] of Object.entries(files)) {
        if (state.mtimeMs >= minMtimeMs && p.startsWith(prefix)) {
            out.push({ path: p, size: state.size, mtimeMs: state.mtimeMs });
        }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, limit);
}

/**
 * Codex token_count events carry the server-reported rate_limits, so the most
 * recent session log already contains the latest snapshot. Reads only the tail
 * of the newest few files. `known` supplies pre-stat()ed candidates (see
 * recentCodexFiles); the session tree is only walked when it is empty.
 */
export async function readCodexLimits(codexHome: string, nowMs: number, known?: ScannedFile[]): Promise<ProviderLimits | undefined> {
    let files = known;
    if (!files || files.length === 0) {
        try {
            files = await listCodexFiles(codexHome, nowMs, nowMs - CODEX_MAX_AGE_MS);
        } catch {
            return undefined;
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        files = files.slice(0, CODEX_MAX_FILES);
    }
    for (const file of files) {
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
    const bankedResets = bankedResetsFromUnknown(rl);
    if (!primary && !secondary && bankedResets === undefined) {
        return undefined;
    }
    return {
        primary,
        secondary,
        bankedResets,
        planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
        asOfMs,
    };
}

// ---------------------------------------------------------------------------
// Codex CLI — banked resets from the ChatGPT usage endpoint
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface CodexCredentials {
    accessToken: string;
    accountId: string;
}

/**
 * Banked reset count is not written into rollout logs, so query the same
 * ChatGPT usage endpoint Codex's /usage screen uses. Never refreshes the
 * token (that is Codex CLI's job); a missing or rejected credential yields
 * undefined.
 */
export async function fetchCodexBankedResets(
    codexHome: string,
    fetchFn: typeof fetch = fetch,
    timeoutMs = 10_000,
): Promise<number | undefined> {
    const cred = await readCodexCredentials(codexHome);
    if (!cred) {
        return undefined;
    }
    let body: unknown;
    try {
        const res = await fetchFn(CODEX_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${cred.accessToken}`,
                'ChatGPT-Account-Id': cred.accountId,
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            return undefined;
        }
        body = await res.json();
    } catch {
        return undefined;
    }
    return bankedResetsFromUnknown(body);
}

async function readCodexCredentials(codexHome: string): Promise<CodexCredentials | undefined> {
    let raw: any;
    try {
        raw = JSON.parse(await fsp.readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    } catch {
        return undefined;
    }
    const tokens = raw?.tokens;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : undefined;
    const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : undefined;
    if (!accessToken || accessToken === '' || !accountId || accountId === '') {
        return undefined;
    }
    return { accessToken, accountId };
}

/**
 * Overlay a fetched banked-reset count on the latest Codex snapshot. A failed
 * or skipped fetch keeps the previous count; a successful 0 is stored as 0.
 */
export function withCodexBankedResets(
    latest: ProviderLimits | undefined,
    previous: ProviderLimits | undefined,
    fetched: number | undefined,
    nowMs: number,
): ProviderLimits | undefined {
    const count = fetched ?? latest?.bankedResets ?? previous?.bankedResets;
    if (latest) {
        return count === undefined ? latest : { ...latest, bankedResets: count };
    }
    if (count === undefined) {
        return previous;
    }
    return { ...(previous ?? { asOfMs: nowMs }), bankedResets: count };
}

/** Read available_count from a usage payload or a rollout rate_limits object. */
export function bankedResetsFromUnknown(body: unknown): number | undefined {
    const b = body as any;
    const n = b?.rate_limit_reset_credits?.available_count
        ?? b?.rateLimitResetCredits?.availableCount
        ?? b?.available_count;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        return undefined;
    }
    return Math.floor(n);
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
