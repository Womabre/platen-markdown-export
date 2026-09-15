#!/usr/bin/env node
/**
 * check-changelog.js — fails when the version about to ship has no CHANGELOG
 * section of its own.
 *
 * The release workflow already refuses a tag that disagrees with package.json.
 * It did not check that anyone had written down what the release contains, so a
 * tag could ship with every change still sitting under `## [Unreleased]` — which
 * is exactly what happens when you cut a release in a hurry, and exactly when
 * the notes matter most.
 *
 * Rolling a release therefore means renaming that heading:
 *
 *     ## [Unreleased]            →   ## [1.1.0] - 2026-09-03
 *
 * and starting a fresh empty `## [Unreleased]` above it.
 *
 * Usage:  node scripts/check-changelog.js [version]
 *         (defaults to package.json's version)
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function fail(message) {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
}

const version = process.argv[2] || require(path.join(ROOT, 'package.json')).version;

if (!fs.existsSync(CHANGELOG)) fail('CHANGELOG.md not found.');
const changelog = fs.readFileSync(CHANGELOG, 'utf8');

// `## [1.2.3]` — optionally followed by a date, a link, or nothing at all.
const heading = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm');

if (!heading.test(changelog)) {
    fail(
        `CHANGELOG.md has no "## [${version}]" section.\n\n` +
        '  Rename the "## [Unreleased]" heading to the version being released:\n\n' +
        `      ## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n` +
        '  and open a fresh, empty "## [Unreleased]" above it.',
    );
}

// A heading with nothing under it is the same omission wearing a hat.
const body = changelog
    .slice(changelog.search(heading))
    .split('\n').slice(1)
    .join('\n')
    .split(/^## /m)[0]
    .trim();

if (!body) fail(`CHANGELOG.md's "## [${version}]" section is empty.`);

console.log(`CHANGELOG has a section for ${version}`);
