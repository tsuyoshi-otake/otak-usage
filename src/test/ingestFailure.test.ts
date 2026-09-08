import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { emptyCache } from '../cache';
import { scanAll } from '../engine';
import { dayKey } from '../period';

suite('transactional ingestion #59', () => {
    for (const provider of ['claude', 'codex'] as const) {
        test(`${provider}: partial failure and persisted retry equal a clean scan`, async () => {
            const now = Date.now();
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ingest-'));
            const date = dayKey(now).split('-');
            const file = path.join(dir, ...(provider === 'claude' ? ['projects', 'p'] : ['sessions', ...date]), 's.jsonl');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const line = (id: number) => JSON.stringify(provider === 'claude'
                ? { type: 'assistant', timestamp: new Date(now + id).toISOString(), requestId: 'r', message: { id: 'm', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: id } } }
                : { type: 'event_msg', timestamp: new Date(now + id).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: id } } } });
            const header = provider === 'codex' ? '{"type":"turn_context","payload":{"model":"gpt-5.5"}}\n' : '';
            const targets = provider === 'claude' ? { claudeDir: dir } : { codexHome: dir };
            const cache = emptyCache();
            fs.writeFileSync(file, header + line(1) + '\n');
            await scanAll(cache, targets, now);
            fs.appendFileSync(file, line(2) + '\n');
            const before = JSON.stringify(cache);
            const native = require('fs') as typeof fs;
            const original = native.createReadStream;
            try {
                native.createReadStream = (() => {
                    let sent = false;
                    return new Readable({ read() {
                        if (sent) { return; }
                        sent = true;
                        this.push(Buffer.from(line(2) + '\n'));
                        setImmediate(() => this.destroy(new Error('injected EIO')));
                    } });
                }) as unknown as typeof fs.createReadStream;
                assert.strictEqual(await scanAll(cache, targets, now + 3), false);
                assert.strictEqual(JSON.stringify(cache), before);
            } finally { native.createReadStream = original; }
            try {
                const recovered = JSON.parse(JSON.stringify(cache));
                await scanAll(recovered, targets, now + 4);
                const clean = emptyCache();
                await scanAll(clean, targets, now + 4);
                assert.deepStrictEqual(recovered.days, clean.days);
                assert.deepStrictEqual(recovered.files, clean.files);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        });
    }
});
