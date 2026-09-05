import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { ProviderSummary, summarize } from './aggregator';
import { AlertMode, DailyAlertState, LimitAlertState, LimitAlertWindow, alertModeIncludesCost, alertModeIncludesLimit, evaluateDailyAlert, evaluateLimitAlert, isSnoozed, isValidDailyAlertState, isValidLimitAlertState, normalizeAlertMode, normalizeDailyAlertThresholdUsd, normalizeLimitAlertThresholdPercent, sameDailyAlertState, sameLimitAlertState, snoozeUntilEndOfDay } from './alert';
import { ScanCacheData, emptyCache, isValidCache } from './cache';
import { CLAUDE_OPTIMIZE_PRESETS, DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT, DEFAULT_CLAUDE_CONTEXT_WINDOW, ClaudeContextSettingKey, ClaudeOptimizeBackup, ClaudeOptimizeBackupV2, ClaudeOptimizeValues, LegacyClaudeOptimizeBackup, adoptClaudeOptimizeBackupV2, applyClaudeOptimizeJson, captureClaudeOptimizeBackup, claudeAutoCompactTokenLimit, matchingClaudeOptimizePreset, normalizeClaudeAutoCompactPercent, normalizeClaudeTokenLimit, parseClaudeAutoCompactPercent, parseClaudeTokenLimit, planClaudeContextDefaultMigration, restoreClaudeOptimizeJson, restoreClaudeOptimizeV2Json, restoreLegacyClaudeOptimizeJson, upgradeLegacyClaudeOptimizeBackup } from './claudeOptimize';
import { CODEX_OPTIMIZE_PRESETS, DEFAULT_CODEX_AUTO_COMPACT_LIMIT, DEFAULT_CODEX_CONTEXT_WINDOW, CodexContextSettingKey, CodexOptimizeValues, applyCodexOptimizeToml, matchingCodexOptimizePreset, normalizeCodexTokenLimit, parseCodexTokenLimit, planCodexContextDefaultMigration, removeCodexOptimizeToml, suggestedCodexAutoCompactLimit } from './codexOptimize';
import { CODEX_EXTENSION_ID, syncCodexMaxReasoningEffort } from './codexModelFeatures';
import { HOOK_RUNNER_FILE, HookFeatureSettings, applyHookFeaturesJson } from './hookFeatures';
import { HookToggleQueue, HookToggleRequest, hookToggleProgressMessage, hookToggleSuccessMessage, hookToggleSyncFailureMessage, hookToggleUnsavedMessage } from './hookToggle';
import { ScanTargets, scanAll } from './engine';
import { FastModeState, claudeFastActive, codexFastModeEnabled, isValidFastModeState, newlyActiveFastProviders } from './fastMode';
import { writeFileAtomic, writeTextFileIfChanged } from './coordination/atomicFile';
import { allowInPlaceCommit } from './coordination/inPlaceCommit';
import { HEARTBEAT_MS, LeaderLock } from './coordination/leaderLock';
import { alertSnoozePathFor, readAlertSnooze, writeAlertSnooze } from './coordination/alertSnooze';
import { FENCED_CACHE_PREFIX, fencedCacheGroupPrefix, fencedCacheKey, makeFencedCacheRecord, readFencedCacheRecord } from './coordination/fencedCache';
import { groupKey, lockPathFor, snapshotPathFor } from './coordination/group';
import { SNAPSHOT_VERSION, SharedSnapshot, readFencedSnapshot, writeFencedSnapshot } from './coordination/sharedSnapshot';
import { ScanIndex } from './scanner/scanIndex';
import { ProviderView, RtkView, StatusBarMode, clipboardText, cycleStatusBarView, detectSubscriptionMode, formatCost, formatTokenLimit, limitWindowLabel, statusBarText, tooltipMarkdown } from './formatter';
import { unscannedRemoteLabel } from './remoteHost';
import { I18n } from './i18n';
import { ProviderLimits, effectiveLimits, fetchClaudeLimits, readCodexLimits, recentCodexFiles } from './limits';
import { Period, dayKey, startOfMonth } from './period';
import { PricingOverrides } from './pricing';
import { RtkStats, fetchRtkStats } from './rtk';
import { SettingsStore } from './settingsStore';
import { TelemetryConfig, TelemetryMetric, exportTelemetry } from './telemetry';
import { DayBuckets, Provider } from './types';

const CACHE_KEY = 'otakUsage.scanCache';
const DAILY_ALERT_STATE_KEY = 'otakUsage.dailyAlertState';
const LIMIT_ALERT_STATE_KEY = 'otakUsage.limitAlertState';
const CODEX_OPTIMIZE_APPLIED_KEY = 'otakUsage.codexOptimizeApplied';
const CLAUDE_OPTIMIZE_OWNERSHIP_KEY = 'otakUsage.claudeOptimizeOwnership';
const BASE_STATUS_BAR_MODE_KEY = 'otakUsage.baseStatusBarMode';
const STATUS_BAR_MODE_INITIALIZED_KEY = 'otakUsage.statusBarModeInitialized';
const CODEX_CONTEXT_DEFAULT_MIGRATION_KEY = 'otakUsage.codexContextDefaultMigration';
const CLAUDE_CONTEXT_DEFAULT_MIGRATION_KEY = 'otakUsage.claudeContextDefaultMigration';
/**
 * Bumped every time the shipped context defaults move, so each installation
 * runs the migration once per move. Generation 1 was the boolean-flagged move
 * off 272k/250k; an installation that ran it records nothing here and is picked
 * up by the `0` fallback below.
 */
const CONTEXT_DEFAULT_MIGRATION_GENERATION = 2;
const FAST_MODE_STATE_KEY = 'otakUsage.fastModeState';
/** Remote kinds already told about, so the placement hint is stated once each. */
const REMOTE_HOST_HINT_KEY = 'otakUsage.remoteHostHintShown';
/** Marketplace id, used to install this extension on the remote side. */
const EXTENSION_ID = 'odangoo.otak-usage';
const CLAUDE_FAST_OPTIMIZE_MIGRATED_KEY = 'otakUsage.claudeFastOptimizeMigrated';
const CODEX_FAST_OPTIMIZE_MIGRATED_KEY = 'otakUsage.codexFastOptimizeMigrated';

interface ResolvedTargets extends ScanTargets {
    claudeAvailable: boolean;
    codexAvailable: boolean;
}

interface CodexOptimizeQuickPickItem extends vscode.QuickPickItem {
    values?: CodexOptimizeValues;
    custom?: boolean;
    disable?: boolean;
}

interface ClaudeOptimizeQuickPickItem extends vscode.QuickPickItem {
    values?: ClaudeOptimizeValues;
    custom?: boolean;
    disable?: boolean;
}

interface ClaudeOptimizeOwnership {
    version: 3;
    phase: 'applying' | 'applied' | 'removing';
    filePresent: boolean;
    backup: ClaudeOptimizeBackup;
}

/** Ownership taken while only the trigger percentage was managed. */
interface ClaudeOptimizeOwnershipV2 {
    version: 2;
    phase: 'applying' | 'applied' | 'removing';
    filePresent: boolean;
    backup: ClaudeOptimizeBackupV2;
}

interface LegacyClaudeOptimizeOwnership {
    version: 1;
    phase: 'applying' | 'applied' | 'removing';
    filePresent: boolean;
    backup: LegacyClaudeOptimizeBackup;
}

type AnyClaudeOptimizeOwnership = ClaudeOptimizeOwnership | ClaudeOptimizeOwnershipV2 | LegacyClaudeOptimizeOwnership;

/** Bring a stored backup of any age up to the format this version restores. */
function currentClaudeOptimizeBackup(ownership: AnyClaudeOptimizeOwnership, settingsText: string): ClaudeOptimizeBackup {
    switch (ownership.backup.version) {
        case 1:
            return upgradeLegacyClaudeOptimizeBackup(ownership.backup);
        case 2:
            return adoptClaudeOptimizeBackupV2(settingsText, ownership.backup);
        default:
            return ownership.backup;
    }
}

type HookFeatureSettingKey = 'includeRepositoryNameInHistory' | 'enableHookSounds';

class UsageController implements vscode.Disposable {
    private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private timer: NodeJS.Timeout | undefined;
    private cache: ScanCacheData = emptyCache();
    /** Directory listings and stat backoff, kept across ticks; see scanIndex.ts. */
    private scanIndex = new ScanIndex();
    private scanning = false;
    /** Identifies this window in the lock file; regenerated on every activation. */
    private readonly instanceId = randomUUID();
    /** Where the lock and snapshot live; empty when coordination is unavailable. */
    private storageDir = '';
    private lock: LeaderLock | undefined;
    private lockGroup = '';
    private snapshotPath = '';
    /** Scanning, network calls, alerts and telemetry belong to the leader alone. */
    private leader = false;
    private roleTimer: NodeJS.Timeout | undefined;
    private roleQueue: Promise<void> = Promise.resolve();
    /** Day buckets published by the leader; what a follower renders from. */
    private sharedDays: DayBuckets = {};
    private lastPublished = '';
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
    private limitAlertState: LimitAlertState | undefined;
    /** Epoch ms until which every alert stays quiet; 0 when none is set. */
    private snoozeUntilMs = 0;
    private updatingClaudeOptimizeConfiguration = false;
    private updatingCodexOptimizeConfiguration = false;
    private updatingHookFeatureConfiguration = false;
    /** User clicks are serialized and retain their intended parity while queued. */
    private readonly hookToggleQueue = new HookToggleQueue<HookFeatureSettingKey>();
    /** Only the newest click may replace its immediate progress message. */
    private latestHookFeedbackRevision = 0;
    /** Claude settings.json is shared by context optimization and hooks. */
    private claudeConfigSyncQueue: Promise<void> = Promise.resolve();
    /** All Codex config.toml rewrites share one queue so transforms cannot race. */
    private codexConfigSyncQueue: Promise<void> = Promise.resolve();
    /** The Codex extension's hidden model-feature state has its own queue. */
    private codexModelFeatureSyncQueue: Promise<void> = Promise.resolve();
    private codexModelFeatureSyncWarned = false;
    private readonly i18n = new I18n(vscode.env.language);
    /**
     * Name of the remote this window is attached to while the extension itself
     * runs locally — undefined whenever the logs being read are the ones the
     * user is actually producing. See remoteHost.ts.
     */
    private readonly unscannedRemote = unscannedRemoteLabel({
        remoteName: vscode.env.remoteName,
        local: vscode.extensions.getExtension(EXTENSION_ID)?.extensionKind === vscode.ExtensionKind.UI,
    });
    /**
     * Settings this extension writes itself. Goes through a store so a write
     * VS Code refuses — the window still shows a status-bar item whose
     * manifest is already gone — degrades to an in-memory value instead of an
     * error thrown at whoever clicked. See settingsStore.ts.
     */
    private readonly settings = new SettingsStore(
        {
            get: <T>(key: string, fallback: T) => this.config().get<T>(key, fallback),
            update: async (key: string, value: unknown) => {
                await this.config().update(key, value, vscode.ConfigurationTarget.Global);
            },
        },
        (key: string, err: unknown) => this.onSettingWriteFailed(key, err),
    );
    /** One warning per window is enough; the cause survives until a reload. */
    private settingWriteWarned = false;
    /** Settings already reported as unwritable; keeps a retry loop out of the log. */
    private readonly settingWriteFailuresLogged = new Set<string>();
    /**
     * Set when the user picks a status-bar view in this window, whether or not
     * the pick could be saved. Distinguishes their choice from the value the
     * first-run subscription default failed to write.
     */
    private statusBarModeChosen = false;

