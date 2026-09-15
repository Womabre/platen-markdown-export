#!/usr/bin/env node
/**
 * bundle.js — stages a fully self-contained copy of the CLI into
 * vscode-extension/bundled/ so the packaged .vsix needs nothing else
 * installed (no workspace dist/index.js, no global npm install).
 *
 * Layout produced (mirrors the repo root so dist/theme.js's
 * `path.join(__dirname, '..', 'themes')` resolution keeps working):
 *   bundled/dist/            compiled CLI (from ../dist)
 *   bundled/themes/          theme assets, sample*.{md,html,pdf} stripped
 *   bundled/node_modules/    production deps, multi-platform sharp binaries
 *
 * WeasyPrint (Python + native libs) and the Playwright Chromium download are
 * NOT bundled — neither ships as an npm package, so they stay a one-time,
 * user-confirmed install triggered from the extension (see extension.ts).
 *
 * Run via `npm run bundle` (or `npm run package`, which runs this first).
 * Requires the CLI to already be built: `npm run build` in the repo root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_DIR    = path.resolve(__dirname, '..');
const ROOT_DIR   = path.resolve(EXT_DIR, '..');
const BUNDLE_DIR = path.join(EXT_DIR, 'bundled');

// Sharp platform binaries to force-install alongside whatever the build host
// naturally resolves, so one .vsix works on any of these at runtime
// (sharp/lib/sharp.js picks the matching folder for the ACTUAL runtime via
// `runtimePlatformArch()` — the others just sit there unused, see its source).
//
// Carrying all five costs ~92 MB, and every user downloads four platforms they
// can never run. `--target <os>-<cpu>` stages and keeps just one, which is what
// the release workflow builds: VS Code has first-class support for
// platform-specific extensions (`vsce package --target`), and the names below
// are exactly vsce's own target strings.
const ALL_SHARP_TARGETS = [
    { os: 'darwin', cpu: 'x64' },
    { os: 'darwin', cpu: 'arm64' },
    { os: 'linux',  cpu: 'x64' },
    { os: 'linux',  cpu: 'arm64' },
    { os: 'win32',  cpu: 'x64' },
];
// Windows' sharp build statically links libvips (no @img/sharp-libvips-win32-*
// package exists); darwin/linux need the matching shared-lib package too.
const needsLibvips = (t) => t.os !== 'win32';

/** `@img/*` package names a set of targets needs, without the `@img/` prefix. */
function sharpPackagesFor(targets) {
    const names = new Set();
    for (const t of targets) {
        names.add(`sharp-${t.os}-${t.cpu}`);
        if (needsLibvips(t)) names.add(`sharp-libvips-${t.os}-${t.cpu}`);
    }
    return names;
}

/**
 * Reads `--target <os>-<cpu>` off the command line.
 *
 * Absent (or `all`) keeps today's behaviour: one universal bundle carrying
 * every platform. Naming one narrows the bundle to it — see
 * {@link narrowSharpToTargets}.
 */
function parseTargets(argv) {
    const i = argv.indexOf('--target');
    if (i === -1) return { targets: ALL_SHARP_TARGETS, narrow: false };

    const spec = argv[i + 1];
    if (!spec || spec === 'all') return { targets: ALL_SHARP_TARGETS, narrow: false };

    const known = ALL_SHARP_TARGETS.find(t => `${t.os}-${t.cpu}` === spec);
    if (!known) {
        throw new Error(`unknown --target "${spec}". Known targets: ${ALL_SHARP_TARGETS.map(t => `${t.os}-${t.cpu}`).join(', ')}`);
    }
    return { targets: [known], narrow: true };
}

/**
 * Drops every sharp platform binary the target does not need.
 *
 * Runs on the finished bundle, **after** the smoke test, and that order is
 * load-bearing: `npm ci` installs the BUILD HOST's binary, the smoke test runs
 * the bundled CLI on the build host, and a cross-target build (packaging
 * win32-x64 on a macOS runner) would have nothing to run if the host's binary
 * had already been deleted. So the bundle proves itself complete, then narrows.
 *
 * `@img/colour` is not a platform package and is left alone.
 */
