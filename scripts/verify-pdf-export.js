#!/usr/bin/env node
/**
 * verify-pdf-export.js — exports a real PDF through WeasyPrint and checks it.
 *
 * The unit suite deliberately never runs WeasyPrint: it has to pass on a cold
 * runner with no external binaries and no network. The consequence was that the
 * one thing this tool exists to do — produce a PDF — was the one thing nothing
 * verified on a commit. `pipeline.test.ts` covers the HTML side against a golden
 * file; this covers the other half of the fork.
 *
 * Reuses `test-fixtures/pipeline/document.md` for the same reason that fixture
 * exists: no Mermaid, no draw.io, no images, no icon fonts, so the check needs
 * WeasyPrint and nothing else — no Chromium download, no network.
 *
 * Run by the `pdf` CI job and by `npm run verify:pdf`. Exits non-zero with a
 * readable message on any failure.
 *
 * Usage:  node scripts/verify-pdf-export.js [--theme <name>] [--all-themes] [--samples]
 *
 * `--samples` renders each theme's own `sample *.md` instead of the fixture.
 * Those twelve documents are the showcase AND the de-facto documentation — they
 * are what a new user copies from — and nothing rendered them on a commit, so a
 * sample that stopped exporting was invisible until somebody tried it. They are
 * heavy in a way the fixture deliberately is not (Mermaid needs Chromium,
 * draw.io needs an Electron app, icon fonts and emoji need the network), which
 * is why this is a scheduled job rather than part of every pull request.
 *
 * `--all-themes` renders the same fixture through every shipped theme. Thirteen
 * themes ship and only one of them was ever rendered on a commit — cover.test.ts
 * asserts each theme's cover TEMPLATE carries the right token slots, but a
 * template can hold every slot and still fail to lay out, and nothing caught
 * that. Themes symlinked into `themes/` from elsewhere are skipped: they are not
 * in the checkout, so CI does not have them and cannot be asked to render them.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const zlib = require('zlib');
const os   = require('os');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const CLI      = path.join(ROOT, 'dist', 'index.js');
const THEMES   = path.join(ROOT, 'themes');
const FIXTURE  = path.join(ROOT, 'test-fixtures', 'pipeline', 'document.md');
/** Cover page plus at least one page of content — a one-page result means the body was dropped. */
const MIN_PAGES = 2;

/**
 * Themes this repository actually ships.
 *
 * Real directories only. `listThemes()` deliberately follows symlinks, because
 * an externally linked theme is a fine one to *use* — but it is not in the
 * checkout, so CI does not have it and rendering it here would pass locally and
 * fail on a runner.
 */
function shippedThemes() {
    return fs.readdirSync(THEMES, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.isSymbolicLink()
            && fs.existsSync(path.join(THEMES, d.name, 'theme.json')))
        .map(d => d.name)
        .sort();
}

/**
 * Asserts the PDF's Info dictionary carries a document title.
 *
 * No `<title>` was emitted for any document, so every export produced a PDF
 * whose Document Properties were blank — the field a reader shows in its window,
 * a DMS indexes on, and PDF/UA requires. The fix is two lines in the pipeline and
 * would be just as quiet if it regressed, which is why this sits beside the
 * page-count check rather than in a unit test alone.
 *
 * Two things make this fiddlier than it sounds, and both cost a wrong answer
 * before they were handled.
 *
 * WeasyPrint Flate-compresses its object streams, so the Info dictionary is not
 * in the raw bytes at all — every deflate stream is inflated first, the same
 * approach `countPdfPages` takes for the page tree.
 *
 * And `/Title` is not unique: every PDF outline entry has one, generated from a
 * heading. Searching for the token alone therefore passes on a PDF with no
 * document title whatsoever — verified by removing the fix and watching this
 * check stay green. The Info dictionary is the one carrying `/Producer`, so the
 * assertion looks for `/Title` in that dictionary's neighbourhood rather than
 * anywhere in the file.
 */
function assertHasTitle(buffer, label) {
    const blobs = [buffer];
    const raw   = buffer.toString('latin1');
    const re    = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const end = buffer.indexOf('endstream', m.index);
        if (end === -1) continue;
        try { blobs.push(zlib.inflateSync(buffer.subarray(m.index + m[0].length, end))); }
        catch { /* not a deflate stream */ }
    }
    const hay = Buffer.concat(blobs).toString('latin1');

    const producer = hay.indexOf('/Producer');
    if (producer === -1) {
        // No Info dictionary found at all — report it rather than pass quietly.
        fail(`${label}: the PDF has no Info dictionary, so its metadata cannot be checked.`);
    }

    const infoDict = hay.slice(Math.max(0, producer - 400), producer + 400);
    if (!/\/Title\s*[(<]/.test(infoDict)) {
        fail(`${label}: the PDF's Info dictionary carries no /Title — document metadata was not written.`,
             'The pipeline should emit <title> from the frontmatter Title; see injectDocumentMetadata.');
    }
}

function fail(message, detail) {
    console.error(`\n✖ ${message}`);
    if (detail) console.error(String(detail).trimEnd().split('\n').map(l => `    ${l}`).join('\n'));
    process.exit(1);
}

