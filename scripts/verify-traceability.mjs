#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = path.join(repo, 'docs', 'verification', 'traceability.json');
const outputPath = path.join(repo, 'docs', 'verification', 'traceability.md');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const errors = [];
const ids = new Set();

const requiredIds = [
    'REQ-DOM-ORACLE', 'REQ-DOM-PBT', 'REQ-DOM-C2', 'REQ-DOM-MUTATION',
    'BND-CLAUDE', 'BND-CODEX', 'BND-TELEMETRY', 'BND-RTK', 'BND-COORDINATION',
    'FLT-PARTIAL-RETRY', 'FLT-DUPLICATE-OMISSION-REORDER', 'FLT-CANCEL-TIMEOUT',
    'FLT-CRASH-RESOURCE-RECOVERY', 'FORMAL-SAFETY-LIVENESS',
];
const pathFields = ['oracle', 'tests', 'implementation', 'evidence'];
const descriptivePathExceptions = new Set([
    'loopback HTTP contract and independent response fixtures',
    'temporary JSONL fixtures with independently specified last-valid-event semantics',
    'loopback OTLP/HTTP receiver recording exact request bytes',
    'protocol-compatible injected execFile callback',
    'independent event fixtures and TLA+ duplicate identity',
    'deadline-controlled test dependencies and boundary N/A inventory',
    'failure injection fixtures and independent lifecycle model',
]);

for (const entry of matrix.entries ?? []) {
    if (ids.has(entry.id)) errors.push(`duplicate id ${entry.id}`);
    ids.add(entry.id);
    for (const field of ['requirement', 'oracle', 'tests', 'pbt', 'tlaActions', 'tlaProperties', 'implementation', 'evidence']) {
        if (entry[field] === undefined || (Array.isArray(entry[field]) && entry[field].length === 0)) {
            errors.push(`${entry.id}: empty ${field}`);
        }
    }
    for (const field of pathFields) {
        for (const value of entry[field] ?? []) {
            if (descriptivePathExceptions.has(value)) continue;
            if (!value.includes('/') && !value.includes('\\')) continue;
            if (!fs.existsSync(path.join(repo, value))) errors.push(`${entry.id}: missing ${field} path ${value}`);
        }
    }
}
for (const id of requiredIds) if (!ids.has(id)) errors.push(`missing required id ${id}`);

const c2Source = fs.readFileSync(path.join(repo, 'src', 'test', 'domain', 'c2Inventory.ts'), 'utf8');
const inventoryIds = [...c2Source.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);
const mappedConditions = new Set(matrix.entries.flatMap((entry) => entry.atomicConditions ?? []));
for (const id of inventoryIds) if (!mappedConditions.has(id)) errors.push(`unmapped atomic condition ${id}`);
for (const id of mappedConditions) if (!inventoryIds.includes(id)) errors.push(`unknown mapped atomic condition ${id}`);

const tlcEvidence = JSON.parse(fs.readFileSync(path.join(repo, 'spec', 'coordination', 'evidence', 'latest.json'), 'utf8'));
const mappedActions = new Set(matrix.entries.flatMap((entry) => entry.tlaActions ?? []));
for (const action of tlcEvidence.vacuityAudit.requiredActions) {
    if (!mappedActions.has(action)) errors.push(`unmapped required TLA+ Action ${action}`);
}
if (!tlcEvidence.suitePassed) errors.push('latest TLC suite did not pass its expected outcomes');
if ((tlcEvidence.vacuityAudit.actionsWithZeroInvocations ?? []).length > 0) {
    errors.push(`vacuous TLA+ Actions: ${tlcEvidence.vacuityAudit.actionsWithZeroInvocations.join(', ')}`);
}

const lines = [
    '# Verification traceability — Issue #43',
    '',
    '| ID | Requirement / boundary / fault | Oracle | Tests / PBT | TLA+ Actions / Properties | Implementation | Evidence |',
    '|---|---|---|---|---|---|---|',
];
for (const entry of matrix.entries) {
    lines.push(`| ${entry.id} | ${entry.requirement} | ${entry.oracle.join('<br>')} | ${[...entry.tests, ...entry.pbt].join('<br>')} | ${[...entry.tlaActions, ...entry.tlaProperties].join('<br>')} | ${entry.implementation.join('<br>')} | ${entry.evidence.join('<br>')} |`);
}
lines.push('', `Atomic C2 identifiers mapped: **${mappedConditions.size}/${inventoryIds.length}**.`,
    `Required TLA+ Actions mapped and non-vacuous: **${tlcEvidence.vacuityAudit.requiredActions.length}/${tlcEvidence.vacuityAudit.requiredActions.length}**.`);
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

if (errors.length > 0) {
    throw new Error(`Traceability verification failed:\n- ${errors.join('\n- ')}`);
}
console.log(`Traceability PASS: ${ids.size} unique entries, ${inventoryIds.length} atomic conditions, ${tlcEvidence.vacuityAudit.requiredActions.length} TLA+ Actions.`);