function narrowSharpToTargets(bundleDir, targets) {
    const imgDir = path.join(bundleDir, 'node_modules', '@img');
    if (!fs.existsSync(imgDir)) return;

    const keep = sharpPackagesFor(targets);
    let freed = 0;
    const removed = [];

    for (const entry of fs.readdirSync(imgDir)) {
        if (keep.has(entry) || !entry.startsWith('sharp-')) continue;
        const dir = path.join(imgDir, entry);
        freed += dirSizeBytes(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(entry);
    }

    for (const name of keep) {
        if (!fs.existsSync(path.join(imgDir, name))) {
            throw new Error(`narrowed to a target whose binary is missing: @img/${name}`);
        }
    }
    log(`narrowed sharp to ${targets.map(t => `${t.os}-${t.cpu}`).join(', ')} — removed ${removed.length} platform package(s), ${bytesToMb(freed)} MB`);
}

/**
 * Packages the CLI reads as FILES rather than requiring as modules. For those,
 * only the listed paths need to ship.
 *
 * mermaid is the whole reason this exists: the npm package is ~70 MB of
 * sources, docs, type declarations and per-diagram modules, and `mermaid.ts`
 * touches exactly one file in it —
 *
 *     require.resolve('mermaid/dist/mermaid.min.js')  →  fs.readFileSync(...)
 *
 * — a self-contained browser bundle that is injected into a Playwright page as
 * text. The package is never `require()`d, so nothing else in it can execute.
 * At 70 MB it was the single largest item in an 84 MB .vsix, for 2.8 MB of
 * actual use. `package.json` stays because `require.resolve()` needs it to
 * resolve the subpath.
 */
const KEEP_ONLY = {
    mermaid: ['package.json', 'dist/mermaid.min.js'],
};

function log(msg) { console.log(`[bundle] ${msg}`); }
function bytesToMb(n) { return (n / (1024 * 1024)).toFixed(1); }
function fail(msg) { console.error(`[bundle] ERROR: ${msg}`); process.exit(1); }

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Copies dist/, skipping .map files (dev-only, not needed to run). */
function copyDist() {
    const src = path.join(ROOT_DIR, 'dist');
    if (!fs.existsSync(src)) {
        fail('dist/ not found at repo root. Run "npm run build" there first.');
    }
    fs.cpSync(src, path.join(BUNDLE_DIR, 'dist'), {
        recursive: true,
        filter: (p) => !p.endsWith('.map'),
    });
    log('copied dist/');

    // dist/index.js and dist/cli.js do `require('../package.json')` for the
    // --version string — needs to exist as dist/'s sibling, same as at the repo root.
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(BUNDLE_DIR, 'package.json'));
}

/**
 * Copies themes/, excluding the generated sample outputs (sample*.md/.html/.pdf
 * and .DS_Store) — those are dev fixtures, not runtime assets, and the sample
 * *.html files alone can be ~20MB each (inlined fonts/images) across 12 themes.
 */
/**
 * Copies assets/ — today the infographic hand-drawn font, which
 * infographic-fonts.ts resolves as `__dirname/../assets/fonts`, so it has to sit
 * beside dist/ here exactly as it does in the repo.
 */
function copyAssets() {
    const src = path.join(ROOT_DIR, 'assets');
    if (!fs.existsSync(src)) fail('assets/ not found at repo root.');
    fs.cpSync(src, path.join(BUNDLE_DIR, 'assets'), { recursive: true });
    log('copied assets/');
}

