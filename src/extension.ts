import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { summarize } from './aggregator';
import { ScanCacheData, emptyCache, isValidCache } from './cache';
import { ScanTargets, scanAll } from './engine';
import { ProviderView, statusBarText, tooltipMarkdown } from './formatter';
import { Period, dayKey } from './period';
import { PricingOverrides } from './pricing';

const CACHE_KEY = 'otakUsage.scanCache';

interface ResolvedTargets extends ScanTargets {
    claudeAvailable: boolean;
    codexAvailable: boolean;
}

class UsageController implements vscode.Disposable {
    private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private timer: NodeJS.Timeout | undefined;
    private cache: ScanCacheData = emptyCache();
    private dedupe = new Set<string>();
    private scanning = false;
    private initialScanDone = false;
    private focused = true;
    private lastTargets: ResolvedTargets = { claudeAvailable: false, codexAvailable: false };

    constructor(private readonly context: vscode.ExtensionContext) { }

    start(): void {
        this.statusBarItem.command = 'otak-usage.togglePeriod';
        this.context.subscriptions.push(this.statusBarItem);
        this.loadCache();
        this.statusBarItem.text = '$(loading~spin) usage';
        this.statusBarItem.show();
        this.context.subscriptions.push(
            vscode.commands.registerCommand('otak-usage.togglePeriod', () => this.togglePeriod()),
            vscode.commands.registerCommand('otak-usage.refresh', () => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('otakUsage')) {
                    this.restartTimer();
                    this.render();
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
            const targets = await this.resolveTargets();
            this.lastTargets = targets;
            const changed = await scanAll(this.cache, this.dedupe, targets, Date.now());
            this.initialScanDone = true;
            if (changed) {
                await this.saveCache();
            }
            this.render();
        } catch (err) {
            console.error('otak-usage: scan failed', err);
        } finally {
            this.scanning = false;
        }
    }

    private render(): void {
        if (!this.initialScanDone) {
            return;
        }
        const config = this.config();
        const overrides = config.get<PricingOverrides>('pricingOverrides', {});
        const period = this.period();
        const summaries = summarize(this.cache.days, dayKey(Date.now()), overrides);
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
        this.statusBarItem.text = statusBarText(claude, codex, period, false);
        const tooltip = new vscode.MarkdownString(tooltipMarkdown(claude, codex, period, new Date()));
        tooltip.supportThemeIcons = true;
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
    }

    private async togglePeriod(): Promise<void> {
        const next: Period = this.period() === 'today' ? 'month' : 'today';
        await this.config().update('period', next, vscode.ConfigurationTarget.Global);
        this.render();
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
            this.dedupe = new Set(raw.dedupe);
        }
    }

    private async saveCache(): Promise<void> {
        this.cache.dedupe = [...this.dedupe];
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
