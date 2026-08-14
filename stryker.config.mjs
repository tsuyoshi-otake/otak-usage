/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
    mutate: [
        'src/types.ts:33-83',
        'src/period.ts:4-34',
        'src/pricing.ts:136-269',
        'src/aggregator.ts:5-111',
    ],
    ignorePatterns: [
        '/.vscode-test/**',
        '/.codex/**',
        '/spec/**',
        '/docs/**',
        '/domain-quality-evidence/**',
        '/images/**',
        '/audio/**',
        '/out/**',
    ],
    testRunner: 'mocha',
    mochaOptions: {
        spec: ['out/test/domain/**/*.test.js'],
        ui: 'tdd',
    },
    buildCommand: 'npm run compile',
    checkers: ['typescript'],
    coverageAnalysis: 'perTest',
    concurrency: 2,
    timeoutMS: 10_000,
    timeoutFactor: 2,
    thresholds: { high: 90, low: 80, break: 80 },
    reporters: ['clear-text', 'progress', 'json'],
    jsonReporter: { fileName: 'docs/verification/evidence/mutation.json' },
    cleanTempDir: 'always',
};

export default config;
