import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { ProviderSummary, summarize } from './aggregator';
import { DailyAlertState, evaluateDailyAlert, isValidDailyAlertState, normalizeDailyAlertThresholdUsd, sameDailyAlertState } from './alert';
import { DedupeEntry, ScanCacheData, emptyCache, isValidCache } from './cache';
import { ScanTargets, scanAll } from './engine';
import { ProviderView, RtkView, StatusBarMode, clipboardText, cycleStatusBarView, detectSubscriptionMode, formatCost, statusBarText, tooltipMarkdown } from './formatter';
import { I18n } from './i18n';
import { ProviderLimits, effectiveLimits, fetchClaudeLimits, readCodexLimits } from './limits';
import { Period, dayKey, startOfMonth } from './period';
import { PricingOverrides } from './pricing';
import { RtkStats, fetchRtkStats } from './rtk';
import { TelemetryConfig, TelemetryMetric, exportTelemetry } from './telemetry';
import { Provider } from './types';

const CACHE_KEY = 'otakUsage.scanCache';
const DAILY_ALERT_STATE_KEY = 'otakUsage.dailyAlertState';
const BASE_STATUS_BAR_MODE_KEY = 'otakUsage.baseStatusBarMode';
const STATUS_BAR_MODE_INITIALIZED_KEY = 'otakUsage.statusBarModeInitialized';

interface ResolvedTargets extends ScanTargets {
    claudeAvailable: boolean;
    codexAvailable: boolean;
}

class UsageController implements vscode.Disposable {
    private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private timer: NodeJS.Timeout | undefined;
    private cache: ScanCacheData = emptyCache();
    private dedupe = new Map<string, DedupeEntry>();
    private scanning = false;
    private rtkFetching = false;
    private initialScanDone = false;
    private focused = true;
    private lastTargets: ResolvedTargets = { claudeAvailable: false, codexAvailable: false };
    private lastRtkStats: RtkStats | undefined;
    private lastClaudeLimits: ProviderLimits | undefined;
    private lastCodexLimits: ProviderLimits | undefined;
    private limitsFetching = false;
    private lastClaudeLimitsFetchMs = 0;
    private lastViews: { claude: ProviderView; codex: ProviderView; rtk: RtkView } | undefined;
    private lastSummaries: Record<Provider, ProviderSummary> | undefined;
    private dailyAlertState: DailyAlertState | undefined;
    private readonly i18n = new I18n(vscode.env.language);

    constructor(private readonly context: vscode.ExtensionContext) { }

