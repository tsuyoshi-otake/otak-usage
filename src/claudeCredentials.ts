import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type CredentialStatus = 'available' | 'missing' | 'expired' | 'invalid' | 'denied' | 'unavailable';
interface Credentials { accessToken: string; expiresAt?: number; subscriptionType?: string }
export type CredentialResult = { status: 'available'; credentials: Credentials }
    | { status: Exclude<CredentialStatus, 'available'> };
type StoreResult = { status: 'available'; text: string } | { status: 'missing' | 'denied' | 'unavailable' };

/** Claude Code 2.1.62: custom directories append the first eight SHA-256 digits. */
export function claudeKeychainService(directory: string, customDirectory: boolean): string {
    return 'Claude Code-credentials' + (customDirectory
        ? '-' + createHash('sha256').update(directory.normalize('NFC')).digest('hex').slice(0, 8) : '');
}

function readKeychain(service: string, account: string): Promise<StoreResult> {
    return new Promise(resolve => {
        execFile('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', service],
            { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
                // Never expose the error object: it can contain credential output.
                if (!error) { resolve({ status: 'available', text: stdout }); }
                else if (error.code === 44) { resolve({ status: 'missing' }); }
                else if (error.code === 36 || error.code === 128) { resolve({ status: 'denied' }); }
                else { resolve({ status: 'unavailable' }); }
            });
    });
}

export class ClaudeCredentialReader {
    private blocked = new Map<string, StoreResult>();
    private active = new Map<string, Promise<CredentialResult>>();
    constructor(
        private readonly platform = process.platform,
        private readonly keychain = readKeychain,
        private readonly readFile = (file: string) => fsp.readFile(file, 'utf8'),
        private readonly account = process.env.USER || safeUsername(),
    ) {}

    /** Explicit user retry; automatic polling never repeats a denied native lookup. */
    retry(): void { this.blocked.clear(); }

    read(directory: string, nowMs: number, customDirectory = !!process.env.CLAUDE_CONFIG_DIR
        || directory !== path.join(os.homedir(), '.claude')): Promise<CredentialResult> {
        const service = claudeKeychainService(directory, customDirectory);
        const pending = this.active.get(service);
        if (pending) { return pending; }
        const task = this.load(directory, service, nowMs).finally(() => this.active.delete(service));
        this.active.set(service, task);
        return task;
    }

    private async load(directory: string, service: string, nowMs: number): Promise<CredentialResult> {
        let text: string;
        if (this.platform === 'darwin') {
            let result = this.blocked.get(service);
            if (!result) {
                try { result = await this.keychain(service, this.account); }
                catch { result = { status: 'unavailable' }; }
                if (result.status === 'denied' || result.status === 'unavailable') {
                    this.blocked.set(service, result);
                }
            }
            if (result.status === 'available') { return parseCredentials(result.text, nowMs); }
            if (result.status !== 'missing') { return result; }
        }
        try { text = await this.readFile(path.join(directory, '.credentials.json')); }
        catch (error) {
            return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
        }
        return parseCredentials(text, nowMs);
    }
}

function safeUsername(): string {
    try { return os.userInfo().username; } catch { return 'claude-code-user'; }
}

function parseCredentials(text: string, nowMs: number): CredentialResult {
    try {
        const oauth = JSON.parse(text)?.claudeAiOauth;
        if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.trim() === '') {
            return { status: 'invalid' };
        }
        if (oauth.expiresAt !== undefined && (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt))) {
            return { status: 'invalid' };
        }
        if (oauth.expiresAt !== undefined && oauth.expiresAt <= nowMs) { return { status: 'expired' }; }
        return { status: 'available', credentials: {
            accessToken: oauth.accessToken, expiresAt: oauth.expiresAt,
            subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
        } };
    } catch { return { status: 'invalid' }; }
}

export const claudeCredentialReader = new ClaudeCredentialReader();
