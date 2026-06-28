import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ProviderSummary } from './aggregator';
import { Provider, TokenUsage } from './types';
import { RtkStats } from './rtk';

/** Selectable telemetry contents. Default is all of them. */
export type TelemetryMetric = 'tokenUsage' | 'cost' | 'rtkTokens';

export const ALL_TELEMETRY_METRICS: TelemetryMetric[] = ['tokenUsage', 'cost', 'rtkTokens'];

/**
 * Telemetry export configuration, read from `otakUsage.telemetry.*`.
 * Disabled by default — nothing leaves the machine unless opted in.
 */
export interface TelemetryConfig {
    enabled: boolean;
    /** Which contents to export. Empty = nothing. */
    metrics: TelemetryMetric[];
    /** Base OTLP/HTTP endpoint, e.g. http://localhost:4318 (the /v1/metrics path is appended). */
    endpoint: string;
    /** Extra HTTP headers, e.g. authorization for Grafana Cloud / Honeycomb. */
    headers: Record<string, string>;
    /** OTel resource service.name. */
    serviceName: string;
    /** OTel resource service.version (the extension version). */
    serviceVersion: string;
    /**
     * Free-form source identifier set by the user, exported as the OTel
     * `service.instance.id` resource attribute. Omitted when blank.
     */
    serviceInstanceId: string;
}

export interface TelemetrySnapshot {
    /** epoch ms of this export (metric data point time). */
    timestampMs: number;
    /** epoch ms of the start of the aggregation window (current month); the counter start time. */
    windowStartMs: number;
    summaries: Record<Provider, ProviderSummary>;
    rtk?: RtkStats;
}

// --- Minimal OTLP/JSON metric shapes (subset of the protobuf-derived schema) ---

type OtlpAnyValue =
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };

interface OtlpKeyValue {
    key: string;
    value: OtlpAnyValue;
}

interface OtlpNumberDataPoint {
    attributes: OtlpKeyValue[];
    startTimeUnixNano: string;
    timeUnixNano: string;
    asInt?: string;
    asDouble?: number;
}

interface OtlpSum {
    dataPoints: OtlpNumberDataPoint[];
    /** 2 = AGGREGATION_TEMPORALITY_CUMULATIVE. */
    aggregationTemporality: 2;
    isMonotonic: boolean;
}

interface OtlpMetric {
    name: string;
    description: string;
    unit: string;
    sum: OtlpSum;
}

export interface OtlpMetricsPayload {
    resourceMetrics: Array<{
        resource: { attributes: OtlpKeyValue[] };
        scopeMetrics: Array<{
            scope: { name: string; version: string };
            metrics: OtlpMetric[];
        }>;
    }>;
}

const SCOPE_NAME = 'otak-usage';

/** OpenTelemetry GenAI `gen_ai.system` value per provider. */
function genAiSystem(provider: Provider): string {
    return provider === 'claude' ? 'anthropic' : 'openai';
}

/** Convert epoch milliseconds to a unix-nano string without BigInt precision loss. */
function nanos(ms: number): string {
    if (ms <= 0) {
        return '0';
    }
    return String(Math.round(ms)) + '000000';
}

function strAttr(key: string, value: string): OtlpKeyValue {
    return { key, value: { stringValue: value } };
}

/**
 * Map a TokenUsage into OpenTelemetry `gen_ai.token.type` buckets. `input` and
 * `output` are the standardized values; `cache_read` and `cache_creation` are the
 * widely-used GenAI extensions for prompt caching. Provider-specific cached-input
 * fields collapse into `cache_read` (only one is ever non-zero per provider).
 */
function tokenTypeBreakdown(u: TokenUsage): Array<[type: string, value: number]> {
    return [
        ['input', u.input],
        ['output', u.output],
        ['cache_read', u.cacheRead + u.cachedInput],
        ['cache_creation', u.cacheWrite5m + u.cacheWrite1h],
    ];
}

/**
 * Build an OTLP/JSON metrics payload from a usage snapshot. Pure and
 * deterministic so it can be unit-tested without any network.
 *
 * Each content is emitted only when selected in `config.metrics`:
 *  - `tokenUsage` → `gen_ai.client.token.usage` (Sum, cumulative, monotonic) — month-to-date
 *    token counts, labelled gen_ai.system / gen_ai.response.model / gen_ai.token.type.
 *  - `cost` → `otak_usage.cost.usd` (Sum, cumulative, monotonic) — month-to-date API-equivalent
 *    cost in USD, labelled gen_ai.system / gen_ai.response.model. Unknown-priced models are skipped.
 *  - `rtkTokens` → `otak_usage.rtk.tokens` (Sum, cumulative, monotonic) — all-time RTK token
 *    counts, labelled otak_usage.rtk.type (input/output/saved). Only when rtk stats exist.
 *
 * Zero-valued data points are omitted. Returns undefined when there is nothing to send.
 */
