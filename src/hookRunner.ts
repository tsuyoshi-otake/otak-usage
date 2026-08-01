/**
 * Standalone hook process copied to ~/.otak-usage/hooks by the extension.
 *
 * It intentionally has no VS Code dependency: Claude Code and Codex invoke it
 * from their own process on Windows, macOS, Linux, SSH remotes and Codespaces.
 */

import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type JsonObject = Record<string, any>;

const MAX_TITLE_LENGTH = 120;

function argValue(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => { text += chunk; });
        process.stdin.on('end', () => resolve(text));
    });
}

function eventName(event: JsonObject): string {
    return typeof event.hook_event_name === 'string' ? event.hook_event_name.toLowerCase() : '';
}

function isStop(event: JsonObject): boolean {
    return eventName(event) === 'stop' && event.stop_hook_active !== true;
}

function isPrompt(event: JsonObject): boolean {
    return eventName(event) === 'userpromptsubmit';
}

function expandHome(value: string): string {
    if (value === '~') {
        return os.homedir();
    }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

function runGit(cwd: string, args: string[]): string | undefined {
    const normalized = cwd.startsWith('\\\\?\\') ? cwd.slice(4) : cwd;
    const result = spawnSync('git', ['-C', normalized, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
        return undefined;
    }
    const value = result.stdout.trim();
    return value === '' ? undefined : value;
}

export function repositoryName(cwd: string | undefined): string | undefined {
    if (!cwd || cwd.trim() === '') {
        return undefined;
    }
    const root = runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) {
        return undefined;
    }
    const origin = runGit(root, ['config', '--get', 'remote.origin.url']);
    if (origin) {
        const cleaned = origin.replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
        const name = cleaned.split(/[\\/:]/).pop()?.replace(/\.git$/, '');
        if (name) {
            return name;
        }
    }
    return path.basename(root);
}

function readTail(filePath: string, maxBytes = 128 * 1024): string {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, stat.size - length);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function withFileLock<T>(target: string, callback: () => T): T | undefined {
    const key = createHash('sha1').update(target).digest('hex');
    const lockPath = path.join(os.homedir(), '.otak-usage', 'locks', `${key}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let fd: number | undefined;
    try {
        fd = fs.openSync(lockPath, 'wx');
        return callback();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            return undefined;
        }
        return undefined;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
            fs.unlinkSync(lockPath);
        }
    }
}

function latestClaudeTitle(transcriptPath: string): string | undefined {
    let latestCustom: string | undefined;
    let latestAi: string | undefined;
    for (const line of readTail(transcriptPath).split(/\r?\n/)) {
        try {
            const entry = JSON.parse(line) as JsonObject;
            if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim() !== '') {
                latestCustom = entry.customTitle;
            } else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim() !== '') {
                latestAi = entry.aiTitle;
            }
        } catch {
            // A partial final line is normal while Claude is still writing.
        }
    }
    return latestCustom ?? latestAi;
}

function decorateClaudeTitle(event: JsonObject): void {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    const transcript = typeof event.transcript_path === 'string' ? expandHome(event.transcript_path) : '';
    const repo = repositoryName(typeof event.cwd === 'string' ? event.cwd : undefined);
    if (!sessionId || !transcript || !repo || !fs.existsSync(transcript)) {
        return;
    }
    withFileLock(transcript, () => {
        const prefix = `[${repo}]`;
        const current = latestClaudeTitle(transcript) ?? '';
        if (current === prefix || current.startsWith(`${prefix} `)) {
            return;
        }
        let candidate = current.replace(/\s+/g, ' ').trim();
        if (!candidate) {
            candidate = typeof event.last_assistant_message === 'string'
                ? event.last_assistant_message.replace(/\s+/g, ' ').trim()
                : '';
        }
        if (candidate.length > MAX_TITLE_LENGTH - 3) {
            candidate = `${candidate.slice(0, MAX_TITLE_LENGTH - 6)}...`;
        }
        const title = candidate ? `${prefix} ${candidate}` : prefix;
        const record = { type: 'custom-title', sessionId, customTitle: title };
        fs.appendFileSync(transcript, `${JSON.stringify(record)}${os.EOL}`, 'utf8');
    });
}

function findExecutableOnPath(command: string): string | undefined {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(lookup, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
        return undefined;
    }
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value !== '');
}

function resolveCodexExecutable(): string {
    const configured = process.env.CODEX_CLI_PATH;
    const candidates: string[] = [];
    if (configured) {
        candidates.push(configured);
    }
    if (process.platform === 'win32') {
        if (process.env.APPDATA) {
            candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
        }
        candidates.push(path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex.exe'));
    } else {
        candidates.push(path.join(os.homedir(), '.local', 'bin', 'codex'));
        candidates.push(path.join(os.homedir(), '.npm-global', 'bin', 'codex'));
    }
    candidates.push(process.platform === 'win32' ? 'codex.cmd' : 'codex');
    for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
            return candidate;
        }
        const resolved = findExecutableOnPath(candidate);
        if (resolved) {
            return resolved;
        }
    }
    return candidates[candidates.length - 1];
}

interface JsonLineProcess {
    process: ReturnType<typeof spawn>;
    nextId: number;
    buffer: string;
    messages: JsonObject[];
}

function startCodexAppServer(cwd: string): JsonLineProcess | undefined {
    const executable = resolveCodexExecutable();
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd'),
    });
    const state: JsonLineProcess = { process: child, nextId: 1, buffer: '', messages: [] };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        state.buffer += chunk;
        let newline = state.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = state.buffer.slice(0, newline).trim();
            state.buffer = state.buffer.slice(newline + 1);
            newline = state.buffer.indexOf('\n');
            if (line) {
                try {
                    state.messages.push(JSON.parse(line) as JsonObject);
                } catch {
                    // Ignore server diagnostics that are not JSON-RPC messages.
                }
            }
        }
    });
    child.on('error', () => undefined);
    return state;
}

async function request(state: JsonLineProcess, method: string, params: JsonObject, timeoutMs = 5000): Promise<JsonObject | undefined> {
    const id = state.nextId++;
    state.process.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const index = state.messages.findIndex((message) => String(message.id) === String(id));
        if (index >= 0) {
            return state.messages.splice(index, 1)[0];
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
}

async function decorateCodexTitle(event: JsonObject): Promise<void> {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    const cwd = typeof event.cwd === 'string' ? event.cwd : '';
    const repo = repositoryName(cwd);
    if (!sessionId || !cwd || !repo) {
        return;
    }
    const state = startCodexAppServer(cwd);
    if (!state) {
        return;
    }
    try {
        const clientInfo = { name: 'otak-usage-repository-title-hook', title: 'otak-usage repository title hook', version: '1.0.0' };
        if (!await request(state, 'initialize', { clientInfo })) {
            return;
        }
        state.process.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        const response = await request(state, 'thread/read', { threadId: sessionId, includeTurns: false });
        const thread = response?.result?.thread as JsonObject | undefined;
        if (!thread) {
            return;
        }
        const prefix = `[${repo}]`;
        const current = typeof thread.name === 'string' && thread.name.trim() !== ''
            ? thread.name
            : typeof thread.preview === 'string' ? thread.preview : '';
        if (current === prefix || current.startsWith(`${prefix} `)) {
            return;
        }
        let candidate = current.replace(/\s+/g, ' ').trim();
        if (!candidate && typeof event.last_assistant_message === 'string') {
            candidate = event.last_assistant_message.replace(/\s+/g, ' ').trim();
        }
        if (candidate.length > MAX_TITLE_LENGTH - 3) {
            candidate = `${candidate.slice(0, MAX_TITLE_LENGTH - 6)}...`;
        }
        const name = candidate ? `${prefix} ${candidate}` : prefix;
        await request(state, 'thread/name/set', { threadId: sessionId, name });
    } finally {
        try {
            state.process.stdin?.end();
        } catch {
        }
        if (!state.process.killed) {
            state.process.kill();
        }
    }
}

function wavTone(filePath: string, frequency: number, durationMs: number): void {
    if (fs.existsSync(filePath)) {
        return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const sampleRate = 44100;
    const samples = Math.floor(sampleRate * durationMs / 1000);
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const envelope = Math.min(1, Math.min(i / (sampleRate * 0.01), (samples - i) / (sampleRate * 0.02)));
        data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 14000 * Math.max(0, envelope)), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function soundPath(kind: 'prompt' | 'stop'): string {
    const envKey = kind === 'prompt' ? 'OTAK_USAGE_PROMPT_SOUND' : 'OTAK_USAGE_STOP_SOUND';
    const configured = process.env[envKey];
    if (configured && fs.existsSync(expandHome(configured))) {
        return expandHome(configured);
    }
    const userSound = path.join(os.homedir(), '.claude', 'sounds', `${kind}-chime.wav`);
    if (fs.existsSync(userSound)) {
        return userSound;
    }
    const generated = path.join(os.homedir(), '.otak-usage', 'sounds', `${kind}.wav`);
    wavTone(generated, kind === 'prompt' ? 880 : 660, kind === 'prompt' ? 90 : 180);
    return generated;
}

function playSound(kind: 'prompt' | 'stop'): void {
    const file = soundPath(kind);
    if (process.platform === 'win32') {
        const escaped = file.replace(/'/g, "''");
        spawnSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`], { stdio: 'ignore', windowsHide: true });
        return;
    }
    if (process.platform === 'darwin') {
        if (spawnSync('afplay', [file], { stdio: 'ignore' }).status === 0) {
            return;
        }
        spawnSync('osascript', ['-e', 'beep'], { stdio: 'ignore' });
        return;
    }
    for (const player of [['paplay', [file]], ['aplay', ['-q', file]], ['canberra-gtk-play', ['-f', file]]] as const) {
        if (spawnSync(player[0], player[1], { stdio: 'ignore' }).status === 0) {
            return;
        }
    }
    // A terminal bell is harmless when no audio device/player exists (common
    // in headless Codespaces) and intentionally emits no hook protocol output.
    spawnSync('sh', ['-c', 'printf "\\a"'], { stdio: 'ignore' });
}

async function run(): Promise<void> {
    const provider = argValue('--otak-usage-hook');
    const feature = argValue(provider ?? '---missing-feature');
    if ((provider !== 'claude' && provider !== 'codex') || (feature !== 'repository' && feature !== 'sounds')) {
        return;
    }
    let event: JsonObject;
    try {
        event = JSON.parse(await readStdin()) as JsonObject;
    } catch {
        return;
    }
    if (feature === 'sounds') {
        if (isPrompt(event)) {
            playSound('prompt');
        } else if (isStop(event)) {
            playSound('stop');
        }
    } else if (isStop(event)) {
        if (provider === 'claude') {
            decorateClaudeTitle(event);
        } else {
            await decorateCodexTitle(event);
        }
    }
    process.stdout.write(JSON.stringify({ continue: true }));
}

if (require.main === module) {
    void run().catch(() => {
        // Optional UX hooks must never block or fail a provider turn.
        process.stdout.write(JSON.stringify({ continue: true }));
    });
}
