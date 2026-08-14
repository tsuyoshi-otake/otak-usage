#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidence = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'verification', 'evidence', 'c2-latest.json'), 'utf8'));
if (evidence.covered !== evidence.total || evidence.percent !== 100 || evidence.missing.length !== 0) {
    throw new Error(`Atomic C2 failed: ${evidence.covered}/${evidence.total}, missing=${evidence.missing.join(', ')}`);
}
for (const condition of evidence.conditions ?? []) {
    if (!condition.outcomes.includes(true) || !condition.outcomes.includes(false)) {
        throw new Error(`Atomic C2 condition lacks both outcomes: ${condition.id}`);
    }
}
console.log(`Atomic-condition C2 PASS: ${evidence.covered}/${evidence.total} outcomes (${evidence.percent}%).`);
