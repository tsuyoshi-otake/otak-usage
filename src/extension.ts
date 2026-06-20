import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { summarize } from './aggregator';
import { DailyAlertState, evaluateDailyAlert, isValidDailyAlertState, normalizeDailyAlertThresholdUsd, sameDailyAlertState } from './alert';
import { DedupeEntry, ScanCacheData, emptyCache, isValidCache } from './cache';
import { ScanTargets, scanAll } from './engine';
import { ProviderView, RtkView, clipboardText, formatCost, statusBarText, tooltipMarkdown } from './formatter';
import { I18n } from './i18n';
import { Period, dayKey } from './period';
import { PricingOverrides } from './pricing';
import { RtkStats, fetchRtkStats } from './rtk';

const CACHE_KEY = 'otakUsage.scanCache';
const DAILY_ALERT_STATE_KEY = 'otakUsage.dailyAlertState';

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
    private lastViews: { claude: ProviderView; codex: ProviderView; rtk: RtkView } | undefined;
    private dailyAlertState: DailyAlertState | undefined;
    private readonly i18n = new I18n(vscode.env.language);

    constructor(private readonly context: vscode.ExtensionContext) { }

    start(): void {
        this.statusBarItem.command = 'otak-usage.togglePeriod';
        this.context.subscriptions.push(this.statusBarItem);
        this.loadCache();
        this.loadDailyAlertState();
        this.statusBarItem.text = '$(loading~spin) usage';
        this.statusBarItem.show();
        this.context.subscriptions.push(
            vscode.commands.registerCommand('otak-usage.togglePeriod', () => this.togglePeriod()),
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
        const claude: ProviderView = {
            summary: summaries.claude,
            available: this.lastTargets.claudeAvailable,
            show: config.get<boolean>('showClaude', true),
        };
        const codex: ProviderView = {
            summary: summaries.codex,
            available: this.lastTargets.codexAvailable,
            show: config.get<boolean>('showCodex', true),
        };
        const rtk: RtkView = {
            stats: this.lastRtkStats,
            show: config.get<boolean>('showRtk', true),
        };
        this.lastViews = { claude, codex, rtk };
        this.statusBarItem.text = statusBarText(claude, codex, period, false);
        const tooltip = new vscode.MarkdownString(tooltipMarkdown(claude, codex, rtk, period, new Date(now), this.i18n));
        tooltip.supportThemeIcons = true;
        tooltip.isTrusted = { enabledCommands: ['otak-usage.copyUsage'] };
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