    constructor(private readonly context: vscode.ExtensionContext) { }

    start(): void {
        this.statusBarItem.command = 'otak-usage.cycleStatusBarView';
        this.context.subscriptions.push(this.statusBarItem);
        this.loadCache();
        this.loadDailyAlertState();
        this.loadLimitAlertState();
        this.statusBarItem.text = '$(loading~spin) usage';
        this.statusBarItem.show();
        this.context.subscriptions.push(
            vscode.commands.registerCommand('otak-usage.togglePeriod', () => this.togglePeriod()),
            vscode.commands.registerCommand('otak-usage.cycleStatusBarView', () => this.cycleStatusBarView()),
            vscode.commands.registerCommand('otak-usage.refresh', () => this.refresh()),
            vscode.commands.registerCommand('otak-usage.copyUsage', () => this.copyUsage()),
            vscode.commands.registerCommand('otak-usage.configureCodexOptimization', () => this.configureContextOptimization()),
            vscode.commands.registerCommand('otak-usage.toggleRepositoryNameHook', () => this.toggleRepositoryNameHook()),
            vscode.commands.registerCommand('otak-usage.toggleHookSounds', () => this.toggleHookSounds()),
            vscode.commands.registerCommand('otak-usage.snoozeAlertsToday', () => this.toggleAlertSnooze()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('otakUsage')) {
                    // A real settings change always beats a value this window
                    // could only keep in memory.
                    this.settings.reconcile((key) => e.affectsConfiguration(`otakUsage.${key}`));
                    this.restartTimer();
                    void this.renderAndCheckAlert();
                }
                // Only the leader reconciles the provider config files, so N
                // windows reacting to one global setting change do not write
                // the same two files at the same moment.
                if (e.affectsConfiguration('otakUsage.optimizeCodexContext') ||
                    e.affectsConfiguration('otakUsage.codexContextWindow') ||
                    e.affectsConfiguration('otakUsage.codexAutoCompactLimit') ||
                    e.affectsConfiguration('otakUsage.codexHome')) {
                    if (!this.updatingCodexOptimizeConfiguration && this.leader) {
                        void this.syncCodexOptimize();
                    }
                }
                if (e.affectsConfiguration('otakUsage.optimizeClaudeContext') ||
                    e.affectsConfiguration('otakUsage.claudeContextWindow') ||
                    e.affectsConfiguration('otakUsage.claudeAutoCompactPercent') ||
                    e.affectsConfiguration('otakUsage.claudeConfigDir')) {
                    if (!this.updatingClaudeOptimizeConfiguration && this.leader) {
                        void this.syncClaudeOptimize();
                    }
                }
                if (e.affectsConfiguration('otakUsage.includeRepositoryNameInHistory') ||
                    e.affectsConfiguration('otakUsage.enableHookSounds') ||
                    e.affectsConfiguration('otakUsage.claudeConfigDir') ||
                    e.affectsConfiguration('otakUsage.codexHome')) {
                    // An explicit toggle owns its reconciliation and feedback.
                    // Skipping its echo event prevents a silent first sync from
                    // consuming the change before the command can acknowledge it.
                    if (!this.updatingHookFeatureConfiguration && this.leader) {
                        void this.syncHookFeatures();
                    }
                }
            }),
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused !== this.focused) {
                    this.focused = state.focused;
                    this.restartTimer();
                }
            }),
            // Re-render so the tooltip's inline brand marks pick up the new
            // theme's foreground colour (data-URI images can't use currentColor).
            vscode.window.onDidChangeActiveColorTheme(() => this.render()),
            vscode.extensions.onDidChange(() => {
                if (this.leader) {
                    void this.syncCodexModelFeatures();
                }
            }),
        );
        void this.startCoordination();
        void this.warnAboutUnscannedRemote();
        this.restartTimer();
    }

    /**
     * Say once that this window is counting the local machine rather than the
     * remote it is attached to. The condition is permanent — it holds until the
     * extension is installed on the remote side — so repeating it every
     * activation would be nagging about something the user has already decided;
     * the tooltip carries it from then on.
     *
     * Deliberately not routed through `showAlertNotification`: `alertMode` and
     * the snooze govern *usage* alerts, and a window reading the wrong host is
     * a setup problem that silencing today's cost alerts should not hide.
     */
    private async warnAboutUnscannedRemote(): Promise<void> {
        const remote = this.unscannedRemote;
        if (!remote) {
            return;
        }
        try {
            const raw = this.context.globalState.get<unknown>(REMOTE_HOST_HINT_KEY);
            const shown = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
            if (shown.includes(remote)) {
                return;
            }
            // Recorded before the popup, not after: a notification the user
            // waves away without answering has still been said.
            await this.context.globalState.update(REMOTE_HOST_HINT_KEY, [...shown, remote]);
            const install = this.i18n.t('action.installOnRemote', { remote });
            const selected = await vscode.window.showWarningMessage(this.i18n.t('alert.scanningLocalHost', { remote }), install);
            if (selected === install) {
                await this.installOnRemote();
            }
        } catch (err) {
            console.error('otak-usage: could not report the extension host placement', err);
        }
    }

    /**
     * VS Code installs an extension on whichever side its `extensionKind`
     * prefers, and otak-usage prefers `workspace` — so in a remote window this
     * lands it on the remote. `installExtension` is not part of the documented
     * command set, so a failure falls back to opening the extension's page,
     * where the same install button lives.
     */
    private async installOnRemote(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
            return;
        } catch (err) {
            console.error('otak-usage: could not install on the remote', err);
        }
        try {
            await vscode.commands.executeCommand('extension.open', EXTENSION_ID);
        } catch (err) {
            console.error('otak-usage: could not open the extension page', err);
        }
    }

    dispose(): void {
        this.stopTimer();
        if (this.roleTimer) {
            clearInterval(this.roleTimer);
            this.roleTimer = undefined;
        }
        // Hand the lock over now instead of making the next window wait out the
        // lease; a window that is killed outright is covered by the lease.
        this.lock?.releaseSync();
        this.statusBarItem.dispose();
    }

    /**
     * Every VS Code window activates this extension, but the logs they would
     * read are the same files: one window scans and publishes, the rest render
     * what it published. Coordination happens through `globalStorageUri`, which
     * is one real directory per user shared by every window of the installation
     * — on Windows, macOS, Linux, WSL, SSH remotes and Codespaces alike (in a
     * remote, the extension host lives on the remote side, so the windows
     * attached to it share that side's storage).
     *
     * If that directory cannot be created there is nothing to coordinate
     * through, so the window keeps the old behaviour and scans for itself.
     */
    private async startCoordination(): Promise<void> {
        // Before any window can reconcile config.toml or settings.json, so the
        // leader's activation sync already writes the migrated values.
        await this.migrateContextDefaults();
        try {
            const dir = this.context.globalStorageUri.fsPath;
            await fsp.mkdir(dir, { recursive: true });
            this.storageDir = dir;
        } catch (err) {
            console.error('otak-usage: global storage unavailable; scanning without a leader', err);
        }
        this.roleTimer = setInterval(() => void this.pollRole(), HEARTBEAT_MS);
        await this.tick();
    }

    /**
     * Renew the lease (or pick it up when the holder is gone) on its own timer,
     * so heartbeats keep flowing while a long scan is in progress and a window
     * that inherits the role starts working without waiting for its next tick.
     */
    private async pollRole(): Promise<void> {
        const wasLeader = this.leader;
        try {
            await this.ensureRole(Date.now());
        } catch (err) {
            console.error('otak-usage: leader heartbeat failed', err);
            return;
        }
        if (this.leader && !wasLeader) {
            await this.tick();
        }
    }

    coordinationState(): CoordinationState {
        return this.storageDir === ''
            ? { leader: this.leader }
            : {
                leader: this.leader,
                lockPath: lockPathFor(this.storageDir, this.lockGroup),
                snapshotPath: this.snapshotPath,
            };
    }

    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('otakUsage');
    }

    /**
     * The caveat that belongs on every rendering of these numbers while the
     * window reads a different machine than the user is working on; undefined
     * when it reads the right one.
     */
    private hostWarning(): string | undefined {
        return this.unscannedRemote === undefined
            ? undefined
            : this.i18n.t('tooltip.scanningLocalHost', { remote: this.unscannedRemote });
    }

    private period(): Period {
        return this.settings.get<Period>('period', 'today');
    }

    /**
     * A refused settings write is not the user's fault and not worth an error
     * dialog: the view already changed from the in-memory value, and reloading
     * the window is what actually fixes it.
     */
    private onSettingWriteFailed(key: string, err: unknown): void {
        if (!this.settingWriteFailuresLogged.has(key)) {
            this.settingWriteFailuresLogged.add(key);
            console.error(`otak-usage: could not save otakUsage.${key}`, err);
        }
        if (this.settingWriteWarned) {
            return;
        }
        this.settingWriteWarned = true;
        // Not "reload the window": a reload fixes a lost manifest, but the same
        // rejection covers a broken settings.json, which it would not.
        vscode.window.setStatusBarMessage('otak-usage: view not saved. See Developer Tools for details.', 5000);
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

    private codexHomeDir(): string {
        return firstNonEmpty(this.config().get<string>('codexHome'), process.env.CODEX_HOME)
            ?? path.join(os.homedir(), '.codex');
    }

    private claudeConfigDir(): string {
        return firstNonEmpty(this.config().get<string>('claudeConfigDir'), process.env.CLAUDE_CONFIG_DIR)
            ?? path.join(os.homedir(), '.claude');
    }

    private currentClaudeOptimizeValues(config = this.config()): ClaudeOptimizeValues {
        return {
            contextWindow: normalizeClaudeTokenLimit(config.get<unknown>('claudeContextWindow'), DEFAULT_CLAUDE_CONTEXT_WINDOW),
            autoCompactPercent: normalizeClaudeAutoCompactPercent(config.get<unknown>('claudeAutoCompactPercent'), DEFAULT_CLAUDE_AUTO_COMPACT_PERCENT),
        };
    }

    private async configureContextOptimization(): Promise<void> {
        const config = this.config();
        const claudeValues = this.currentClaudeOptimizeValues(config);
        const codexValues = this.currentCodexOptimizeValues(config);
        const selected = await vscode.window.showQuickPick([
            {
                label: '$(otak-claude) Claude Code',
                description: config.get<boolean>('optimizeClaudeContext', true)
                    ? `On · ${formatTokenLimit(claudeValues.contextWindow)} → ${formatTokenLimit(claudeAutoCompactTokenLimit(claudeValues))}`
                    : 'Off',
                detail: 'Configure the effective auto-compaction window and trigger percentage.',
                provider: 'claude' as const,
            },
            {
                label: '$(otak-openai) Codex CLI',
                description: config.get<boolean>('optimizeCodexContext', true)
                    ? `On · ${formatTokenLimit(codexValues.contextWindow)} → ${formatTokenLimit(codexValues.autoCompactLimit)}`
                    : 'Off',
                detail: 'Configure model_context_window and model_auto_compact_token_limit.',
                provider: 'codex' as const,
            },
        ], {
            title: this.i18n.t('tooltip.optimize'),
            placeHolder: 'Choose a provider to configure, customize, or turn off.',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (selected?.provider === 'claude') {
            await this.configureClaudeOptimization();
        } else if (selected?.provider === 'codex') {
            await this.configureCodexOptimization();
        }
    }

    private async configureClaudeOptimization(): Promise<void> {
        const config = this.config();
        const current = this.currentClaudeOptimizeValues(config);
        const optimizeEnabled = config.get<boolean>('optimizeClaudeContext', true);
        const currentPreset = optimizeEnabled ? matchingClaudeOptimizePreset(current) : undefined;
        const items: ClaudeOptimizeQuickPickItem[] = CLAUDE_OPTIMIZE_PRESETS.map((preset) => ({
            label: `${currentPreset?.id === preset.id ? '$(check) ' : ''}${preset.id}`,
            description: `${formatTokenLimit(preset.contextWindow)} → ${formatTokenLimit(claudeAutoCompactTokenLimit(preset))} (${preset.autoCompactPercent}%)`,
            detail: `CLAUDE_CODE_AUTO_COMPACT_WINDOW ${preset.contextWindow.toLocaleString('en-US')} · CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ${preset.autoCompactPercent}`,
            values: preset,
        }));
        items.push(
            {
                label: `${optimizeEnabled && !currentPreset ? '$(check) ' : ''}$(edit) Custom…`,
                description: `${formatTokenLimit(current.contextWindow)} → ${formatTokenLimit(claudeAutoCompactTokenLimit(current))} (${current.autoCompactPercent}%)`,
                detail: 'Enter any positive context window and an auto-compaction percentage from 1 to 100.',
                custom: true,
            },
            {
                label: `${!optimizeEnabled ? '$(check) ' : ''}$(circle-slash) Turn Off`,
                description: 'Restore the values that existed before otak-usage enabled optimization.',
                disable: true,
            },
        );

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Claude Code Context Optimization',
            placeHolder: `${formatTokenLimit(current.contextWindow)} → ${formatTokenLimit(claudeAutoCompactTokenLimit(current))} (${current.autoCompactPercent}%)`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) {
            return;
        }
        if (selected.disable) {
            this.updatingClaudeOptimizeConfiguration = true;
            try {
                await config.update('optimizeClaudeContext', false, vscode.ConfigurationTarget.Global);
            } catch (err) {
                console.error('otak-usage: failed to save Claude optimize settings', err);
                void vscode.window.showErrorMessage('otak-usage: failed to turn off Claude Code context optimization. See Developer Tools for details.');
                return;
            } finally {
                this.updatingClaudeOptimizeConfiguration = false;
            }
            const removed = await this.syncClaudeOptimize(false, false);
            if (removed) {
                vscode.window.setStatusBarMessage('otak-usage: turned off Claude Code context optimization and restored its previous settings', 5000);
                void this.renderAndCheckAlert();
            } else {
                void vscode.window.showErrorMessage('otak-usage: failed to turn off Claude Code context optimization. See Developer Tools for details.');
            }
            return;
        }

        let values = selected.values;
        if (selected.custom) {
            const contextInput = await vscode.window.showInputBox({
                title: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
                prompt: 'Effective context window in tokens (> 0)',
                value: String(current.contextWindow),
                validateInput: (value) => parseClaudeTokenLimit(value) === undefined ? 'Enter a positive integer.' : undefined,
            });
            if (contextInput === undefined) {
                return;
            }
            const contextWindow = parseClaudeTokenLimit(contextInput);
            if (contextWindow === undefined) {
                return;
            }
            const percentInput = await vscode.window.showInputBox({
                title: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
                prompt: 'Auto-compaction trigger percentage (1–100)',
                value: String(current.autoCompactPercent),
                validateInput: (value) => parseClaudeAutoCompactPercent(value) === undefined ? 'Enter an integer from 1 to 100.' : undefined,
            });
            if (percentInput === undefined) {
                return;
            }
            const autoCompactPercent = parseClaudeAutoCompactPercent(percentInput);
            if (autoCompactPercent === undefined) {
                return;
            }
            values = { contextWindow, autoCompactPercent };
        }
        if (!values) {
            return;
        }

        this.updatingClaudeOptimizeConfiguration = true;
        try {
            await config.update('claudeContextWindow', values.contextWindow, vscode.ConfigurationTarget.Global);
            await config.update('claudeAutoCompactPercent', values.autoCompactPercent, vscode.ConfigurationTarget.Global);
            await config.update('optimizeClaudeContext', true, vscode.ConfigurationTarget.Global);
        } catch (err) {
            console.error('otak-usage: failed to save Claude optimize settings', err);
            await this.syncClaudeOptimize(false, false);
            void vscode.window.showErrorMessage('otak-usage: failed to save Claude Code context optimization settings. See Developer Tools for details.');
            return;
        } finally {
            this.updatingClaudeOptimizeConfiguration = false;
        }

        const applied = await this.syncClaudeOptimize(false, false);
        if (applied) {
            vscode.window.setStatusBarMessage(
                `otak-usage: applied Claude Code context optimization: ${formatTokenLimit(values.contextWindow)} → ${formatTokenLimit(claudeAutoCompactTokenLimit(values))} (${values.autoCompactPercent}%)`,
                5000,
            );
            void this.renderAndCheckAlert();
        } else {
            void vscode.window.showErrorMessage('otak-usage: failed to apply Claude Code context optimization. See Developer Tools for details.');
        }
    }

    /**
     * Reconciles both providers' context settings with the defaults this
     * version ships, once per default move. Changing the shipped values on
     * their own would never reach an installation whose settings already hold
     * the old numbers, and would quietly change what a half-configured pair
     * means. See `planCodexContextDefaultMigration` and
     * `planClaudeContextDefaultMigration` for the rules; this only carries the
     * plans out and records that they ran.
     *
     * The two sides are flagged separately, so a write VS Code refuses leaves
     * that provider's flag behind and the next activation retries it alone
     * rather than half-migrating the user for good.
     */
    private async migrateContextDefaults(): Promise<void> {
        await this.migrateCodexContextDefaults();
        await this.migrateClaudeContextDefaults();
    }

    private async migrateCodexContextDefaults(): Promise<void> {
        if (this.context.globalState.get<number>(CODEX_CONTEXT_DEFAULT_MIGRATION_KEY, 0) >= CONTEXT_DEFAULT_MIGRATION_GENERATION) {
            return;
        }
        const config = this.config();
        const plan = planCodexContextDefaultMigration(
            config.inspect<number>('codexContextWindow')?.globalValue,
            config.inspect<number>('codexAutoCompactLimit')?.globalValue,
        );
        try {
            for (const key of plan.clear) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
            for (const [key, value] of Object.entries(plan.write) as [CodexContextSettingKey, number][]) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
            }
        } catch (err) {
            console.error('otak-usage: could not migrate the Codex context defaults', err);
            return;
        }
        await this.context.globalState.update(CODEX_CONTEXT_DEFAULT_MIGRATION_KEY, CONTEXT_DEFAULT_MIGRATION_GENERATION);
    }

    private async migrateClaudeContextDefaults(): Promise<void> {
        if (this.context.globalState.get<number>(CLAUDE_CONTEXT_DEFAULT_MIGRATION_KEY, 0) >= CONTEXT_DEFAULT_MIGRATION_GENERATION) {
            return;
        }
        const config = this.config();
        const plan = planClaudeContextDefaultMigration(
            config.inspect<number>('claudeContextWindow')?.globalValue,
            config.inspect<number>('claudeAutoCompactPercent')?.globalValue,
        );
        try {
            for (const key of plan.clear) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
            for (const [key, value] of Object.entries(plan.write) as [ClaudeContextSettingKey, number][]) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
            }
        } catch (err) {
            console.error('otak-usage: could not migrate the Claude context defaults', err);
            return;
        }
        await this.context.globalState.update(CLAUDE_CONTEXT_DEFAULT_MIGRATION_KEY, CONTEXT_DEFAULT_MIGRATION_GENERATION);
    }

    private currentCodexOptimizeValues(config = this.config()): CodexOptimizeValues {
        return {
            contextWindow: normalizeCodexTokenLimit(config.get<unknown>('codexContextWindow'), DEFAULT_CODEX_CONTEXT_WINDOW),
            autoCompactLimit: normalizeCodexTokenLimit(config.get<unknown>('codexAutoCompactLimit'), DEFAULT_CODEX_AUTO_COMPACT_LIMIT),
        };
    }

    private async configureCodexOptimization(): Promise<void> {
        const config = this.config();
        const current = this.currentCodexOptimizeValues(config);
        const optimizeEnabled = config.get<boolean>('optimizeCodexContext', true);
        const currentPreset = optimizeEnabled
            ? matchingCodexOptimizePreset(current.contextWindow, current.autoCompactLimit)
            : undefined;
        const items: CodexOptimizeQuickPickItem[] = CODEX_OPTIMIZE_PRESETS.map((preset) => ({
            label: `${currentPreset?.id === preset.id ? '$(check) ' : ''}${preset.id}`,
            description: `${formatTokenLimit(preset.contextWindow)} → ${formatTokenLimit(preset.autoCompactLimit)}`,
            detail: `model_context_window ${preset.contextWindow.toLocaleString('en-US')} · model_auto_compact_token_limit ${preset.autoCompactLimit.toLocaleString('en-US')}`,
            values: preset,
        }));
        items.push(
            {
                label: `${optimizeEnabled && !currentPreset ? '$(check) ' : ''}$(edit) Custom…`,
                description: `${formatTokenLimit(current.contextWindow)} → ${formatTokenLimit(current.autoCompactLimit)}`,
                detail: 'Enter model_context_window and model_auto_compact_token_limit',
                custom: true,
            },
            {
                label: `${!optimizeEnabled ? '$(check) ' : ''}$(circle-slash) Turn Off`,
                description: 'Remove the two context optimization keys from Codex config.toml.',
                disable: true,
            },
        );

        const selected = await vscode.window.showQuickPick(items, {
            title: this.i18n.t('tooltip.optimize'),
            placeHolder: `${this.i18n.t('tooltip.optimizeTitle')} · ${formatTokenLimit(current.contextWindow)} → ${formatTokenLimit(current.autoCompactLimit)}`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) {
            return;
        }
        if (selected.disable) {
            this.updatingCodexOptimizeConfiguration = true;
            try {
                await config.update('optimizeCodexContext', false, vscode.ConfigurationTarget.Global);
            } catch (err) {
                console.error('otak-usage: failed to save Codex optimize settings', err);
                void vscode.window.showErrorMessage('otak-usage: failed to turn off Codex context optimization. See Developer Tools for details.');
                return;
            } finally {
                this.updatingCodexOptimizeConfiguration = false;
            }
            const removed = await this.syncCodexOptimize(false, false);
            if (removed) {
                vscode.window.setStatusBarMessage(this.i18n.t('message.codexOptimizeRemoved'), 5000);
                void this.renderAndCheckAlert();
            } else {
                void vscode.window.showErrorMessage('otak-usage: failed to turn off Codex context optimization. See Developer Tools for details.');
            }
            return;
        }

        let values = selected.values;
        if (selected.custom) {
            const contextInput = await vscode.window.showInputBox({
                title: 'model_context_window',
                prompt: 'Token limit (> 0)',
                value: String(current.contextWindow),
                validateInput: (value) => parseCodexTokenLimit(value) === undefined ? 'Enter a positive integer.' : undefined,
            });
            if (contextInput === undefined) {
                return;
            }
            const contextWindow = parseCodexTokenLimit(contextInput);
            if (contextWindow === undefined) {
                return;
            }
            const suggested = current.autoCompactLimit < contextWindow
                ? current.autoCompactLimit
                : suggestedCodexAutoCompactLimit(contextWindow);
            const compactInput = await vscode.window.showInputBox({
                title: 'model_auto_compact_token_limit',
                prompt: `Token limit (1–${(contextWindow - 1).toLocaleString('en-US')})`,
                value: String(suggested),
                validateInput: (value) => {
                    const parsed = parseCodexTokenLimit(value);
                    return parsed === undefined || parsed >= contextWindow
                        ? `Enter a positive integer below ${contextWindow.toLocaleString('en-US')}.`
                        : undefined;
                },
            });
            if (compactInput === undefined) {
                return;
            }
            const autoCompactLimit = parseCodexTokenLimit(compactInput);
            if (autoCompactLimit === undefined || autoCompactLimit >= contextWindow) {
                return;
            }
            values = { contextWindow, autoCompactLimit };
        }
        if (!values) {
            return;
        }

        this.updatingCodexOptimizeConfiguration = true;
        try {
            await config.update('codexContextWindow', values.contextWindow, vscode.ConfigurationTarget.Global);
            await config.update('codexAutoCompactLimit', values.autoCompactLimit, vscode.ConfigurationTarget.Global);
            await config.update('optimizeCodexContext', true, vscode.ConfigurationTarget.Global);
        } catch (err) {
            console.error('otak-usage: failed to save Codex optimize settings', err);
            // Reconcile whatever configuration state VS Code did persist, so a
            // partially failed multi-key update cannot leave config.toml owned
            // by an older in-flight write.
            await this.syncCodexOptimize(false, false);
            void vscode.window.showErrorMessage('otak-usage: failed to save Codex context optimization settings. See Developer Tools for details.');
            return;
        } finally {
            this.updatingCodexOptimizeConfiguration = false;
        }

        const applied = await this.syncCodexOptimize(false, false);
        if (applied) {
            vscode.window.setStatusBarMessage(
                `${this.i18n.t('message.codexOptimizeApplied')}: ${formatTokenLimit(values.contextWindow)} → ${formatTokenLimit(values.autoCompactLimit)}`,
                5000,
            );
            void this.renderAndCheckAlert();
        } else {
            void vscode.window.showErrorMessage('otak-usage: failed to apply Codex context optimization. See Developer Tools for details.');
        }
    }

    /** Queue Claude settings writes so activation and VS Code configuration
     * events cannot race each other. Every branch either reaches an applied/off
     * terminal state or leaves an ownership phase that the next sync can retry.
     */
    private syncClaudeOptimize(showStatus = true, requireFence = true): Promise<boolean> {
        const task = this.claudeConfigSyncQueue.then(() => this.performClaudeOptimizeSync(showStatus, requireFence));
        this.claudeConfigSyncQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    private async allowManagedFileCommit(requireFence: boolean): Promise<boolean> {
        if (!requireFence) {
            return true;
        }
        if (!this.lock) {
            return allowInPlaceCommit({ requireFence: true, isLeader: this.leader });
        }
        return this.confirmLeadership();
    }

    private async performClaudeOptimizeSync(showStatus: boolean, requireFence: boolean): Promise<boolean> {
        if (!(await this.allowManagedFileCommit(requireFence))) {
            return false;
        }
        const config = this.config();
        const desired = config.get<boolean>('optimizeClaudeContext', true);
        const rawOwnership = this.context.globalState.get<unknown>(CLAUDE_OPTIMIZE_OWNERSHIP_KEY);
        if (rawOwnership !== undefined && !isClaudeOptimizeOwnership(rawOwnership)) {
            console.error('otak-usage: invalid Claude optimize ownership state; refusing to modify settings.json');
            if (showStatus) {
                void vscode.window.showErrorMessage('otak-usage: Claude Code context optimization state is invalid. settings.json was not modified.');
            }
            return false;
        }
        let ownership = rawOwnership as AnyClaudeOptimizeOwnership | undefined;
        if (!desired && !ownership) {
            return true;
        }

        const configPath = path.join(this.claudeConfigDir(), 'settings.json');
        try {
            if (desired) {
                const current = await readOptionalTextFile(configPath);
                // Older ownership is brought up to the current format first. v2
                // never managed the window, so whatever the file holds now is
                // the user's own value and must be captured before this version
                // writes one — and captured only once, which the persist below
                // guarantees even if the host stops mid-way.
                const owned: ClaudeOptimizeOwnership = ownership
                    ? {
                        version: 3,
                        phase: 'applying',
                        filePresent: ownership.filePresent,
                        backup: currentClaudeOptimizeBackup(ownership, current ?? ''),
                    }
                    : {
                        version: 3,
                        phase: 'applying',
                        filePresent: current !== undefined,
                        backup: captureClaudeOptimizeBackup(current ?? ''),
                    };
                // Persist ownership before touching settings.json. If the host
                // stops after the file write, the original values remain known.
                ownership = owned;
                await this.context.globalState.update(CLAUDE_OPTIMIZE_OWNERSHIP_KEY, ownership);
                const values = this.currentClaudeOptimizeValues(config);
                if (!(await this.allowManagedFileCommit(requireFence))) {
                    return false;
                }
                const changed = await writeTransformedTextFile(
                    configPath,
                    this.instanceId,
                    current,
                    applyClaudeOptimizeJson(current ?? '', values),
                );
                ownership = { ...owned, phase: 'applied' };
                await this.context.globalState.update(CLAUDE_OPTIMIZE_OWNERSHIP_KEY, ownership);
                if (changed && showStatus) {
                    vscode.window.setStatusBarMessage('otak-usage: applied Claude Code context optimization to settings.json', 4000);
                }
            } else {
                ownership = { ...ownership!, phase: 'removing' };
                await this.context.globalState.update(CLAUDE_OPTIMIZE_OWNERSHIP_KEY, ownership);
                const current = await readOptionalTextFile(configPath);
                if (current !== undefined) {
                    const restored = ownership.backup.version === 1
                        ? restoreLegacyClaudeOptimizeJson(current, ownership.backup)
                        : ownership.backup.version === 2
                            ? restoreClaudeOptimizeV2Json(current, ownership.backup)
                            : restoreClaudeOptimizeJson(current, ownership.backup);
                    if (!ownership.filePresent && jsonObjectIsEmpty(restored)) {
                        if (!(await this.allowManagedFileCommit(requireFence))) {
                            return false;
                        }
                        await fsp.unlink(configPath).catch((err: unknown) => {
                            if (!isNodeError(err, 'ENOENT')) {
                                throw err;
                            }
                        });
                    } else {
                        if (!(await this.allowManagedFileCommit(requireFence))) {
                            return false;
                        }
                        await writeTransformedTextFile(configPath, this.instanceId, current, restored);
                    }
                }
                await this.context.globalState.update(CLAUDE_OPTIMIZE_OWNERSHIP_KEY, undefined);
                if (showStatus) {
                    vscode.window.setStatusBarMessage('otak-usage: removed Claude Code context optimization and restored previous settings', 4000);
                }
            }
            return true;
        } catch (err) {
            console.error('otak-usage: Claude optimize sync failed', err);
            if (showStatus) {
                void vscode.window.showErrorMessage('otak-usage: failed to update Claude Code settings.json; the file was left unchanged when validation failed. See Developer Tools for details.');
            }
            return false;
        }
    }

    /**
     * Reconcile `~/.codex/config.toml` with the optimize toggle. When enabled,
     * pin the two managed keys to the configured values; when it is turned off
     * (a previously-applied → off transition), remove them again. Leaves the
     * file untouched while the toggle is and stays off, so a user's own manual
     * values are never removed unless they opted in first.
     */
    private syncCodexOptimize(showStatus = true, requireFence = true): Promise<boolean> {
        return this.enqueueCodexConfigSync(() => this.performCodexOptimizeSync(showStatus, requireFence));
    }

    /**
     * Add only Max to Codex's VS Code model-feature state. The Codex extension
     * has no public setting API, so the helper uses a feature-detected memento
     * bridge and fails closed when that private VS Code detail is unavailable.
     */
    private syncCodexModelFeatures(): Promise<boolean> {
        const task = this.codexModelFeatureSyncQueue.then(() => this.performCodexModelFeatureSync());
        this.codexModelFeatureSyncQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    private async performCodexModelFeatureSync(): Promise<boolean> {
        const codex = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
        if (!codex) {
            return true;
        }
        const version = typeof codex.packageJSON?.version === 'string' ? codex.packageJSON.version : '0.0.0';
        const result = await syncCodexMaxReasoningEffort(this.context.globalState, version);
        if (result === 'updated') {
            if (codex.isActive) {
                await this.refreshCodexWebviews();
            }
            return true;
        }
        if (result === 'already-enabled') {
            return true;
        }
        if (!this.codexModelFeatureSyncWarned) {
            this.codexModelFeatureSyncWarned = true;
            console.warn('otak-usage: could not enable Codex Max automatically (' + result + ')');
        }
        return false;
    }

    /** Re-request persisted atoms in an already-open Codex webview. */
    private async refreshCodexWebviews(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        } catch (err) {
            console.warn('otak-usage: Codex Max was saved, but existing webviews could not be refreshed', err);
        }
    }

    /** Serialize all transforms that write the shared Codex config.toml. */
    private enqueueCodexConfigSync(taskFactory: () => Promise<boolean>): Promise<boolean> {
        const task = this.codexConfigSyncQueue.then(taskFactory);
        this.codexConfigSyncQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    /** Serialize hooks with Claude's settings.json context-optimization writes. */
    private syncHookFeatures(requireFence = true): Promise<boolean> {
        const task = this.claudeConfigSyncQueue.then(() => this.performHookFeaturesSync(requireFence));
        this.claudeConfigSyncQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    private hookFeatureSettings(): HookFeatureSettings {
        return {
            // Read through SettingsStore so a temporary VS Code settings-registry
            // rejection still updates the tooltip and generated hook files.
            repositoryName: this.settings.get<boolean>('includeRepositoryNameInHistory', false),
            sounds: this.settings.get<boolean>('enableHookSounds', false),
        };
    }

    /** The next tooltip shows the latest click even while its write is queued. */
    private hookFeatureViewSettings(): HookFeatureSettings {
        const current = this.hookFeatureSettings();
        return {
            repositoryName: this.hookToggleQueue.value('includeRepositoryNameInHistory', current.repositoryName),
            sounds: this.hookToggleQueue.value('enableHookSounds', current.sounds),
        };
    }

    private hookRunnerPath(): string {
        return path.join(os.homedir(), '.otak-usage', 'hooks', HOOK_RUNNER_FILE);
    }

    private async installHookRunner(): Promise<string> {
        const source = path.join(this.context.extensionPath, 'out', 'hookRunner.js');
        const target = this.hookRunnerPath();
        const runner = await fsp.readFile(source, 'utf8');
        const current = await readOptionalTextFile(target);
        if (current !== runner) {
            await writeFileAtomic(target, this.instanceId, runner);
        }
        return target;
    }

    private async performHookFeaturesSync(requireFence: boolean): Promise<boolean> {
        if (!(await this.allowManagedFileCommit(requireFence))) {
            return false;
        }
        const settings = this.hookFeatureSettings();
        try {
            const runnerPath = settings.repositoryName || settings.sounds ? await this.installHookRunner() : this.hookRunnerPath();
            const files: Array<[string, 'claude' | 'codex']> = [
                [path.join(this.claudeConfigDir(), 'settings.json'), 'claude'],
                [path.join(this.codexHomeDir(), 'hooks.json'), 'codex'],
            ];
            for (const [filePath, provider] of files) {
                const current = await readOptionalTextFile(filePath);
                if (current === undefined && !settings.repositoryName && !settings.sounds) {
                    continue;
                }
                const next = applyHookFeaturesJson(current ?? '', provider, runnerPath, settings);
                if (!(await this.allowManagedFileCommit(requireFence))) {
                    return false;
                }
                await writeTransformedTextFile(filePath, this.instanceId, current, next);
            }
            return true;
        } catch (err) {
            console.error('otak-usage: hook feature sync failed', err);
            return false;
        }
    }

    private toggleRepositoryNameHook(): Promise<void> {
        return this.toggleHookFeature('includeRepositoryNameInHistory', 'repository names');
    }

    private toggleHookSounds(): Promise<void> {
        return this.toggleHookFeature('enableHookSounds', 'hook sounds');
    }

    private toggleHookFeature(key: HookFeatureSettingKey, label: string): Promise<void> {
        const request = this.hookToggleQueue.enqueue(
            key,
            this.settings.get<boolean>(key, false),
            (queued) => this.applyHookFeatureToggle(queued, label),
            () => this.render(),
        );
        this.latestHookFeedbackRevision = request.revision;

        // Updating the backing Markdown only affects the next hover. This
        // status message is the immediate acknowledgement for the current one.
        this.render();
        const progress = vscode.window.setStatusBarMessage(hookToggleProgressMessage(label, request.enabled));

        return request.completion
            .catch((err: unknown) => {
                console.error(`otak-usage: ${label} toggle failed`, err);
                if (request.revision === this.latestHookFeedbackRevision) {
                    void vscode.window.showErrorMessage(`otak-usage: failed to update ${label}. See Developer Tools for details.`);
                }
            })
            .finally(() => progress.dispose());
    }

    private async applyHookFeatureToggle(request: HookToggleRequest<HookFeatureSettingKey>, label: string): Promise<void> {
        this.updatingHookFeatureConfiguration = true;
        try {
            const saved = await this.settings.set(request.key, request.enabled);

            // Make the next hover accurate before the external files are touched.
            this.render();
            // A newer click on the same feature owns the terminal state and sync.
            if (!this.hookToggleQueue.isLatest(request)) {
                return;
            }

            const synced = this.leader ? await this.syncHookFeatures() : saved;
            if (!this.hookToggleQueue.isLatest(request) || request.revision !== this.latestHookFeedbackRevision) {
                return;
            }

            if (!saved) {
                if (synced) {
                    vscode.window.setStatusBarMessage(hookToggleUnsavedMessage(label, request.enabled), 5000);
                } else {
                    void vscode.window.showErrorMessage(
                        `${hookToggleUnsavedMessage(label, request.enabled)}, and the optional hook files were not updated. Reload the window and try again.`,
                    );
                }
                return;
            }
            if (!synced) {
                void vscode.window.showErrorMessage(hookToggleSyncFailureMessage(label, request.enabled));
                return;
            }
            // Confirm every successful click, including an idempotent file sync.
            vscode.window.setStatusBarMessage(hookToggleSuccessMessage(label, request.enabled), 4000);
        } finally {
            this.updatingHookFeatureConfiguration = false;
        }
    }

    private async performCodexOptimizeSync(showStatus: boolean, requireFence: boolean): Promise<boolean> {
        if (!(await this.allowManagedFileCommit(requireFence))) {
            return false;
        }
        const config = this.config();
        const desired = config.get<boolean>('optimizeCodexContext', true);
        const applied = this.context.globalState.get<boolean>(CODEX_OPTIMIZE_APPLIED_KEY, false);
        if (!desired && !applied) {
            return true;
        }
        const configPath = path.join(this.codexHomeDir(), 'config.toml');
        try {
            if (desired) {
                const values = this.currentCodexOptimizeValues(config);
                if (!(await this.allowManagedFileCommit(requireFence))) {
                    return false;
                }
                const changed = await this.rewriteCodexConfig(configPath, (text) => applyCodexOptimizeToml(text, values), true);
                await this.context.globalState.update(CODEX_OPTIMIZE_APPLIED_KEY, true);
                if (changed && showStatus) {
                    vscode.window.setStatusBarMessage(this.i18n.t('message.codexOptimizeApplied'), 4000);
                }
            } else {
                if (!(await this.allowManagedFileCommit(requireFence))) {
                    return false;
                }
                const changed = await this.rewriteCodexConfig(configPath, (text) => removeCodexOptimizeToml(text), false);
                await this.context.globalState.update(CODEX_OPTIMIZE_APPLIED_KEY, false);
                if (changed && showStatus) {
                    vscode.window.setStatusBarMessage(this.i18n.t('message.codexOptimizeRemoved'), 4000);
                }
            }
            return true;
        } catch (err) {
            console.error('otak-usage: codex optimize sync failed', err);
            return false;
        }
    }

    /**
     * Read the config, transform it, and write it back only when the content
     * actually changes. When `createIfMissing` is false a missing file is a
     * no-op (nothing to remove).
     */
    private async rewriteCodexConfig(configPath: string, transform: (text: string) => string, createIfMissing: boolean): Promise<boolean> {
        let current: string | undefined;
        try {
            current = await fsp.readFile(configPath, 'utf8');
        } catch {
            current = undefined;
        }
        if (current === undefined && !createIfMissing) {
            return false;
        }
        const next = transform(current ?? '');
        if (next === current) {
            return false;
        }
        return writeTransformedTextFile(configPath, this.instanceId, current, next);
    }

    /** Serialize role changes: the scan tick and the heartbeat both drive them. */
    private ensureRole(nowMs: number): Promise<void> {
        const task = this.roleQueue.then(() => this.updateRole(nowMs));
        this.roleQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    private async updateRole(nowMs: number): Promise<void> {
        if (this.storageDir === '') {
            this.setLeader(true); // no shared directory: this window is on its own
            return;
        }
        // The lock covers one set of provider directories. A window pointed at
        // a different claudeConfigDir / codexHome must not follow a snapshot
        // built from logs it is not looking at, so it elects its own leader.
        const key = groupKey(this.claudeConfigDir(), this.codexHomeDir());
        if (key !== this.lockGroup) {
            await this.lock?.release().catch(() => undefined);
            this.lockGroup = key;
            this.snapshotPath = snapshotPathFor(this.storageDir, key);
            this.lock = new LeaderLock(lockPathFor(this.storageDir, key), this.instanceId);
            this.setLeader(false);
        }
        try {
            const lock = this.lock!;
            this.setLeader(this.leader ? await lock.renew(nowMs) : await lock.acquire(nowMs));
        } catch (err) {
            // The lock file itself is unwritable — a read-only or full storage
            // directory. Coordinating is impossible, so fall back to what every
            // window did before: scan for itself.
            console.error('otak-usage: leader lock unusable; scanning without a leader', err);
            this.lock = undefined;
            this.storageDir = '';
            this.setLeader(true);
        }
    }

    private setLeader(next: boolean): void {
        if (next === this.leader) {
            return;
        }
        this.leader = next;
        if (next) {
            // A follower keeps no file offsets, so its in-memory cache cannot
            // be scanned forward — every line would be counted a second time.
            // Restart from the persisted cache, whose offsets and day buckets
            // were written together and therefore still agree.
            this.cache = emptyCache();
            this.loadCache();
            this.scanIndex.reset();
            this.lastPublished = '';
            this.initialScanDone = Object.keys(this.cache.days).length > 0;
            // Activation-time reconciliation of the provider config files is
            // the leader's job, and this window has just taken it on.
            void this.syncClaudeOptimize();
            void this.syncCodexOptimize();
            void this.syncCodexModelFeatures();
            void this.syncHookFeatures();
        } else {
            // Keep showing the numbers we already had until the first snapshot
            // arrives, instead of blinking through an empty status bar.
            this.sharedDays = this.cache.days;
        }
    }

    private async tick(): Promise<void> {
        if (this.scanning) {
            return;
        }
        this.scanning = true;
        try {
            const now = Date.now();
            await this.ensureRole(now);
            if (this.leader) {
                await this.leaderTick(now);
            } else {
                await this.followerTick();
            }
        } catch (err) {
            console.error('otak-usage: scan failed', err);
        } finally {
            this.scanning = false;
        }
    }

    private async leaderTick(now: number): Promise<void> {
        const targets = await this.resolveTargets();
        this.lastTargets = targets;
        const changed = await scanAll(this.cache, targets, now, this.scanIndex);
        this.initialScanDone = true;
        if (!(await this.confirmLeadership())) {
            return;
        }
        if (changed && !(await this.saveCache())) {
            return;
        }
        await this.renderAndCheckAlert();
        await this.checkFastMode(now);
        void this.refreshRtkStats(dayKey(now));
        void this.refreshLimits(now);
        void this.exportTelemetry(now);
    }

    /**
     * Render the leader's snapshot. No filesystem walk, no usage endpoint call,
     * no `rtk` child process, no telemetry export and no alert — those happen
     * once per machine, in the leader.
     */
    private async followerTick(): Promise<void> {
        const lock = this.lock;
        const current = await lock?.readCurrent();
        if (!lock || !current || current.released) {
            return;
        }
        const fence = { epoch: current.epoch, leaseToken: current.leaseToken, holder: current.holder };
        const snapshot = await readFencedSnapshot(this.snapshotPath, fence);
        const after = await lock.readCurrent();
        if (!snapshot || !after || after.released ||
            after.epoch !== fence.epoch || after.leaseToken !== fence.leaseToken || after.holder !== fence.holder) {
            return; // leader has not published yet; keep the current display
        }
        this.sharedDays = snapshot.days;
        this.lastTargets = {
            claudeDir: this.claudeConfigDir(),
            codexHome: this.codexHomeDir(),
            claudeAvailable: snapshot.claudeAvailable,
            codexAvailable: snapshot.codexAvailable,
        };
        this.lastClaudeLimits = snapshot.claudeLimits;
        this.lastCodexLimits = snapshot.codexLimits;
        this.lastRtkStats = snapshot.rtk;
        this.initialScanDone = true;
        this.render();
    }

    /** Publish what the other windows need, skipping writes that change nothing. */
    private async publishSnapshot(): Promise<void> {
        const lock = this.lock;
        const fence = lock?.fence;
        if (!this.leader || !lock || !fence || !this.initialScanDone || this.snapshotPath === '') {
            return;
        }
        const snapshot: SharedSnapshot = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: Date.now(),
            leader: this.instanceId,
            days: this.cache.days,
            claudeAvailable: this.lastTargets.claudeAvailable,
            codexAvailable: this.lastTargets.codexAvailable,
            claudeLimits: this.lastClaudeLimits,
            codexLimits: this.lastCodexLimits,
            rtk: this.lastRtkStats,
            fence,
        };
        // updatedAtMs moves every time; compare everything else so an idle
        // machine stops rewriting the file (and the followers stop re-rendering).
        const payload = JSON.stringify({ ...snapshot, updatedAtMs: 0 });
        if (payload === this.lastPublished) {
            return;
        }
        try {
            const committed = await writeFencedSnapshot(
                this.snapshotPath,
                `${process.pid}`,
                snapshot,
                fence,
                () => lock.isCurrent(),
            );
            if (committed) {
                this.lastPublished = payload;
            } else {
                this.setLeader(false);
            }
        } catch (err) {
            console.error('otak-usage: publishing the usage snapshot failed', err);
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

    /**
     * Claude limits come from a network endpoint that rate-limits eagerly
     * (observed 429s at once-a-minute polling alongside Claude Code's own
     * /usage calls) — poll at most every 5 minutes; the last snapshot is
     * kept on failure.
     */
    private static readonly CLAUDE_LIMITS_MIN_INTERVAL_MS = 300_000;

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
                codexHome
                    ? readCodexLimits(codexHome, nowMs, recentCodexFiles(this.cache.files, codexHome, nowMs))
                    : Promise.resolve(undefined),
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
            || inspected?.workspaceFolderValue !== undefined
            // A choice this window could not persist still counts as a choice.
            || this.statusBarModeChosen;
        if (userChose || !config.get<boolean>('showRateLimits', true)) {
            await this.context.globalState.update(STATUS_BAR_MODE_INITIALIZED_KEY, true);
            return;
        }
        const mode = detectSubscriptionMode(this.lastClaudeLimits, this.lastCodexLimits);
        if (!mode) {
            return; // no plan proven yet — try again on a later refresh
        }
        if (!await this.settings.set('statusBarMode', mode)) {
            return; // nothing persisted — try again once settings are writable
        }
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
        // Costs are recomputed per window: pricingOverrides is a per-window
        // setting, so the leader publishes token counts and never prices for
        // anyone but itself.
        const summaries = summarize(this.leader ? this.cache.days : this.sharedDays, today, overrides);
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
        const statusBarMode = showLimits ? this.settings.get<StatusBarMode>('statusBarMode', 'cost') : 'cost';
        this.statusBarItem.text = statusBarText(claude, codex, period, false, statusBarMode);
        const claudeOptimizeValues = this.currentClaudeOptimizeValues(config);
        const codexOptimizeValues = this.currentCodexOptimizeValues(config);
        const tooltip = new vscode.MarkdownString(tooltipMarkdown(
            claude,
            codex,
            rtk,
            period,
            new Date(now),
            this.i18n,
            tooltipIconColor(),
            {
                claude: {
                    enabled: config.get<boolean>('optimizeClaudeContext', true),
                    contextWindow: claudeOptimizeValues.contextWindow,
                    autoCompactLimit: claudeAutoCompactTokenLimit(claudeOptimizeValues),
                },
                codex: {
                    enabled: config.get<boolean>('optimizeCodexContext', true),
                    ...codexOptimizeValues,
                },
            },
            this.hostWarning(),
            this.hookFeatureViewSettings(),
        ));
        tooltip.supportThemeIcons = true;
        tooltip.supportHtml = true; // provider icons use inline data-URI images

        tooltip.isTrusted = { enabledCommands: ['otak-usage.copyUsage', 'otak-usage.configureCodexOptimization', 'workbench.action.openSettings', 'otak-usage.toggleRepositoryNameHook', 'otak-usage.toggleHookSounds'] };
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
        // Everything a follower renders is settled by the time we render it
        // ourselves — including the limits and rtk refreshes, which land after
        // their own tick and re-render.
        void this.publishSnapshot();
        return { day: today, todayTotalCost: summaries.claude.todayCost + summaries.codex.todayCost };
    }

    private async renderAndCheckAlert(): Promise<void> {
        const snapshot = this.render();
        // One notification per machine rather than one per open window: only
        // the leader — the window that owns the numbers — raises alerts.
        if (snapshot && this.leader) {
            await this.checkAlerts(snapshot.day, snapshot.todayTotalCost);
        }
    }

    private async checkAlerts(day: string, todayTotalCost: number): Promise<void> {
        const config = this.config();
        const mode: AlertMode = normalizeAlertMode(config.get<unknown>('alertMode'));
        if (mode === 'off') {
            return;
        }
        // Ask before evaluating, not after: leaving the "already notified"
        // records untouched is what lets an alert the user silenced today come
        // back tomorrow, which is what "not today" promises.
        if (await this.alertsSnoozed(Date.now())) {
            return;
        }
        if (alertModeIncludesCost(mode)) {
            await this.checkDailyAlert(config, day, todayTotalCost);
        }
        if (alertModeIncludesLimit(mode)) {
            await this.checkLimitAlert(config);
        }
    }

    private async checkDailyAlert(config: vscode.WorkspaceConfiguration, day: string, todayTotalCost: number): Promise<void> {
        const threshold = normalizeDailyAlertThresholdUsd(config.get<unknown>('dailyAlertThresholdUsd'));
        const decision = evaluateDailyAlert(todayTotalCost, threshold, day, this.dailyAlertState);
        if (!sameDailyAlertState(this.dailyAlertState, decision.nextState)) {
            this.dailyAlertState = decision.nextState;
            await this.context.globalState.update(DAILY_ALERT_STATE_KEY, decision.nextState);
        }
        if (!decision.shouldNotify) {
            return;
        }

        const message = this.i18n.t('alert.dailyCostExceeded', {
            total: formatCost(todayTotalCost),
            threshold: formatCost(threshold),
        });
        void this.showAlertNotification(message, 'otakUsage.dailyAlertThresholdUsd').catch((err) => {
            console.error('otak-usage: daily alert notification failed', err);
        });
    }

    private async checkLimitAlert(config: vscode.WorkspaceConfiguration): Promise<void> {
        const threshold = normalizeLimitAlertThresholdPercent(config.get<unknown>('limitAlertThresholdPercent'));
        const windows = this.buildLimitAlertWindows();
        const decision = evaluateLimitAlert(windows, threshold, this.limitAlertState);
        if (!sameLimitAlertState(this.limitAlertState, decision.nextState)) {
            this.limitAlertState = decision.nextState;
            await this.context.globalState.update(LIMIT_ALERT_STATE_KEY, decision.nextState);
        }
        for (const w of decision.triggered) {
            const message = this.i18n.t('alert.limitExceeded', {
                provider: w.provider,
                window: w.window,
                pct: String(Math.round(w.usedPercent)),
                threshold: String(Math.round(threshold)),
            });
            void this.showAlertNotification(message, 'otakUsage.limitAlertThresholdPercent').catch((err) => {
                console.error('otak-usage: limit alert notification failed', err);
            });
        }
    }

    /** Rate-limit windows the user currently sees, as alert candidates. */
    private buildLimitAlertWindows(): LimitAlertWindow[] {
        const views = this.lastViews;
        if (!views) {
            return [];
        }
        const windows: LimitAlertWindow[] = [];
        const add = (provider: string, prefix: string, view: ProviderView): void => {
            if (!view.show || !view.limits) {
                return;
            }
            for (const [key, fallback, window] of [
                ['primary', '5h', view.limits.primary],
                ['secondary', '7d', view.limits.secondary],
            ] as const) {
                if (window) {
                    windows.push({
                        id: `${prefix}:${key}`,
                        provider,
                        window: limitWindowLabel(window, fallback),
                        usedPercent: window.usedPercent,
                        resetsAtMs: window.resetsAtMs,
                    });
                }
            }
        };
        add('Claude', 'claude', views.claude);
        add('Codex', 'codex', views.codex);
        return windows;
    }

    private async showAlertNotification(message: string, settingKey: string): Promise<void> {
        const openSettings = this.i18n.t('action.openSettings');
        const notToday = this.i18n.t('action.notToday');
        const selected = await vscode.window.showWarningMessage(message, openSettings, notToday);
        if (selected === openSettings) {
            await vscode.commands.executeCommand('workbench.action.openSettings', settingKey);
        } else if (selected === notToday) {
            await this.setAlertSnooze(snoozeUntilEndOfDay(Date.now()));
            vscode.window.setStatusBarMessage(this.i18n.t('message.alertsSnoozed'), 5000);
        }
    }

    /**
     * Detect fast mode per provider and warn on every off → on transition with
     * the same notification the cost and limit alerts use, "Not Today" button
     * included. Claude Code keeps no config flag
     * this extension could read — fast mode surfaces as "<model>-fast" usage in
     * today's scan buckets, so its warning fires on the first fast-billed
     * response of a day. Codex CLI declares `fast_mode` in config.toml, so its
     * warning fires as soon as the flag appears. Leader-only (called from the
     * leader tick): one notification per machine, like every other alert.
     */
    private async checkFastMode(now: number): Promise<void> {
        try {
            const codexConfig = await readOptionalTextFile(path.join(this.codexHomeDir(), 'config.toml'));
            const current: FastModeState = {
                claude: claudeFastActive(this.cache.days, dayKey(now)),
                codex: codexFastModeEnabled(codexConfig ?? ''),
            };
            const rawPrevious = this.context.globalState.get<unknown>(FAST_MODE_STATE_KEY);
            const previous = isValidFastModeState(rawPrevious) ? rawPrevious : undefined;
            for (const provider of newlyActiveFastProviders(current, previous)) {
                // The migration is not an alert, so it runs even while alerts
                // are snoozed or off — only the popup respects those.
                const migrated = await this.migrateFastModeOptimize(provider);
                const mode = normalizeAlertMode(this.config().get<unknown>('alertMode'));
                if (mode === 'off' || await this.alertsSnoozed(now)) {
                    continue;
                }
                let message = this.i18n.t('alert.fastModeDetected', {
                    provider: provider === 'claude' ? 'Claude Code' : 'Codex CLI',
                });
                if (migrated) {
                    message += ` ${this.i18n.t('alert.fastModeOptimized')}`;
                }
                void this.showAlertNotification(message, 'otakUsage.alertMode').catch((err) => {
                    console.error('otak-usage: could not show the fast mode alert', err);
                });
            }
            if (!previous || previous.claude !== current.claude || previous.codex !== current.codex) {
                await this.context.globalState.update(FAST_MODE_STATE_KEY, current);
            }
        } catch (err) {
            console.error('otak-usage: fast mode check failed', err);
        }
    }

    /**
     * One-time per provider: the first time fast mode is seen while that
     * provider's context optimization is turned off, turn it back on. Fast
     * mode bills at premium per-token rates, so a compact context is worth
     * more than the earlier opt-out. It runs exactly once — turning the
     * optimization off again afterwards is final. A failed write leaves the
     * flag unset, so the next detection retries instead of half-migrating.
     * Returns whether the optimization was actually (re-)enabled.
     */
    private async migrateFastModeOptimize(provider: Provider): Promise<boolean> {
        const flagKey = provider === 'claude' ? CLAUDE_FAST_OPTIMIZE_MIGRATED_KEY : CODEX_FAST_OPTIMIZE_MIGRATED_KEY;
        if (this.context.globalState.get<boolean>(flagKey, false)) {
            return false;
        }
        const settingKey = provider === 'claude' ? 'optimizeClaudeContext' : 'optimizeCodexContext';
        const config = this.config();
        if (config.get<boolean>(settingKey, true)) {
            // Already optimized — nothing to migrate; record that so a later
            // opt-out is never overridden.
            await this.context.globalState.update(flagKey, true);
            return false;
        }
        if (provider === 'claude') {
            this.updatingClaudeOptimizeConfiguration = true;
        } else {
            this.updatingCodexOptimizeConfiguration = true;
        }
        try {
            await config.update(settingKey, true, vscode.ConfigurationTarget.Global);
        } catch (err) {
            console.error(`otak-usage: could not migrate ${provider} context optimization for fast mode`, err);
            return false;
        } finally {
            if (provider === 'claude') {
                this.updatingClaudeOptimizeConfiguration = false;
            } else {
                this.updatingCodexOptimizeConfiguration = false;
            }
        }
        const applied = provider === 'claude'
            ? await this.syncClaudeOptimize(false)
            : await this.syncCodexOptimize(false);
        if (!applied) {
            return false;
        }
        await this.context.globalState.update(flagKey, true);
        void this.renderAndCheckAlert();
        return true;
    }

    /**
     * Whether alerts are currently silenced. Reads the shared file rather than
     * trusting `snoozeUntilMs`, because the window asking is whichever one holds
     * the leader lock right now and the user may have asked for quiet in another
     * one. It is one small read per leader tick, next to a scan that stats every
     * session log — and the in-memory copy still covers the window whose global
     * storage never came up.
     */
    private async alertsSnoozed(nowMs: number): Promise<boolean> {
        const filePath = this.alertSnoozePath();
        if (filePath !== '') {
            this.snoozeUntilMs = (await readAlertSnooze(filePath))?.untilMs ?? 0;
        }
        return isSnoozed({ untilMs: this.snoozeUntilMs }, nowMs);
    }

    /** Command: silence alerts for the rest of the day, or lift it again. */
    private async toggleAlertSnooze(): Promise<void> {
        const now = Date.now();
        const snoozed = await this.alertsSnoozed(now);
        await this.setAlertSnooze(snoozed ? 0 : snoozeUntilEndOfDay(now));
        vscode.window.setStatusBarMessage(this.i18n.t(snoozed ? 'message.alertsResumed' : 'message.alertsSnoozed'), 5000);
    }

    private async setAlertSnooze(untilMs: number): Promise<void> {
        this.snoozeUntilMs = untilMs;
        const filePath = this.alertSnoozePath();
        if (filePath === '') {
            return; // no shared directory: this window silences only itself
        }
        try {
            await writeAlertSnooze(filePath, `${process.pid}`, { untilMs });
        } catch (err) {
            console.error('otak-usage: could not record the alert snooze', err);
        }
    }

    private alertSnoozePath(): string {
        return this.storageDir === '' ? '' : alertSnoozePathFor(this.storageDir);
    }

    private async copyUsage(): Promise<void> {
        if (!this.lastViews) {
            return;
        }
        await vscode.env.clipboard.writeText(clipboardText(this.lastViews.claude, this.lastViews.codex, this.lastViews.rtk, new Date(), this.hostWarning()));
        vscode.window.setStatusBarMessage(this.i18n.t('message.summaryCopied'), 3000);
    }

    private async togglePeriod(): Promise<void> {
        const next: Period = this.period() === 'today' ? 'month' : 'today';
        await this.settings.set('period', next);
        void this.renderAndCheckAlert();
    }

    /** Status-bar click: today's cost → this month's cost → limits → today's cost. */
    private async cycleStatusBarView(): Promise<void> {
        const config = this.config();
        const mode = this.settings.get<StatusBarMode>('statusBarMode', 'cost');
        const limitsEnabled = config.get<boolean>('showRateLimits', true);
        const baseMode = this.context.globalState.get<StatusBarMode>(BASE_STATUS_BAR_MODE_KEY, 'cost');
        const next = cycleStatusBarView(this.period(), mode, limitsEnabled, baseMode);
        if (next.mode === 'limits' && mode !== 'limits') {
            // Remember what to restore when the cycle leaves the limits view.
            await this.context.globalState.update(BASE_STATUS_BAR_MODE_KEY, mode);
        }
        if (next.period !== this.period()) {
            await this.settings.set('period', next.period);
        }
        if (next.mode !== mode) {
            this.statusBarModeChosen = true;
            await this.settings.set('statusBarMode', next.mode);
        }
        void this.renderAndCheckAlert();
    }

    private async refresh(): Promise<void> {
        // An explicit refresh should rescan here and now, in the window the
        // user asked in — so take the lock rather than wait for a snapshot the
        // current leader will publish on its own schedule.
        if (this.lock) {
            try {
                await this.ensureRoleSteal();
            } catch (err) {
                console.error('otak-usage: could not take over scanning for a manual refresh', err);
            }
        }
        this.cache = emptyCache();
        this.scanIndex.reset();
        this.initialScanDone = false;
        this.lastPublished = '';
        await this.clearPersistedCaches();
        this.statusBarItem.text = '$(loading~spin) usage';
        await this.tick();
    }

    private ensureRoleSteal(): Promise<void> {
        const task = this.roleQueue.then(async () => {
            const lock = this.lock;
            if (lock) {
                this.setLeader(await lock.steal(Date.now()));
            }
        });
        this.roleQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    private loadCache(): void {
        const fence = this.lock?.fence;
        if (fence && this.lockGroup !== '') {
            const candidates = [fence, this.lock?.predecessorFence].filter(candidate => candidate !== undefined);
            for (const candidate of candidates) {
                const raw = this.context.globalState.get<unknown>(fencedCacheKey(this.lockGroup, candidate));
                const cached = readFencedCacheRecord(raw, this.lockGroup, candidate);
                if (cached) {
                    this.cache = cached;
                    return;
                }
            }
            // One-time migration from the pre-fencing cache. It is accepted
            // only when no current/predecessor artifact exists, then removed
            // immediately after the first fenced save.
            const legacy = this.context.globalState.get<unknown>(CACHE_KEY);
            if (isValidCache(legacy)) {
                this.cache = legacy;
            }
            return;
        }
        const raw = this.context.globalState.get<unknown>(CACHE_KEY);
        if (isValidCache(raw)) {
            this.cache = raw;
        }
    }

    private loadDailyAlertState(): void {
        const raw = this.context.globalState.get<unknown>(DAILY_ALERT_STATE_KEY);
        this.dailyAlertState = isValidDailyAlertState(raw) ? raw : undefined;
    }

    private loadLimitAlertState(): void {
        const raw = this.context.globalState.get<unknown>(LIMIT_ALERT_STATE_KEY);
        this.limitAlertState = isValidLimitAlertState(raw) ? raw : undefined;
    }

    private async confirmLeadership(): Promise<boolean> {
        if (!this.lock) {
            return this.leader;
        }
        if (this.leader && await this.lock.isCurrent()) {
            return true;
        }
        this.setLeader(false);
        return false;
    }

    private async saveCache(): Promise<boolean> {
        const lock = this.lock;
        const fence = lock?.fence;
        if (!lock || !fence || this.lockGroup === '') {
            await this.context.globalState.update(CACHE_KEY, this.cache);
            return true;
        }
        if (!(await lock.isCurrent())) {
            this.setLeader(false);
            return false;
        }
        const key = fencedCacheKey(this.lockGroup, fence);
        await this.context.globalState.update(key, makeFencedCacheRecord(this.lockGroup, fence, this.cache));
        if (!(await lock.isCurrent())) {
            // This key is unique to the stale lease, so cleanup cannot delete a
            // successor's cache. A crash here is still safe: future readers use
            // only their exact current/predecessor fencing identity.
            await this.context.globalState.update(key, undefined);
            this.setLeader(false);
            return false;
        }
        const groupPrefix = fencedCacheGroupPrefix(this.lockGroup);
        const oldKeys = this.context.globalState.keys().filter(candidate =>
            candidate.startsWith(groupPrefix) && candidate !== key && cacheEpoch(candidate) < fence.epoch,
        );
        await Promise.all(oldKeys.map(candidate => this.context.globalState.update(candidate, undefined)));
        await this.context.globalState.update(CACHE_KEY, undefined);
        return true;
    }

    private async clearPersistedCaches(): Promise<void> {
        const keys = this.context.globalState.keys().filter(key => key === CACHE_KEY || key.startsWith(`${FENCED_CACHE_PREFIX}.`));
        await Promise.all(keys.map(key => this.context.globalState.update(key, undefined)));
    }
}

/**
 * Foreground colour for the tooltip's inline brand marks, tracking the active
 * theme (data-URI SVG images can't inherit `currentColor` like codicons do).
 */
function tooltipIconColor(): string {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    return dark ? '#cccccc' : '#3b3b3b';
}

function cacheEpoch(key: string): number {
    const parts = key.split('.');
    const value = Number(parts.at(-2));
    return Number.isSafeInteger(value) && value >= 1 ? value : Number.POSITIVE_INFINITY;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaudeOptimizeOwnership(value: unknown): value is AnyClaudeOptimizeOwnership {
    if (!isRecord(value) || ![1, 2, 3].includes(Number(value.version)) || typeof value.filePresent !== 'boolean' ||
        !['applying', 'applied', 'removing'].includes(String(value.phase)) || !isRecord(value.backup)) {
        return false;
    }
    const backup = value.backup;
    const sharedValid = typeof backup.envPresent === 'boolean' &&
        isRecord(backup.autoCompactPercent) && typeof backup.autoCompactPercent.present === 'boolean';
    if (!sharedValid || backup.version !== value.version) {
        return false;
    }
    // Only v2 left the window unmanaged, so only it may omit that backup entry.
    return value.version === 2 ||
        (isRecord(backup.contextWindow) && typeof backup.contextWindow.present === 'boolean');
}

function isNodeError(err: unknown, code: string): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
    try {
        return await fsp.readFile(filePath, 'utf8');
    } catch (err) {
        if (isNodeError(err, 'ENOENT')) {
            return undefined;
        }
        throw err;
    }
}

async function writeTransformedTextFile(filePath: string, tag: string, current: string | undefined, next: string): Promise<boolean> {
    return writeTextFileIfChanged(filePath, tag, current, next);
}

function jsonObjectIsEmpty(text: string): boolean {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * What this window is doing about scanning. Returned from `activate()` so the
 * integration tests can see the election the user never has to think about;
 * also the quickest way to answer "which window is actually reading the logs?"
 * from the debug console.
 */
export interface CoordinationState {
    leader: boolean;
    lockPath?: string;
    snapshotPath?: string;
}

export interface OtakUsageApi {
    coordination(): CoordinationState;
}

export function activate(context: vscode.ExtensionContext): OtakUsageApi {
    const controller = new UsageController(context);
    context.subscriptions.push(controller);
    controller.start();
    return { coordination: () => controller.coordinationState() };
}

export function deactivate(): void { }