function copyThemes() {
    const src = path.join(ROOT_DIR, 'themes');
    if (!fs.existsSync(src)) fail('themes/ not found at repo root.');

    const SKIP_RE = /^sample [^/\\]+\.(md|html|pdf)$/i;
    const skippedLinks = [];

    fs.cpSync(src, path.join(BUNDLE_DIR, 'themes'), {
        recursive: true,
        filter: (p) => {
            const base = path.basename(p);
            if (base === '.DS_Store') return false;
            if (SKIP_RE.test(base)) return false;

            // A theme symlinked in from its own repo (see .gitignore) is not part
            // of this package: it is someone else's brand assets, deliberately
            // untracked, and must not be baked into a distributable .vsix. It also
            // breaks the copy outright — cpSync reads a symlinked directory as a
            // file and dies with EISDIR — so this both scopes and unbreaks it.
            if (fs.lstatSync(p).isSymbolicLink()) {
                skippedLinks.push(path.relative(src, p) || base);
                return false;
            }
            return true;
        },
    });

    log('copied themes/ (sample outputs excluded)');
    if (skippedLinks.length)
        log(`skipped symlinked theme(s), not part of this package: ${skippedLinks.join(', ')}`);
}

/** Fresh, production-only node_modules for the build host, via npm ci. */
function installProdDeps(stagingDir) {
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(stagingDir, 'package.json'));
    fs.copyFileSync(path.join(ROOT_DIR, 'package-lock.json'), path.join(stagingDir, 'package-lock.json'));
    log('running "npm ci --omit=dev" for the build host platform...');
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stagingDir, stdio: 'inherit' });
}

/**
 * Fetches one extra platform's optional native package in a throwaway, isolated
 * directory (its own empty package.json, no relation to the CLI's lockfile) and
 * copies the resulting folder into stagingDir/node_modules/@img/<name>.
 *
 * Isolation matters: running repeated `npm install` calls INSIDE stagingDir
 * itself is unsafe here — each call re-resolves against package.json and (a)
 * prunes the @img folder(s) added by the *previous* call as "extraneous" and
 * (b) without --omit=dev on every single call, resurrects devDependencies.
 * A fresh empty-package.json directory per target sidesteps both problems and
 * never touches the already-correct prod tree that `npm ci --omit=dev` produced.
 */
function installExtraPlatformPackage(stagingDir, name, version, target) {
    const dest = path.join(stagingDir, 'node_modules', '@img', name);
    if (fs.existsSync(dest)) return; // build host's own optional dep already covers this platform

    log(`fetching ${name}@${version} for ${target.os}/${target.cpu}...`);
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-bundle-pkg-'));
    try {
        fs.writeFileSync(path.join(isolated, 'package.json'), '{}');
        execFileSync('npm', [
            'install', `@img/${name}@${version}`,
            '--no-save', '--omit=dev', '--no-audit', '--no-fund',
            `--os=${target.os}`, `--cpu=${target.cpu}`,
            '--force', // required to bypass npm's EBADPLATFORM guard when cross-installing
        ], { cwd: isolated, stdio: 'inherit' });

        const fetched = path.join(isolated, 'node_modules', '@img', name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(fetched, dest, { recursive: true });
    } finally {
        fs.rmSync(isolated, { recursive: true, force: true });
    }
}

/**
 * Deletes everything in a package except the given paths (and their ancestors).
 *
 * Ancestors are retained explicitly rather than by prefix-matching, so a keep
 * list of `dist/x.js` removes the other 400 files in `dist/` while leaving the
 * directory itself.
 */
function pruneToPaths(pkgDir, keep) {
    const keepFiles = new Set(keep.map(rel => path.join(pkgDir, ...rel.split('/'))));

    const keepDirs = new Set();
    for (const file of keepFiles) {
        let dir = path.dirname(file);
        while (dir.startsWith(pkgDir) && dir !== pkgDir) { keepDirs.add(dir); dir = path.dirname(dir); }
    }

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (keepFiles.has(full)) continue;
            if (entry.isDirectory() && keepDirs.has(full)) { walk(full); continue; }
            fs.rmSync(full, { recursive: true, force: true });
        }
    };
    walk(pkgDir);

    // A prune that silently removed the one file we came for would ship a bundle
    // that only fails at render time, on the user's machine. Throws rather than
    // exiting, so the helper stays usable (and testable) outside the script.
    for (const file of keepFiles) {
        if (!fs.existsSync(file)) throw new Error(`prune removed a required file: ${file}`);
    }
}

/** Every installed top-level package name, scoped ones as `@scope/name`. */
function installedPackages(nodeModulesDir) {
    const names = [];
    for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!entry.name.startsWith('@')) { names.push(entry.name); continue; }
        for (const scoped of fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
            if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
        }
    }
    return names;
}

