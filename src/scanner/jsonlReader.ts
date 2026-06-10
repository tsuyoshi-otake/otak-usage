import * as fs from 'fs';

export interface ReadResult {
    lines: string[];
    /** Absolute byte offset just past the last complete line that was read. */
    newOffset: number;
}

/**
 * Read complete lines from `offset` to EOF. An incomplete trailing line (no
 * newline yet — the writer may still be appending) is NOT consumed: it is
 * excluded from `lines` and `newOffset` stays before it, so the next read
 * picks it up once the newline arrives. Splitting at the newline byte is
 * UTF-8 safe (0x0A never occurs inside a multi-byte sequence).
 */
export function readNewLines(filePath: string, offset: number): Promise<ReadResult> {
    return new Promise((resolve, reject) => {
        const lines: string[] = [];
        let remainder: Buffer = Buffer.alloc(0);
        let totalRead = 0;
        const stream = fs.createReadStream(filePath, { start: offset });
        stream.on('data', (chunk) => {
            const c = chunk as Buffer;
            totalRead += c.length;
            const buf = remainder.length ? Buffer.concat([remainder, c]) : c;
            const lastNl = buf.lastIndexOf(0x0a);
            if (lastNl === -1) {
                remainder = Buffer.from(buf);
                return;
            }
            for (const line of buf.toString('utf8', 0, lastNl).split('\n')) {
                const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
                if (trimmed) {
                    lines.push(trimmed);
                }
            }
            remainder = Buffer.from(buf.subarray(lastNl + 1));
        });
        stream.on('end', () => resolve({ lines, newOffset: offset + totalRead - remainder.length }));
        stream.on('error', reject);
    });
}
