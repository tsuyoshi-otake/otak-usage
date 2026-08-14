import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';

export const DEFAULT_PBT_SEED = 0x43_2026;
export const DEFAULT_PBT_RUNS = 250;

interface RunEvidence {
    schemaVersion: 1;
    property: string;
    status: 'passed' | 'failed';
    seed: number;
    replayPath: string | null;
    counterexample: unknown | null;
    numRuns: number;
    numSkips: number;
    error: string | null;
    replay: string;
}

function configuredInteger(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} must be a safe integer, got ${JSON.stringify(raw)}`);
    }
    return parsed;
}

function evidenceDirectory(): string {
    return path.resolve(process.env.DOMAIN_PBT_EVIDENCE_DIR ?? 'domain-quality-evidence/pbt');
}

function safeFileName(propertyName: string): string {
    return propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Runs a property with a deterministic default seed.  On failure, fast-check's
 * fully-shrunk counterexample and replay path are synchronously persisted before
 * the assertion is thrown, so CI artifacts remain useful after process exit.
 */
export function checkProperty<Ts extends unknown[]>(name: string, property: fc.IProperty<Ts>): void {
    const seed = configuredInteger('DOMAIN_PBT_SEED', DEFAULT_PBT_SEED);
    const numRuns = configuredInteger('DOMAIN_PBT_RUNS', DEFAULT_PBT_RUNS);
    const replayPath = process.env.DOMAIN_PBT_PATH;
    const details = fc.check(property, {
        seed,
        numRuns,
        path: replayPath,
        verbose: fc.VerbosityLevel.VeryVerbose,
    });
    const directory = evidenceDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${safeFileName(name)}.json`);
    if (!details.failed) {
        const evidence: RunEvidence = {
            schemaVersion: 1,
            property: name,
            status: 'passed',
            seed: details.seed,
            replayPath: null,
            counterexample: null,
            numRuns: details.numRuns,
            numSkips: details.numSkips,
            error: null,
            replay: `DOMAIN_PBT_SEED=${details.seed}`,
        };
        fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
        return;
    }

    const evidence: RunEvidence = {
        schemaVersion: 1,
        property: name,
        status: 'failed',
        seed: details.seed,
        replayPath: details.counterexamplePath ?? null,
        counterexample: details.counterexample,
        numRuns: details.numRuns,
        numSkips: details.numSkips,
        error: details.errorInstance instanceof Error
            ? details.errorInstance.stack ?? details.errorInstance.message
            : String(details.errorInstance ?? 'fast-check reported a failure without an Error instance'),
        replay: `DOMAIN_PBT_SEED=${details.seed} DOMAIN_PBT_PATH=${details.counterexamplePath ?? ''}`,
    };
    fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    throw new Error(`Property ${JSON.stringify(name)} failed; shrunk evidence saved to ${target}\n${evidence.error}`);
}