/** The theme's own sample document, or null when it has none. */
function sampleFor(theme) {
    const dir = path.join(THEMES, theme);
    const name = fs.readdirSync(dir).find(f => f.startsWith('sample ') && f.endsWith('.md'));
    return name ? path.join(dir, name) : null;
}

/**
 * Exports one document and asserts the PDF is real. Returns its page count and size.
 *
 * @param theme  Theme to force, or null for the document's own.
 * @param input  Document to export; defaults to the pipeline fixture.
 */
function verifyOnce(theme, outDir, input = FIXTURE) {
    const label  = theme ? `theme "${theme}"` : 'the default theme';
    const outPdf = path.join(outDir, `verify-${theme ?? 'default'}.pdf`);

    // --no-bump so the check never edits the document; --output so nothing
    // lands next to it either. A sample declares its own Theme, so --theme is
    // only passed when this run is forcing one.
    const args = [CLI, '--mode', 'pdf', '--no-bump', '--output', outPdf];
    if (theme) args.push('--theme', theme);
    args.push(input);

    try {
        execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
    } catch (err) {
        fail(`the export failed for ${label} (exit ${err.status ?? '?'}).`,
             err.status === 4 ? 'Exit 4 is WeasyPrint — is it installed and runnable?' : '');
    }

    if (!fs.existsSync(outPdf)) fail(`${label}: the export reported success but wrote no PDF.`);

    const buffer = fs.readFileSync(outPdf);
    if (buffer.length === 0) fail(`${label}: the PDF is empty.`);
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
        fail(`${label}: the output does not start with the %PDF- signature.`);

    // countPdfPages returns null when it cannot establish a count, so this
    // asserts the page tree is readable as well as present.
    const { countPdfPages } = require(path.join(ROOT, 'dist', 'pdfinfo.js'));
    const pages = countPdfPages(buffer);
    if (pages === null) fail(`${label}: the page count could not be read — the page tree is unreadable.`);
    if (pages < MIN_PAGES)
        fail(`${label}: the PDF has ${pages} page(s); expected at least ${MIN_PAGES} (cover + content).`);

    assertHasTitle(buffer, label);

    return { pages, kb: Number((buffer.length / 1024).toFixed(0)) };
}

/**
 * Whether WeasyPrint is installed, asked the same way the CLI asks.
 *
 * Imported from the built CLI rather than re-implemented: a second copy of the
 * discovery paths would be a second thing to keep in step with `bootstrap.ts`.
 */
function weasyprintAvailable() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return Boolean(require(path.join(ROOT, 'dist', 'bootstrap.js')).findWeasyprint());
    } catch {
        return false;
    }
}

function main() {
    if (!fs.existsSync(CLI)) fail(`${path.relative(ROOT, CLI)} not found — run "npm run build" first.`);
    if (!fs.existsSync(FIXTURE)) fail(`fixture missing: ${path.relative(ROOT, FIXTURE)}`);

    const argv     = process.argv.slice(2);
    const samples  = argv.includes('--samples');
    const allFlag  = argv.includes('--all-themes');

    // Skip, loudly, on a machine with no WeasyPrint — but only when the caller
    // has not demanded it.
    //
    // This check is the only thing that exercises real PDF output, and it was
    // effectively CI-only: nothing prompted anyone to run it locally, so a
    // rendering regression reached CI before its author saw it. Making it part
    // of `npm run check` needs it to degrade on a contributor's machine that has
    // never run `--setup`. CI passes `--require` so a runner whose WeasyPrint
    // install silently vanished fails instead of quietly verifying nothing.
    if (!weasyprintAvailable()) {
        if (argv.includes('--require')) {
            fail('WeasyPrint was not found, and --require was given.',
                 'CI installs it explicitly; if this fired on a runner, that step did not work.');
        }
        console.log('\n⊘ Skipped: WeasyPrint is not installed, so the PDF export was not verified.');
        console.log('  Install it with "node dist/index.js --setup" to run this check locally.');
        console.log('  CI runs it with --require, so this is never skipped there.\n');
        return;
    }

    if (samples) {
        const outDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-verify-samples-'));
        const results = [];
        try {
            for (const theme of shippedThemes()) {
                const doc = sampleFor(theme);
                if (!doc) fail(`theme "${theme}" ships no sample document.`);
                // No --theme: the sample names its own, which is part of what
                // this checks. Its Style, logos and page geometry come with it.
                results.push([`${theme} (sample)`, verifyOnce(null, outDir, doc)]);
            }
        } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
        console.log('');
        for (const [name, { pages, kb }] of results)
            console.log(`✔ Sample verified — ${name}: ${pages} pages, ${kb} KB`);
        console.log('');
        return;
    }

    const themeArg = argv[argv.indexOf('--theme') + 1];
    const themes   = allFlag ? shippedThemes()
                   : argv.includes('--theme') ? [themeArg]
                   : [null];

    if (allFlag && themes.length === 0) fail('--all-themes found no themes to render.');
    if (argv.includes('--theme') && !themeArg) fail('--theme needs a value.');

    const outDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-verify-pdf-'));
    const results = [];

    try {
        for (const theme of themes) results.push([theme ?? 'default', verifyOnce(theme, outDir)]);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }

    console.log('');
    for (const [name, { pages, kb }] of results)
        console.log(`✔ PDF export verified — ${name}: ${pages} pages, ${kb} KB`);
    console.log('');
}

main();