    start(): void {
        this.statusBarItem.command = 'otak-usage.cycleStatusBarView';
        this.context.subscriptions.push(this.statusBarItem);
        this.loadCache();
        this.loadDailyAlertState();
        this.statusBarItem.text = '$(loading~spin) usage';
        this.statusBarItem.show();
        this.context.subscriptions.push(
            vscode.commands.registerCommand('otak-usage.togglePeriod', () => this.togglePeriod()),
            vscode.commands.registerCommand('otak-usage.cycleStatusBarView', () => this.cycleStatusBarView()),
            vscode.commands.registerCommand('otak-usage.refresh', () => this.refresh()),
            vscode.commands.registerCommand('otak-usage.copyUsage', () => this.copyUsage()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('otakUsage')) {
                    this.restartTimer();
                    void this.renderAndCheckAlert();
                }
            }),
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused !== this.focused) {
                    this.focused = state.focused;
                    this.restartTimer();
                }
            }),
        );
        void this.tick();
        this.restartTimer();
    }

    dispose(): void {
        this.stopTimer();
        this.statusBarItem.dispose();
    }

    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('otakUsage');
    }

    private period(): Period {
        return this.config().get<Period>('period', 'today');
    }

    private restartTimer(): void {
        this.stopTimer();
        const seconds = Math.max(10, this.config().get<number>('updateIntervalSeconds', 60));
        // Halve the polling rate while the window is unfocused.
        const intervalMs = seconds * 1000 * (this.focused ? 1 : 2);
        this.timer = setInterval(() => void this.tick(), intervalMs);
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async resolveTargets(): Promise<ResolvedTargets> {
        const config = this.config();
        const claudeDir = firstNonEmpty(config.get<string>('claudeConfigDir'), process.env.CLAUDE_CONFIG_DIR)
            ?? path.join(os.homedir(), '.claude');
        const codexHome = firstNonEmpty(config.get<string>('codexHome'), process.env.CODEX_HOME)
            ?? path.join(os.homedir(), '.codex');
        const [claudeAvailable, codexAvailable] = await Promise.all([dirExists(claudeDir), dirExists(codexHome)]);
        return {
            claudeDir: claudeAvailable ? claudeDir : undefined,
            codexHome: codexAvailable ? codexHome : undefined,
            claudeAvailable,
            codexAvailable,
        };
    }

    private async tick(): Promise<void> {
        if (this.scanning) {
            return;
        }
        this.scanning = true;
        try {
            const now = Date.now();
            const targets = await this.resolveTargets();
            this.lastTargets = targets;
            const changed = await scanAll(this.cache, this.dedupe, targets, now);
            this.initialScanDone = true;
            if (changed) {
                await this.saveCache();
            }
            await this.renderAndCheckAlert();
            void this.refreshRtkStats(dayKey(now));
            void this.refreshLimits(now);
            void this.exportTelemetry(now);
        } catch (err) {
            console.error('otak-usage: scan failed', err);
        } finally {
            this.scanning = false;
        }
    }

    private async refreshRtkStats(today: string): Promise<void> {
        let fetching = false;
        try {
            const config = this.config();
            if (!config.get<boolean>('showRtk', true)) {
                if (this.lastRtkStats !== undefined) {
                    this.lastRtkStats = undefined;
                    this.render();
                }
                return;
            }
            if (this.rtkFetching) {
                return;
            }
            this.rtkFetching = true;
            fetching = true;
            this.lastRtkStats = await fetchRtkStats(config.get<string>('rtkPath'), today);
            this.render();
        } catch (err) {
            console.error('otak-usage: rtk stats failed', err);
        } finally {
            if (fetching) {
                this.rtkFetching = false;
            }
        }
    }

    /** Claude limits come from a network endpoint — poll at most once a minute. */
    private static readonly CLAUDE_LIMITS_MIN_INTERVAL_MS = 60_000;

    private async refreshLimits(nowMs: number): Promise<void> {
        if (this.limitsFetching) {
            return;
        }
        this.limitsFetching = true;
        try {
            if (!this.config().get<boolean>('showRateLimits', true)) {
                if (this.lastClaudeLimits || this.lastCodexLimits) {
                    this.lastClaudeLimits = undefined;
                    this.lastCodexLimits = undefined;
                    this.render();
                }
                return;
            }
            const { claudeDir, codexHome } = this.lastTargets;
            const fetchClaude = claudeDir !== undefined
                && nowMs - this.lastClaudeLimitsFetchMs >= UsageController.CLAUDE_LIMITS_MIN_INTERVAL_MS;
            if (fetchClaude) {
                this.lastClaudeLimitsFetchMs = nowMs;
            }
            const [claude, codex] = await Promise.all([
                fetchClaude ? fetchClaudeLimits(claudeDir!, nowMs) : Promise.resolve(undefined),
                codexHome ? readCodexLimits(codexHome, nowMs) : Promise.resolve(undefined),
            ]);
            // A failed fetch keeps the previous snapshot; effectiveLimits()
            // neutralizes windows whose reset time has since passed.
            if (claude) {
                this.lastClaudeLimits = claude;
            }
            if (codex) {
                this.lastCodexLimits = codex;
            }
            if (claude || codex) {
                this.render();
            }
            await this.maybeDefaultToLimitsMode();
        } catch (err) {
            console.error('otak-usage: rate limit refresh failed', err);
        } finally {
            this.limitsFetching = false;
        }
    }

    /**
     * One-time first-run default: subscription users get the limits view in
     * the status bar. Runs until either a plan is detected (switch once) or
     * the user expresses a choice — an explicit statusBarMode in any settings
     * scope, or showRateLimits turned off — which is then final. Never runs
     * again after the flag is set, so later user changes always stick.
     */
    private async maybeDefaultToLimitsMode(): Promise<void> {
        if (this.context.globalState.get<boolean>(STATUS_BAR_MODE_INITIALIZED_KEY, false)) {
            return;
        }
        const config = this.config();
        const inspected = config.inspect<StatusBarMode>('statusBarMode');
        const userChose = inspected?.globalValue !== undefined
            || inspected?.workspaceValue !== undefined
            || inspected?.workspaceFolderValue !== undefined;
        if (userChose || !config.get<boolean>('showRateLimits', true)) {
            await this.context.globalState.update(STATUS_BAR_MODE_INITIALIZED_KEY, true);
            return;
        }
        const mode = detectSubscriptionMode(this.lastClaudeLimits, this.lastCodexLimits);
        if (!mode) {
            return; // no plan proven yet — try again on a later refresh
        }
        await config.update('statusBarMode', mode, vscode.ConfigurationTarget.Global);
        await this.context.globalState.update(STATUS_BAR_MODE_INITIALIZED_KEY, true);
    }

    private telemetryConfig(): TelemetryConfig {
        const tel = vscode.workspace.getConfiguration('otakUsage.telemetry');
        const metrics: TelemetryMetric[] = [];
        if (tel.get<boolean>('includeTokenUsage', true)) {
            metrics.push('tokenUsage');
        }
        if (tel.get<boolean>('includeCost', true)) {
            metrics.push('cost');
        }
        if (tel.get<boolean>('includeRtkTokens', true)) {
            metrics.push('rtkTokens');
        }
        return {
            enabled: tel.get<boolean>('enabled', false),
            metrics,
            endpoint: tel.get<string>('endpoint', 'http://localhost:4318'),
            headers: tel.get<Record<string, string>>('headers', {}),
            serviceName: tel.get<string>('serviceName', 'otak-usage'),
            serviceVersion: this.context.extension?.packageJSON?.version ?? '0.0.0',
            serviceInstanceId: tel.get<string>('serviceInstanceId', ''),
        };
    }

    private async exportTelemetry(nowMs: number): Promise<void> {
        const config = this.telemetryConfig();
        if (!config.enabled || !this.lastSummaries) {
            return;
        }
        try {
            await exportTelemetry(config, {
                timestampMs: nowMs,
                windowStartMs: startOfMonth(nowMs),
                summaries: this.lastSummaries,
                rtk: this.lastRtkStats,
            });
        } catch (err) {
            console.error('otak-usage: telemetry export failed', err);
        }
    }

    private render(): { day: string; todayTotalCost: number } | undefined {
        if (!this.initialScanDone) {
            return undefined;
        }
        const config = this.config();
        const overrides = config.get<PricingOverrides>('pricingOverrides', {});
        const period = this.period();
        const now = Date.now();
        const today = dayKey(now);
        const summaries = summarize(this.cache.days, today, overrides);
        this.lastSummaries = summaries;
        const showLimits = config.get<boolean>('showRateLimits', true);
        const claude: ProviderView = {
            summary: summaries.claude,
            available: this.lastTargets.claudeAvailable,
            show: config.get<boolean>('showClaude', true),
            limits: showLimits ? effectiveLimits(this.lastClaudeLimits, now) : undefined,
        };
        const codex: ProviderView = {
            summary: summaries.codex,
            available: this.lastTargets.codexAvailable,
            show: config.get<boolean>('showCodex', true),
            limits: showLimits ? effectiveLimits(this.lastCodexLimits, now) : undefined,
        };
        const rtk: RtkView = {
            stats: this.lastRtkStats,
            show: config.get<boolean>('showRtk', true),
        };
        this.lastViews = { claude, codex, rtk };
        const statusBarMode = showLimits ? config.get<StatusBarMode>('statusBarMode', 'cost') : 'cost';
        this.statusBarItem.text = statusBarText(claude, codex, period, false, statusBarMode);
        const tooltip = new vscode.MarkdownString(tooltipMarkdown(claude, codex, rtk, period, new Date(now), this.i18n));
        tooltip.supportThemeIcons = true;
        tooltip.supportHtml = true; // provider grid cells stack lines with <br>

        tooltip.isTrusted = { enabledCommands: ['otak-usage.copyUsage', 'workbench.action.openSettings'] };
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
        return { day: today, todayTotalCost: summaries.claude.todayCost + summaries.codex.todayCost };
    }

    private async renderAndCheckAlert(): Promise<void> {
        const snapshot = this.render();
        if (snapshot) {
            await this.checkDailyAlert(snapshot.day, snapshot.todayTotalCost);
        }
    }

    private async checkDailyAlert(day: string, todayTotalCost: number): Promise<void> {
        const threshold = normalizeDailyAlertThresholdUsd(this.config().get<unknown>('dailyAlertThresholdUsd'));
        const decision = evaluateDailyAlert(todayTotalCost, threshold, day, this.dailyAlertState);
        if (!sameDailyAlertState(this.dailyAlertState, decision.nextState)) {
            this.dailyAlertState = decision.nextState;
            await this.context.globalState.update(DAILY_ALERT_STATE_KEY, decision.nextState);
        }
        if (!decision.shouldNotify) {
            return;
        }

        const openSettings = this.i18n.t('action.openSettings');
        const message = this.i18n.t('alert.dailyCostExceeded', {
            total: formatCost(todayTotalCost),
            threshold: formatCost(threshold),
        });
        void this.showDailyAlertNotification(message, openSettings).catch((err) => {
            console.error('otak-usage: daily alert notification failed', err);
        });
    }

    private async showDailyAlertNotification(message: string, openSettings: string): Promise<void> {
        const selected = await vscode.window.showWarningMessage(message, openSettings);
        if (selected === openSettings) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'otakUsage.dailyAlertThresholdUsd');
        }
    }

    private async copyUsage(): Promise<void> {
        if (!this.lastViews) {
            return;
        }
        await vscode.env.clipboard.writeText(clipboardText(this.lastViews.claude, this.lastViews.codex, this.lastViews.rtk, new Date()));
        vscode.window.setStatusBarMessage(this.i18n.t('message.summaryCopied'), 3000);
    }

    private async togglePeriod(): Promise<void> {
        const next: Period = this.period() === 'today' ? 'month' : 'today';
        await this.config().update('period', next, vscode.ConfigurationTarget.Global);
        void this.renderAndCheckAlert();
    }

    /** Status-bar click: today's cost → this month's cost → limits → today's cost. */
    private async cycleStatusBarView(): Promise<void> {
        const config = this.config();
        const mode = config.get<StatusBarMode>('statusBarMode', 'cost');
        const limitsEnabled = config.get<boolean>('showRateLimits', true);
        const baseMode = this.context.globalState.get<StatusBarMode>(BASE_STATUS_BAR_MODE_KEY, 'cost');
        const next = cycleStatusBarView(this.period(), mode, limitsEnabled, baseMode);
        if (next.mode === 'limits' && mode !== 'limits') {
            // Remember what to restore when the cycle leaves the limits view.
            await this.context.globalState.update(BASE_STATUS_BAR_MODE_KEY, mode);
        }
        if (next.period !== this.period()) {
            await config.update('period', next.period, vscode.ConfigurationTarget.Global);
        }
        if (next.mode !== mode) {
            await config.update('statusBarMode', next.mode, vscode.ConfigurationTarget.Global);
        }
        void this.renderAndCheckAlert();
    }

    private async refresh(): Promise<void> {
        this.cache = emptyCache();
        this.dedupe.clear();
        this.initialScanDone = false;
        await this.context.globalState.update(CACHE_KEY, undefined);
        this.statusBarItem.text = '$(loading~spin) usage';
        await this.tick();
    }

    private loadCache(): void {
        const raw = this.context.globalState.get<unknown>(CACHE_KEY);
        if (isValidCache(raw)) {
            this.cache = raw;
            this.dedupe = new Map(raw.dedupe.map((r) => [r.k, { day: r.day, bucket: r.bucket, usage: r.usage }]));
        }
    }

    private loadDailyAlertState(): void {
        const raw = this.context.globalState.get<unknown>(DAILY_ALERT_STATE_KEY);
        this.dailyAlertState = isValidDailyAlertState(raw) ? raw : undefined;
    }

    private async saveCache(): Promise<void> {
        const dedupeRecords: ScanCacheData['dedupe'] = [];
        for (const [k, e] of this.dedupe) {
            dedupeRecords.push({ k, day: e.day, bucket: e.bucket, usage: e.usage });
        }
        this.cache.dedupe = dedupeRecords;
        await this.context.globalState.update(CACHE_KEY, this.cache);
    }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
    for (const v of values) {
        if (v && v.trim() !== '') {
            return v;
        }
    }
    return undefined;
}

async function dirExists(p: string): Promise<boolean> {
    try {
        return (await fsp.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const controller = new UsageController(context);
    context.subscriptions.push(controller);
    controller.start();
}

export function deactivate(): void { }