export function buildMetricsPayload(config: TelemetryConfig, snapshot: TelemetrySnapshot): OtlpMetricsPayload | undefined {
    const metrics: OtlpMetric[] = [];
    const wants = (m: TelemetryMetric) => config.metrics.includes(m);

    if (wants('tokenUsage')) {
        const tokenPoints: OtlpNumberDataPoint[] = [];
        for (const summary of Object.values(snapshot.summaries)) {
            const system = genAiSystem(summary.provider);
            for (const row of summary.models) {
                for (const [type, value] of tokenTypeBreakdown(row.monthUsage)) {
                    if (value <= 0) {
                        continue;
                    }
                    tokenPoints.push({
                        attributes: [
                            strAttr('gen_ai.system', system),
                            strAttr('gen_ai.response.model', row.model),
                            strAttr('gen_ai.token.type', type),
                        ],
                        startTimeUnixNano: nanos(snapshot.windowStartMs),
                        timeUnixNano: nanos(snapshot.timestampMs),
                        asInt: String(Math.round(value)),
                    });
                }
            }
        }
        if (tokenPoints.length > 0) {
            metrics.push({
                name: 'gen_ai.client.token.usage',
                description: 'Number of tokens used, month-to-date, per model and token type.',
                unit: '{token}',
                sum: { dataPoints: tokenPoints, aggregationTemporality: 2, isMonotonic: true },
            });
        }
    }

    if (wants('cost')) {
        const costPoints: OtlpNumberDataPoint[] = [];
        for (const summary of Object.values(snapshot.summaries)) {
            const system = genAiSystem(summary.provider);
            for (const row of summary.models) {
                if (row.monthCost === undefined || row.monthCost <= 0) {
                    continue;
                }
                costPoints.push({
                    attributes: [
                        strAttr('gen_ai.system', system),
                        strAttr('gen_ai.response.model', row.model),
                    ],
                    startTimeUnixNano: nanos(snapshot.windowStartMs),
                    timeUnixNano: nanos(snapshot.timestampMs),
                    asDouble: row.monthCost,
                });
            }
        }
        if (costPoints.length > 0) {
            metrics.push({
                name: 'otak_usage.cost.usd',
                description: 'Estimated API-equivalent cost in USD, month-to-date, per model.',
                unit: 'USD',
                sum: { dataPoints: costPoints, aggregationTemporality: 2, isMonotonic: true },
            });
        }
    }

    if (wants('rtkTokens') && snapshot.rtk) {
        const rtkPoints: OtlpNumberDataPoint[] = [];
        const t = snapshot.rtk.allTime;
        for (const [type, value] of [
            ['saved', t.savedTokens],
            ['input', t.inputTokens],
            ['output', t.outputTokens],
        ] as const) {
            if (value <= 0) {
                continue;
            }
            rtkPoints.push({
                attributes: [strAttr('otak_usage.rtk.type', type)],
                startTimeUnixNano: '0',
                timeUnixNano: nanos(snapshot.timestampMs),
                asInt: String(Math.round(value)),
            });
        }
        if (rtkPoints.length > 0) {
            metrics.push({
                name: 'otak_usage.rtk.tokens',
                description: 'All-time RTK (Rust Token Killer) token counts by type.',
                unit: '{token}',
                sum: { dataPoints: rtkPoints, aggregationTemporality: 2, isMonotonic: true },
            });
        }
    }

    if (metrics.length === 0) {
        return undefined;
    }

    const resourceAttributes = [
        strAttr('service.name', config.serviceName),
        strAttr('service.version', config.serviceVersion),
    ];
    if (config.serviceInstanceId.trim() !== '') {
        resourceAttributes.push(strAttr('service.instance.id', config.serviceInstanceId.trim()));
    }

    return {
        resourceMetrics: [{
            resource: {
                attributes: resourceAttributes,
            },
            scopeMetrics: [{
                scope: { name: SCOPE_NAME, version: config.serviceVersion },
                metrics,
            }],
        }],
    };
}

/** Resolve the OTLP metrics URL from a base endpoint, OTEL_EXPORTER_OTLP_ENDPOINT-style. */
export function metricsUrl(endpoint: string): string {
    const base = endpoint.trim().replace(/\/+$/, '');
    return base.endsWith('/v1/metrics') ? base : base + '/v1/metrics';
}

/**
 * Export a usage snapshot as OTLP/JSON metrics over HTTP. No-ops when disabled,
 * endpoint is blank, or there is nothing to send. Rejects on transport / non-2xx
 * so the caller can log it; never throws synchronously.
 */
export async function exportTelemetry(config: TelemetryConfig, snapshot: TelemetrySnapshot): Promise<boolean> {
    if (!config.enabled || config.endpoint.trim() === '') {
        return false;
    }
    const payload = buildMetricsPayload(config, snapshot);
    if (!payload) {
        return false;
    }
    await postJson(metricsUrl(config.endpoint), config.headers, JSON.stringify(payload));
    return true;
}

function postJson(url: string, headers: Record<string, string>, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`invalid telemetry endpoint: ${url}`));
            return;
        }
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.request(
            target,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    ...headers,
                },
                timeout: 10_000,
            },
            (res) => {
                const status = res.statusCode ?? 0;
                res.resume(); // drain
                if (status >= 200 && status < 300) {
                    resolve();
                } else {
                    reject(new Error(`telemetry export failed: HTTP ${status}`));
                }
            },
        );
        req.on('timeout', () => req.destroy(new Error('telemetry export timed out')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
