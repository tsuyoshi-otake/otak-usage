import * as fs from 'fs';

export interface ReadResult {
    lines: string[];
    /** Absolute byte offset just past the last complete line that was read. */
    newOffset: number;
}

export interface VisitResult {
    /** Absolute byte offset just past the last complete line that was read. */
    newOffset: number;
    /** Number of non-empty complete lines delivered to the visitor. */
    lineCount: number;
}

/**
 * Read complete lines from `offset` to EOF. An incomplete trailing line (no
 * newline yet — the writer may still be appending) is NOT consumed: it is
 * excluded from `lines` and `newOffset` stays before it, so the next read
 * picks it up once the newline arrives. Splitting at the newline byte is
 * UTF-8 safe (0x0A never occurs inside a multi-byte sequence).
 */
export function readNewLines(filePath: string, offset: number): Promise<ReadResult> {
    const lines: string[] = [];
    return visitNewLines(filePath, offset, (line) => lines.push(line))
        .then((result) => ({ lines, newOffset: result.newOffset }));
}

/**
 * Visit complete lines from `offset` to EOF without retaining all lines in
 * memory. The reader only keeps the current unterminated line, so steady
 * memory is bounded by the longest line rather than by total unread bytes.
 */
export function visitNewLines(filePath: string, offset: number, visit: (line: string) => void): Promise<VisitResult> {
    return new Promise((resolve, reject) => {
        let pending: Buffer[] = [];
        let pendingLength = 0;
        let totalRead = 0;
        let lineCount = 0;
        let settled = false;
        let aborted = false;
        const stream = fs.createReadStream(filePath, { start: offset });
        stream.on('data', (chunk) => {
            if (aborted) {
                return;
            }
            const c = chunk as Buffer;
            totalRead += c.length;
            let lineStart = 0;
            let nl = c.indexOf(0x0a, lineStart);
            while (nl !== -1) {
                if (!emitLine(c.subarray(lineStart, nl))) {
                    return;
                }
                lineStart = nl + 1;
                nl = c.indexOf(0x0a, lineStart);
            }
            if (lineStart < c.length) {
                pending.push(c.subarray(lineStart));
                pendingLength += c.length - lineStart;
            }
        });
        stream.on('end', () => {
            if (!settled) {
                settled = true;
                resolve({ newOffset: offset + totalRead - pendingLength, lineCount });
            }
        });
        stream.on('error', (err) => {
            fail(err);
        });

        function emitLine(fragment: Buffer): boolean {
            let lineBuffer = fragment;
            if (pendingLength > 0) {
                pending.push(fragment);
                lineBuffer = Buffer.concat(pending, pendingLength + fragment.length);
                pending = [];
                pendingLength = 0;
            }
            const line = lineBuffer.toString('utf8');
            const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (trimmed) {
                try {
                    visit(trimmed);
                } catch (err) {
                    fail(err);
                    return false;
                }
                lineCount++;
            }
            return true;
        }

        function fail(err: unknown): void {
            if (settled) {
                return;
            }
            settled = true;
            aborted = true;
            stream.destroy();
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}
