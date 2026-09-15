#!/usr/bin/env node
/**
 * run-tests.js — runs the compiled test suite on every supported Node and shell.
 *
 * `node --test` is fussier about how it is given files than it looks, and the
 * two obvious spellings each break somewhere this project supports:
 *
 *   node --test dist/tests/*.test.js    the shell expands the glob — except
 *                                       cmd.exe, which does not, so on Windows
 *                                       this works only on Node 22+, where Node
 *                                       expands it itself. package.json declares
 *                                       Node >= 20.9.
 *   node --test dist/tests              works on Node 20 and on 26, and fails on
 *                                       22 with MODULE_NOT_FOUND — 22 treats the
 *                                       path as a file to run rather than a
 *                                       directory to search. (Found by CI, after
 *                                       the directory form looked correct on a
 *                                       Node 26 laptop.)
 *
 * An explicit list of file paths is the one form every supported version has
 * always accepted, and building it here rather than in the shell means no
 * globbing and no quoting to get wrong. The coverage flags live here for the
 * same reason: `--test-coverage-exclude='dist/tests/**'` in an npm script keeps
 * its single quotes on Windows.
 *
 * Usage:  node scripts/run-tests.js [--coverage] [extra node flags…]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = path.join(__dirname, '..', 'dist', 'tests');

// A ratchet, not a target. The floors sit just under the measured numbers so a
// real drop fails the build while ordinary refactoring does not. Raise them when
// the true figure moves up; never lower them to go green.
const COVERAGE_FLAGS = [
    '--experimental-test-coverage',
    '--test-coverage-exclude=dist/tests/**',
    '--test-coverage-exclude=vscode-extension/**',
    // Measured 90.67 / 83.67 / 84.01 after the attributes.ts consolidation and
    // the macOS-installer and icon-cache suites. Ratcheted up from 85/80/80.
    '--test-coverage-lines=88',
    '--test-coverage-branches=82',
    '--test-coverage-functions=82',
];

if (!fs.existsSync(TESTS_DIR)) {
    console.error(`run-tests: ${TESTS_DIR} not found — run "npm run build" first.`);
    process.exit(1);
}

const files = fs.readdirSync(TESTS_DIR)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => path.join(TESTS_DIR, f));

if (files.length === 0) {
    console.error(`run-tests: no *.test.js in ${TESTS_DIR} — the build produced no tests.`);
    process.exit(1);
}

const passthrough = process.argv.slice(2).filter(a => a !== '--coverage');
const coverage    = process.argv.includes('--coverage') ? COVERAGE_FLAGS : [];

const result = spawnSync(
    process.execPath,
    ['--test', ...coverage, ...passthrough, ...files],
    { stdio: 'inherit' },
);

if (result.error) {
    console.error(`run-tests: could not start Node — ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