/**
 * The set of packages something in the bundle can actually load.
 *
 * Walks out from the CLI's own production dependencies through
 * `dependencies` + `optionalDependencies` + `peerDependencies`. Optional deps
 * matter because sharp declares every platform binary as one, so the
 * cross-platform `@img/*` packages staged by `bundleMultiPlatformSharp` are
 * reachable; peer deps matter because markdown-it-anchor and friends require
 * markdown-it that way.
 *
 * A KEEP_ONLY package is a **leaf**: it is reachable itself, but nothing inside
 * it is followed, because it is read as a file and never `require()`d.
 *
 * Exported for testing — the interesting behaviour is the leaf rule, and it
 * should not need a staged node_modules tree to exercise.
 */
function reachablePackages(rootDeps, manifestDeps, keepOnly = KEEP_ONLY) {
    const reachable = new Set();
    const queue = [...rootDeps];

    while (queue.length) {
        const name = queue.pop();
        if (reachable.has(name)) continue;
        reachable.add(name);
        if (keepOnly[name]) continue;
        queue.push(...manifestDeps(name));
    }
    return reachable;
}

/**
 * Deletes packages nothing in the bundle can load.
 *
 * This exists because of the KEEP_ONLY rule above, one level deeper. Pruning
 * mermaid to `dist/mermaid.min.js` — a self-contained browser bundle injected
 * into a Playwright page as text — orphans its entire dependency tree the
 * moment it lands, since the package is never `require()`d and so nothing in it
 * can pull anything in. But `npm ci --omit=dev` had already installed that tree
 * and nothing removed it: 77 packages and ~41 MB of @mermaid-js/parser,
 * cytoscape, cytoscape-fcose, es-toolkit, dompurify and friends shipped in
 * every .vsix, unreachable from the first byte.
 */
function pruneOrphanedPackages(stagingDir) {
    const nm = path.join(stagingDir, 'node_modules');
    const manifestDeps = (name) => {
        const file = path.join(nm, name, 'package.json');
        if (!fs.existsSync(file)) return [];
        const pkg = readJson(file);
        return [
            ...Object.keys(pkg.dependencies || {}),
            ...Object.keys(pkg.optionalDependencies || {}),
            ...Object.keys(pkg.peerDependencies || {}),
        ];
    };

    const rootDeps  = Object.keys(readJson(path.join(stagingDir, 'package.json')).dependencies || {});
    const reachable = reachablePackages(rootDeps, manifestDeps);

    let freed = 0;
    const removed = [];
    for (const name of installedPackages(nm)) {
        if (reachable.has(name)) continue;
        const dir = path.join(nm, name);
        freed += dirSizeBytes(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(name);
    }

    // A scope directory left behind with nothing in it.
    for (const entry of fs.readdirSync(nm)) {
        const dir = path.join(nm, entry);
        if (entry.startsWith('@') && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0)
            fs.rmSync(dir, { recursive: true, force: true });
    }

    log(`pruned ${removed.length} unreachable package(s), ${bytesToMb(freed)} MB`);
}

/** Applies KEEP_ONLY to the staged tree, reporting what each prune saved. */
function pruneFileOnlyPackages(stagingDir) {
    for (const [pkg, keep] of Object.entries(KEEP_ONLY)) {
        const pkgDir = path.join(stagingDir, 'node_modules', pkg);
        if (!fs.existsSync(pkgDir)) {
            log(`WARNING: ${pkg} not present in the staged tree — nothing to prune`);
            continue;
        }
        const before = dirSizeBytes(pkgDir);
        pruneToPaths(pkgDir, keep);
        const after = dirSizeBytes(pkgDir);
        log(`pruned ${pkg}: ${bytesToMb(before)} MB → ${bytesToMb(after)} MB (kept ${keep.join(', ')})`);
    }
}

function bundleMultiPlatformSharp(stagingDir, targets) {
    const sharpVersion   = readJson(path.join(stagingDir, 'node_modules', 'sharp', 'package.json')).version;
    // All @img/sharp-libvips-* prebuilds share one version; read it off whichever
    // the build host's own arch/OS naturally installed via npm ci above.
    const imgDir = path.join(stagingDir, 'node_modules', '@img');
    const libvipsDirName = fs.existsSync(imgDir)
        ? fs.readdirSync(imgDir).find(d => d.startsWith('sharp-libvips-'))
        : undefined;
    const libvipsVersion = libvipsDirName
        ? readJson(path.join(imgDir, libvipsDirName, 'package.json')).version
        : null;

    for (const target of targets) {
        installExtraPlatformPackage(stagingDir, `sharp-${target.os}-${target.cpu}`, sharpVersion, target);
    }
    if (libvipsVersion) {
        for (const target of targets.filter(needsLibvips)) {
            installExtraPlatformPackage(stagingDir, `sharp-libvips-${target.os}-${target.cpu}`, libvipsVersion, target);
        }
    } else {
        log('WARNING: could not determine sharp-libvips version — darwin/linux targets other than the build host may be missing it.');
    }
}

/**
 * Removes every `node_modules/.bin` directory in the tree (at any depth). These
 * hold symlinks to each package's CLI entry point — irrelevant here since we
 * invoke dist/index.js directly — and `fs.cpSync` copies them as symlinks
 * pointing at the (about-to-be-deleted) staging path, i.e. dangling links that
 * `vsce package` refuses to stat ("currentLevel is undefined for ...").
 */
function stripBinDirs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (!entry.isDirectory()) continue;
        if (entry.name === '.bin') {
            fs.rmSync(full, { recursive: true, force: true });
            continue;
        }
        if (entry.name === 'node_modules' || !entry.name.startsWith('.')) {
            stripBinDirs(full);
        }
    }
}

