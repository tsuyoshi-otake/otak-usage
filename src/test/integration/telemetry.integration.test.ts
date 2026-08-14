import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ProviderSummary } from '../../aggregator';
import { exportTelemetry, TelemetryConfig, TelemetrySnapshot } from '../../telemetry';
import { emptyUsage } from '../../types';

suite('API integration: OTLP telemetry export', () => {
    const config = (endpoint: string): TelemetryConfig => ({
        enabled: true,
        endpoint,
        metrics: ['tokenUsage'],
        headers: { authorization: 'Bearer test-only', 'x-contract': 'v1' },
        serviceName: 'otak-usage-test',
        serviceVersion: '1.0.0',
        serviceInstanceId: 'integration',
    });
    const summaries: Record<'claude' | 'codex', ProviderSummary> = {
        claude: {
            provider: 'claude', todayCost: 0, monthCost: 0, hasUnknownModel: false,
            models: [{ model: 'claude-test', todayUsage: emptyUsage(), monthUsage: { ...emptyUsage(), input: 12 }, todayCost: 0, monthCost: 0 }],
        },
        codex: { provider: 'codex', todayCost: 0, monthCost: 0, hasUnknownModel: false, models: [] },
    };
    const snapshot = (timestampMs = 2_000): TelemetrySnapshot => ({ timestampMs, windowStartMs: 1_000, summaries });

    async function listen(handler: http.RequestListener): Promise<{ server: http.Server; endpoint: string }> {
        const server = http.createServer(handler);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address() as AddressInfo;
        return { server, endpoint: `http://127.0.0.1:${address.port}/collector` };
    }

    async function close(server: http.Server): Promise<void> {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }

    test('posts protocol-compatible OTLP JSON to the resolved URL with exact headers and body', async () => {
        let received = false;
        const { server, endpoint } = await listen((req, res) => {
            void (async () => {
                assert.strictEqual(req.method, 'POST');
                assert.strictEqual(req.url, '/collector/v1/metrics');
                assert.strictEqual(req.headers['content-type'], 'application/json');
                assert.strictEqual(req.headers.authorization, 'Bearer test-only');
                assert.strictEqual(req.headers['x-contract'], 'v1');
                const chunks: Buffer[] = [];
                for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
                const body = Buffer.concat(chunks);
                assert.strictEqual(Number(req.headers['content-length']), body.length);
                const parsed = JSON.parse(body.toString('utf8'));
                const metric = parsed.resourceMetrics[0].scopeMetrics[0].metrics[0];
                assert.strictEqual(metric.name, 'gen_ai.client.token.usage');
                assert.strictEqual(metric.sum.dataPoints[0].asInt, '12');
                received = true;
                res.writeHead(202).end();
            })().catch((err) => { res.destroy(err as Error); });
        });
        try {
            assert.strictEqual(await exportTelemetry(config(endpoint), snapshot()), true);
            assert.strictEqual(received, true);
        } finally {
            await close(server);
        }
    });

    test('partial failure is reported and a later independent retry can recover', async () => {
        let attempts = 0;
        const { server, endpoint } = await listen((_req, res) => {
            attempts++;
            res.writeHead(attempts === 1 ? 503 : 204).end();
        });
        try {
            await assert.rejects(exportTelemetry(config(endpoint), snapshot()), /HTTP 503/);
            assert.strictEqual(await exportTelemetry(config(endpoint), snapshot()), true);
            assert.strictEqual(attempts, 2, 'the exporter neither retries nor duplicates a call internally');
        } finally {
            await close(server);
        }
    });

    test('HTTP success boundaries are inclusive from 200 through 299', async () => {
        // Node treats 1xx as an interim response rather than a final HTTP result,
        // so the executable transport boundary starts with the first valid final
        // success status and ends immediately above the success range.
        const statuses = [200, 299, 300];
        const { server, endpoint } = await listen((_req, res) => res.writeHead(statuses.shift()!).end());
        try {
            assert.strictEqual(await exportTelemetry(config(endpoint), snapshot()), true);
            assert.strictEqual(await exportTelemetry(config(endpoint), snapshot()), true);
            await assert.rejects(exportTelemetry(config(endpoint), snapshot()), /HTTP 300/);
            assert.strictEqual(statuses.length, 0);
        } finally {
            await close(server);
        }
    });

    test('duplicate concurrent exports tolerate response-order reversal without shared state', async () => {
        const received: number[] = [];
        let requestNumber = 0;
        const { server, endpoint } = await listen((req, res) => {
            const ordinal = ++requestNumber;
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const nanos = body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano;
                received.push(Number(nanos) / 1_000_000);
                setTimeout(() => res.writeHead(204).end(), ordinal === 1 ? 25 : 0);
            });
        });
        try {
            assert.deepStrictEqual(await Promise.all([
                exportTelemetry(config(endpoint), snapshot(2_000)),
                exportTelemetry(config(endpoint), snapshot(3_000)),
            ]), [true, true]);
            assert.deepStrictEqual(received.sort(), [2_000, 3_000]);
        } finally {
            await close(server);
        }
    });

    test('omission gates cause no network effect', async () => {
        let requests = 0;
        const { server, endpoint } = await listen((_req, res) => { requests++; res.writeHead(204).end(); });
        try {
            assert.strictEqual(await exportTelemetry({ ...config(endpoint), enabled: false }, snapshot()), false);
            assert.strictEqual(await exportTelemetry({ ...config(endpoint), metrics: [] }, snapshot()), false);
            assert.strictEqual(requests, 0);
        } finally {
            await close(server);
        }
    });

    test('a stalled connection is cancelled by the configured request timeout', async () => {
        const { server, endpoint } = await listen((_req, _res) => { /* intentionally never respond */ });
        const started = Date.now();
        try {
            await assert.rejects(exportTelemetry(config(endpoint), snapshot(), { timeoutMs: 15 }), /timed out/);
            assert.ok(Date.now() - started < 1000);
        } finally {
            await close(server);
        }
    });
});
