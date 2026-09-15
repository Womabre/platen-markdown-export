#!/usr/bin/env node
/**
 * check-versions.js — fails when the VS Code extension's version, or the copy
 * of the CLI bundled inside it, has drifted from the root package.
 *
 * The extension ships its own compiled copy of the CLI under
 * `vscode-extension/bundled/` (see scripts/bundle.js). Nothing previously
 * asserted that the copy matched the source, so a stale bundle could ship
 * silently — the extension reporting one version while running another.
 *
 * Run by `npm run check:versions`, by `prepublishOnly`, and in CI.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

const problems = [];

const root = read('package.json');
const ext  = read('vscode-extension', 'package.json');

if (ext.version !== root.version) {
    problems.push(
        `vscode-extension/package.json is ${ext.version}, root package.json is ${root.version}.\n` +
        '  The extension and the CLI it wraps are released together — set both to the same version.',
    );
}

// Lockfiles carry the version too, and nothing compared them — which is how
// vscode-extension/package-lock.json sat at 0.1.0 while its manifest said 1.0.0.
// A published package whose lockfile disagrees with its manifest is a small lie
// that shows up in every downstream `npm ci`.
for (const [dir, label] of [[[], 'package'], [['vscode-extension'], 'vscode-extension']]) {
    const lockPath = path.join(ROOT, ...dir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) continue;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const manifestVersion = read(...dir, 'package.json').version;
    for (const [where, found] of [['root', lock.version], ['packages[""]', lock.packages?.['']?.version]]) {
        if (found !== undefined && found !== manifestVersion) {
            problems.push(
                `${label}/package-lock.json ${where} is ${found}, its package.json is ${manifestVersion}.\n` +
                '  Run "npm run version:set -- <version>" to set every copy at once.',
            );
        }
    }
}

// The two manifests must agree on TypeScript, not just on the release version.
//
// The root pin is deliberate and constrained: @typescript-eslint/eslint-plugin
// peers `typescript >=4.8.4 <6.1.0`, so the repo is held at TypeScript 6 until
// typescript-eslint ships TS 7 support (see the "hold TypeScript at 6" commit).
// The extension had drifted to ^7.0.2 — the hold was applied to one manifest and
// not the other, leaving two compilers building one codebase. Nothing noticed,
// because the extension is compiled by a different script in a different
// directory. Comparing the majors here is what stops it happening again; exact
// patch versions are allowed to differ, a major is not.
const tsMajor = (spec) => (String(spec).match(/(\d+)/) ?? [])[1];
const rootTs  = root.devDependencies?.typescript;
const extTs   = ext.devDependencies?.typescript;

if (rootTs && extTs && tsMajor(rootTs) !== tsMajor(extTs)) {
    problems.push(
        `vscode-extension/package.json builds with TypeScript ${extTs}, root package.json with ${rootTs}.\n` +
        '  One codebase, one compiler major — the root pin is held by typescript-eslint\'s peer range.',
    );
}

// `@types/vscode` may never exceed `engines.vscode`.
//
// The types say which VS Code API the extension compiles against; the engine
// says the oldest VS Code it claims to run on. Types ahead of the engine means
// the code can call an API that the declared minimum does not have, and `vsce`
// refuses to package it at all:
//
//   ERROR  @types/vscode ^1.136.0 greater than engines.vscode ^1.85.0.
//          Either upgrade engines.vscode or use an older @types/vscode version
//
// Which is a fine backstop, except that nothing in CI runs `vsce` — only
// release.yml does. A grouped Dependabot bump of `@types/vscode` therefore went
// green on every pull-request check and would have failed while cutting a
// release. Raising the floor is a real decision (it drops support for every
// older VS Code), so it belongs in a commit that says so, not in a dependency
// group. Comparing them here is what makes that decision explicit.
const minVersion = (spec) => (String(spec).match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1, 4).map(Number);
const typesVscode   = ext.devDependencies?.['@types/vscode'];
const enginesVscode = ext.engines?.vscode;

if (typesVscode && enginesVscode) {
    const [tMaj, tMin, tPat] = minVersion(typesVscode);
    const [eMaj, eMin, ePat] = minVersion(enginesVscode);
    const ahead = tMaj > eMaj
        || (tMaj === eMaj && tMin > eMin)
        || (tMaj === eMaj && tMin === eMin && tPat > ePat);
    if (ahead) {
        problems.push(
            `vscode-extension/package.json types against @types/vscode ${typesVscode} ` +
            `but declares engines.vscode ${enginesVscode}.\n` +
            '  The types may not be ahead of the engine — vsce refuses to package it, and the\n' +
            '  extension could call an API its own declared minimum does not have. Raise\n' +
            '  engines.vscode deliberately, or hold @types/vscode.',
        );
    }
}

// bundled/ is a build artifact; only check it when it has actually been built.
const bundledPkg = path.join(ROOT, 'vscode-extension', 'bundled', 'package.json');
if (fs.existsSync(bundledPkg)) {
    const bundled = JSON.parse(fs.readFileSync(bundledPkg, 'utf8'));
    if (bundled.version !== root.version) {
        problems.push(
            `vscode-extension/bundled/ carries CLI ${bundled.version}, root package.json is ${root.version}.\n` +
            '  The bundle is stale — re-run "npm run bundle" in vscode-extension/.',
        );
    }
}

if (problems.length) {
    console.error('Version drift:\n');
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
}

console.log(`Versions agree: ${root.version}`);
