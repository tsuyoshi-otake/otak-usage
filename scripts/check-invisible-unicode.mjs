#!/usr/bin/env node
/**
 * Fail when repository sources or compiled distribution files contain
 * invisible or display-spoofing Unicode code points.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinding, scanTextForInvisibleUnicode } from './lib/invisible-unicode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp',
    '.wav', '.mp3', '.ogg', '.mp4',
    '.ttf', '.otf', '.woff', '.woff2',
    '.zip', '.vsix', '.gz', '.pdf', '.exe', '.dll'
]);

const DIST_ROOTS = ['out'];
const DIST_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'LICENSE'];
const DIST_TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.mjs', '.cjs']);

function listCandidateFiles() {
    const stdout = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    return [...new Set(stdout.split('\0').filter(Boolean))];
}

function walkDirectory(absoluteDir, predicate, collected) {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const absolute = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
            walkDirectory(absolute, predicate, collected);
        } else if (entry.isFile() && predicate(absolute)) {
            collected.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
        }
    }
    return collected;
}

function listDistFiles() {
    const collected = [];

    for (const root of DIST_ROOTS) {
        const absolute = path.join(repoRoot, root);
        if (!fs.existsSync(absolute)) {
            throw new Error(`${root}/ does not exist - run "npm run compile" before scanning distribution files.`);
        }
        walkDirectory(absolute, file => DIST_TEXT_EXTENSIONS.has(path.extname(file)), collected);
    }

    for (const file of DIST_FILES) {
        if (fs.existsSync(path.join(repoRoot, file))) {
            collected.push(file);
        }
    }

    for (const entry of fs.readdirSync(repoRoot)) {
        if (/^package\.nls.*\.json$/.test(entry)) {
            collected.push(entry);
        }
    }

    return collected;
}

function listExplicitTargets(targets) {
    const collected = [];
    for (const target of targets) {
        const absolute = path.resolve(repoRoot, target);
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            walkDirectory(absolute, () => true, collected);
        } else {
            collected.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
        }
    }
    return collected;
}

function scanFiles(relativePaths) {
    const findings = [];
    let scanned = 0;
    let skipped = 0;

    for (const relativePath of relativePaths) {
        if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
            skipped += 1;
            continue;
        }

        let buffer;
        try {
            buffer = fs.readFileSync(path.join(repoRoot, relativePath));
        } catch {
            skipped += 1;
            continue;
        }

        scanned += 1;
        for (const finding of scanTextForInvisibleUnicode(buffer.toString('utf8'))) {
            findings.push({ relativePath, finding });
        }
    }

    return { findings, scanned, skipped };
}

function main(argv) {
    const explicitTargets = argv.filter(arg => !arg.startsWith('--'));
    const distMode = argv.includes('--dist');

    let mode;
    let targets;
    if (explicitTargets.length > 0) {
        mode = 'explicit paths';
        targets = listExplicitTargets(explicitTargets);
    } else if (distMode) {
        mode = 'shipped artifacts';
        targets = listDistFiles();
    } else {
        mode = 'repository files';
        targets = listCandidateFiles();
    }

    const { findings, scanned, skipped } = scanFiles(targets);

    if (findings.length > 0) {
        console.error(`Invisible Unicode characters detected in ${mode}:\n`);
        for (const { relativePath, finding } of findings) {
            console.error(`  ${formatFinding(finding, relativePath)}`);
        }
        console.error(
            `\n${findings.length} occurrence(s) in ${new Set(findings.map(f => f.relativePath)).size} file(s).` +
            '\nInvisible characters can hide executable code from review (GlassWorm, Trojan Source).' +
            '\nRemove them, or document and implement a narrowly scoped exemption in scripts/lib/invisible-unicode.mjs.'
        );
        return 1;
    }

    console.log(`No invisible Unicode characters found (${mode}: ${scanned} scanned, ${skipped} skipped as binary).`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
