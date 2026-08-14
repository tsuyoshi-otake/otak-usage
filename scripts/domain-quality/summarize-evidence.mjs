#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceDir = path.join(repo, 'domain-quality-evidence', 'pbt');
const outputDir = path.join(repo, 'docs', 'verification', 'evidence');
const output = path.join(outputDir, 'pbt-latest.json');
const files = fs.existsSync(evidenceDir)
    ? fs.readdirSync(evidenceDir).filter((file) => file.endsWith('.json')).sort()
    : [];
const runs = files.map((file) => JSON.parse(fs.readFileSync(path.join(evidenceDir, file), 'utf8')));
const errors = [];
if (runs.length !== 5) errors.push(`expected 5 property records, found ${runs.length}`);
for (const run of runs) {
    if (run.status !== 'passed') errors.push(`${run.property}: status=${run.status}`);
    if (!Number.isSafeInteger(run.seed)) errors.push(`${run.property}: invalid seed`);
    if (!Number.isSafeInteger(run.numRuns) || run.numRuns < 1) errors.push(`${run.property}: invalid numRuns`);
    if (run.counterexample !== null) errors.push(`${run.property}: passing run must record counterexample=null`);
}
const summary = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    passed: errors.length === 0,
    propertyCount: runs.length,
    seeds: [...new Set(runs.map((run) => run.seed))],
    totalRuns: runs.reduce((sum, run) => sum + (run.numRuns ?? 0), 0),
    failureEvidenceContract: 'On failure each property JSON contains fast-check seed, counterexamplePath, fully shrunk counterexample, and replay command.',
    runs,
    errors,
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (errors.length > 0) throw new Error(`PBT evidence failed: ${errors.join('; ')}`);
console.log(`PBT evidence PASS: ${runs.length} properties, ${summary.totalRuns} generated cases, seeds=${summary.seeds.join(',')}.`);
