#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const reportPath = path.join(repo, 'docs', 'verification', 'evidence', 'mutation.json');
const classificationsPath = path.join(repo, 'docs', 'verification', 'mutation-classifications.json');
const analysisPath = path.join(repo, 'docs', 'verification', 'evidence', 'mutation-analysis.md');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (!fs.existsSync(reportPath)) {
    throw new Error(`Mutation report is missing: ${path.relative(repo, reportPath)}`);
}

const report = readJson(reportPath);
const classifications = readJson(classificationsPath);
const entries = new Map(classifications.mutants.map((entry) => [String(entry.mutantId), entry]));
const mutants = Object.entries(report.files ?? {}).flatMap(([file, value]) =>
    (value.mutants ?? []).map((mutant) => ({ file, ...mutant })),
);
const actionable = mutants.filter((mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage');
const unclassified = actionable.filter((mutant) => !entries.has(String(mutant.id)));
const stale = [...entries.keys()].filter((id) => !actionable.some((mutant) => String(mutant.id) === id));
const invalid = [...entries.values()].filter((entry) =>
    !['test-gap', 'equivalent', 'out-of-scope', 'accepted-residual'].includes(entry.classification) ||
    typeof entry.rationale !== 'string' || entry.rationale.trim() === '' ||
    typeof entry.evidence !== 'string' || entry.evidence.trim() === '',
);
const highRiskSurvivors = actionable.filter((mutant) => {
    const entry = entries.get(String(mutant.id));
    return entry?.highRisk === true && entry.classification !== 'equivalent';
});

const totals = mutants.reduce((acc, mutant) => {
    acc[mutant.status] = (acc[mutant.status] ?? 0) + 1;
    return acc;
}, {});
const detected = (totals.Killed ?? 0) + (totals.Timeout ?? 0);
const denominator = detected + actionable.length;
const score = denominator === 0 ? 100 : detected * 100 / denominator;

fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
const lines = [
    '# Mutation analysis — Issue #43',
    '',
    `Mutation score: **${score.toFixed(2)}%** (${detected}/${denominator} detected).`,
    '',
    `Statuses: ${Object.entries(totals).sort().map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}.`,
    '',
    '| Mutant | File | Status | Classification | High risk | Rationale / evidence |',
    '|---|---|---|---|---:|---|',
];
for (const mutant of actionable) {
    const entry = entries.get(String(mutant.id));
    lines.push(`| ${mutant.id} | ${mutant.file} | ${mutant.status} | ${entry?.classification ?? 'UNCLASSIFIED'} | ${entry?.highRisk === true} | ${entry ? `${entry.rationale} Evidence: ${entry.evidence}` : ''} |`);
}
if (actionable.length === 0) {
    lines.push('| — | — | — | none (all scored mutants detected) | false | No surviving or uncovered mutant. |');
}
lines.push('', `Stale classification IDs: ${stale.length === 0 ? 'none' : stale.join(', ')}.`);
fs.writeFileSync(analysisPath, `${lines.join('\n')}\n`, 'utf8');

if (unclassified.length > 0 || stale.length > 0 || invalid.length > 0 || highRiskSurvivors.length > 0) {
    const messages = [];
    if (unclassified.length > 0) messages.push(`unclassified=${unclassified.map((m) => m.id).join(',')}`);
    if (stale.length > 0) messages.push(`stale=${stale.join(',')}`);
    if (invalid.length > 0) messages.push(`invalid=${invalid.map((m) => m.mutantId).join(',')}`);
    if (highRiskSurvivors.length > 0) messages.push(`high-risk-survivors=${highRiskSurvivors.map((m) => m.id).join(',')}`);
    throw new Error(`Mutation analysis failed: ${messages.join('; ')}`);
}

console.log(`Mutation analysis PASS: score=${score.toFixed(2)}%, actionable survivors=${actionable.length}, all classified.`);