/**
 * Runs the bundled CLI end to end and fails the build if it cannot.
 *
 * Pruning decides what to DELETE, and a wrong answer does not show up here at
 * all — it shows up as a MODULE_NOT_FOUND on a user's machine, after install,
 * on their own document. So the bundle proves itself before it is packaged.
 *
 * `test-fixtures/pipeline` is the right fixture for this: CI already exports it
 * on every commit, and it deliberately contains no Mermaid, no draw.io, no
 * images and no icon fonts, so this needs no Chromium, no draw.io app and no
 * network. It does exercise includes, KaTeX, highlight.js, front-matter, the
 * theme loader and sharp — i.e. most of what the prune could have broken.
 *
 * Mermaid is the one thing the fixture cannot cover (rendering it would need
 * Chromium), and it is exactly the package KEEP_ONLY prunes, so its bundle file
 * is resolved explicitly the same way `mermaid.ts` resolves it.
 */
function smokeTest() {
    const bundledCli = path.join(BUNDLE_DIR, 'dist', 'index.js');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-bundle-smoke-'));

    try {
        for (const [pkg, keep] of Object.entries(KEEP_ONLY)) {
            for (const rel of keep) {
                execFileSync(process.execPath, ['-e',
                    `require.resolve(${JSON.stringify(`${pkg}/${rel}`)}, { paths: [${JSON.stringify(path.join(BUNDLE_DIR, 'dist'))}] })`,
                ], { stdio: 'pipe' });
            }
        }
        log(`resolved every KEEP_ONLY file from the bundled layout`);

        fs.cpSync(path.join(ROOT_DIR, 'test-fixtures', 'pipeline'), work, { recursive: true });
        const doc = path.join(work, 'document.md');
        execFileSync(process.execPath, [bundledCli, '--no-bump', '--quiet', '--mode', 'html', doc], { stdio: 'pipe' });

        const out = fs.readdirSync(work).filter(f => f.endsWith('.html') && f !== 'expected-html-export.html');
        if (out.length !== 1) throw new Error(`expected one HTML export, got [${out.join(', ')}]`);
        const bytes = fs.statSync(path.join(work, out[0])).size;
        if (bytes < 10_000) throw new Error(`export is implausibly small (${bytes} B) — something did not render`);

        log(`smoke test passed — bundled CLI exported ${out[0]} (${(bytes / 1024).toFixed(0)} KB)`);

        // The fixture deliberately holds no diagram, so it exercises neither the
        // infographic renderer — whose worker and ESM-only dependencies the
        // prune could orphan — nor assets/, which lives outside both dist/ and
        // node_modules and is reached by a relative path. Icons are off, so this
        // still needs no network.
        const hand = path.join(work, 'hand-drawn.md');
        fs.writeFileSync(hand, '---\nTitle: Bundle check\nMode: html\n---\n\n'
            + '```infographic\ninfographic list-grid-badge-card\ndata\n  lists\n    - label Alpha\n'
            + '      desc First\ntheme hand-drawn\n```\n');
        execFileSync(process.execPath,
            [bundledCli, '--no-bump', '--quiet', '--strict', '--infographic-icons', 'none', '--mode', 'html', hand],
            { stdio: 'pipe' });
        const rendered = fs.readFileSync(path.join(work, 'hand-drawn.html'), 'utf8');
        const svg = /class="diagram-figure infographic-figure"><img src="data:image\/svg\+xml;base64,([^"]+)"/.exec(rendered);
        if (!svg) throw new Error('the bundled CLI rendered no infographic figure');
        const decoded = Buffer.from(svg[1], 'base64').toString('utf8');
        if (!decoded.includes('@font-face')) throw new Error('the hand-drawn theme\'s font did not reach the SVG — is assets/fonts/ in the bundle?');

        log('smoke test passed — bundled CLI rendered a hand-drawn infographic with its bundled font');
    } catch (err) {
        const detail = err.stderr ? `\n${err.stderr.toString().trim()}` : '';
        fail(`the bundled CLI failed to run — a prune removed something it needs.${detail}\n  ${err.message}`);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

function main() {
    const { targets, narrow } = parseTargets(process.argv.slice(2));

    log(`repo root: ${ROOT_DIR}`);
    log(narrow
        ? `building for ${targets[0].os}-${targets[0].cpu} only`
        : `building a universal bundle (${ALL_SHARP_TARGETS.length} platforms)`);

    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    fs.mkdirSync(BUNDLE_DIR, { recursive: true });

    copyDist();
    copyThemes();
    copyAssets();

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-bundle-'));
    try {
        installProdDeps(staging);
        bundleMultiPlatformSharp(staging, targets);
        pruneFileOnlyPackages(staging);
        // After KEEP_ONLY, not before: pruning mermaid to one file is what makes
        // its dependency tree unreachable in the first place.
        pruneOrphanedPackages(staging);

        // TypeScript declaration packages are never require()d at runtime — strip
        // them regardless of how they got here. (Belt-and-braces: at least one
        // @types/* package that's dev-only in package.json has been observed
        // missing its "dev" flag in package-lock.json, so `npm ci --omit=dev`
        // alone doesn't reliably exclude it.)
        fs.rmSync(path.join(staging, 'node_modules', '@types'), { recursive: true, force: true });
        stripBinDirs(path.join(staging, 'node_modules'));

        log('moving node_modules into bundled/...');
        fs.cpSync(path.join(staging, 'node_modules'), path.join(BUNDLE_DIR, 'node_modules'), { recursive: true });
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }

    // Before narrowing, so the CLI it exercises still has the build host's own
    // sharp binary to load — see narrowSharpToTargets.
    smokeTest();
    if (narrow) narrowSharpToTargets(BUNDLE_DIR, targets);

    const sizeMb = (dirSizeBytes(BUNDLE_DIR) / (1024 * 1024)).toFixed(1);
    log(`done — bundled/ is ${sizeMb} MB`);
}

function dirSizeBytes(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
    }
    return total;
}

// Only run as a script, so the prune helpers above can be exercised by a test
// (src/tests/bundle.test.ts) without staging a whole node_modules tree. The
// helpers throw; turning that into an exit code is the entry point's job.
if (require.main === module) {
    try {
        main();
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

module.exports = { pruneToPaths, reachablePackages, sharpPackagesFor, parseTargets, ALL_SHARP_TARGETS, KEEP_ONLY };
