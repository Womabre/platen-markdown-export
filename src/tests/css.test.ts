import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setActiveTheme } from '../theme';
import { loadCssTemplate, resolvePaperSize, verticalMarginMm, horizontalMarginMm,
         contentBoxMm, buildPageMetricsCss, pageSizeCss, buildPageCss } from '../css';
import { inlineLocalStylesheet, stripPrintIncompatibleCss } from '../stylesheets';

// See theme.test.ts for why this fixture exists instead of loading a real
// brand theme here.
const FIXTURE = path.join(__dirname, '..', '..', 'test-fixtures', 'theme');

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-test-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('stripPrintIncompatibleCss', () => {
    it('removes prefers-color-scheme @media blocks but keeps surrounding rules', () => {
        const css = 'h1 { color: red; }\n@media (prefers-color-scheme: dark) { body { background: #000; } h1 { color: #fff; } }\np { margin: 0; }';
        const out = stripPrintIncompatibleCss(css);
        assert.doesNotMatch(out, /prefers-color-scheme/);
        assert.doesNotMatch(out, /background: #000/);
        assert.match(out, /h1 \{ color: red; \}/);
        assert.match(out, /p \{ margin: 0; \}/);
    });

    it('removes form-control / unsupported pseudo-element rules', () => {
        const css = '.b [type=number]::-webkit-outer-spin-button { height: auto; }\n.b ::placeholder { color: #999; }\n.b ul:dir(rtl) .x { margin: 0; }\n.b p { color: #333; }';
        const out = stripPrintIncompatibleCss(css);
        assert.doesNotMatch(out, /::-webkit-/);
        assert.doesNotMatch(out, /::placeholder/);
        assert.doesNotMatch(out, /:dir\(/);
        assert.match(out, /\.b p \{ color: #333; \}/);  // ordinary rules survive
    });

    it('strips consecutive incompatible rules, not just the first', () => {
        // The trap in anchoring this pattern to a `}`. Capture the delimiter and
        // the match consumes it, so the NEXT rule has nothing left to anchor on
        // and is silently kept — one rule removed, the rest shipped. A
        // lookbehind asserts the same boundary without eating it.
        const out = stripPrintIncompatibleCss(
            'a::placeholder { x: 1 }\nb::-moz-focus-inner { y: 2 }\nc:dir(rtl) { z: 3 }\np { keep: 1 }',
        );
        assert.doesNotMatch(out, /::placeholder/);
        assert.doesNotMatch(out, /::-moz-/);
        assert.doesNotMatch(out, /:dir\(/);
        assert.match(out, /p \{ keep: 1 \}/);
    });

    it('strips an incompatible rule that follows an ordinary one', () => {
        const out = stripPrintIncompatibleCss('a { x: 1 }\nb::placeholder { y: 2 }\nc { z: 3 }');
        assert.doesNotMatch(out, /::placeholder/);
        assert.match(out, /a \{ x: 1 \}/);
        assert.match(out, /c \{ z: 3 \}/);
    });

    it('scans a large brace-free stylesheet in linear time', () => {
        // This pattern was quadratic: the unanchored leading `[^{}]*?` made the
        // engine retry the whole alternation at every offset, each failure
        // costing O(n). Measured before the fix: 50 ms at 10 KB, 192 ms at
        // 20 KB, 788 ms at 40 KB, 3.4 s at 80 KB. Every theme shipped here is
        // far under that, which is why nothing caught it — but the input is a
        // stylesheet the user points `-s` at, on every save-triggered export.
        const big = 'a'.repeat(200_000) + '::placeholder' + 'b'.repeat(200_000);
        const started = Date.now();
        stripPrintIncompatibleCss(big);
        const elapsed = Date.now() - started;

        // Two orders of magnitude of headroom over the linear cost (~1 ms) and
        // still far under the seconds the quadratic version took at a quarter
        // of this size, so it fails on a regression rather than on a slow runner.
        assert.ok(elapsed < 1000, `took ${elapsed} ms — the scan is quadratic again`);
    });
});

describe('loadCssTemplate', () => {
    it('reads file and wraps in <style> tags', () => {
        const file = path.join(tmpDir, 'test.css');
        fs.writeFileSync(file, 'body { color: red; }');
        const result = loadCssTemplate(file);
        assert.ok(result.startsWith('<style>'));
        assert.ok(result.includes('body { color: red; }'));
        assert.ok(result.endsWith('</style>'));
    });

    it('replaces tokens', () => {
        const file = path.join(tmpDir, 'tokens.css');
        // Token values are substituted verbatim — callers supply CSS-ready strings
        fs.writeFileSync(file, 'content: {{HEADER_CONTENT}};');
        const result = loadCssTemplate(file, { HEADER_CONTENT: '"My Title"' });
        assert.ok(result.includes('content: "My Title";'));
        assert.ok(!result.includes('{{HEADER_CONTENT}}'));
    });

    it('replaces all occurrences of a token', () => {
        const file = path.join(tmpDir, 'multi.css');
        fs.writeFileSync(file, '{{X}} and {{X}}');
        const result = loadCssTemplate(file, { X: 'replaced' });
        assert.equal(result.match(/replaced/g)?.length, 2);
    });

    it('leaves unknown tokens untouched', () => {
        const file = path.join(tmpDir, 'unknown.css');
        fs.writeFileSync(file, '{{UNKNOWN}}');
        const result = loadCssTemplate(file);
        assert.ok(result.includes('{{UNKNOWN}}'));
    });

    it('throws for missing file', () => {
        assert.throws(
            () => loadCssTemplate(path.join(tmpDir, 'nonexistent.css')),
            /CSS template not found/,
        );
    });
});

describe('stripPrintIncompatibleCss — unterminated at-rule', () => {
    // The brace scan can only find the end of a rule that has one. Treating
    // "ran off the end of the file" as "the rule ended here" deleted the whole
    // remainder of the stylesheet.
    it('keeps the rest of the stylesheet when an at-rule never closes', () => {
        const css = 'h1 { color: red; }\n@media (prefers-color-scheme: dark) { body { background: #000; }\np { margin: 0; }';
        const out = stripPrintIncompatibleCss(css);
        assert.match(out, /h1 \{ color: red; \}/, 'rules before the broken one survive');
        assert.match(out, /p \{ margin: 0; \}/, 'rules after the broken one survive');
    });

    it('still strips a well-formed block that follows a good one', () => {
        const css = 'a { color: red; }\n@media (prefers-color-scheme: dark) { b { color: #fff; } }\nc { color: blue; }';
        const out = stripPrintIncompatibleCss(css);
        assert.doesNotMatch(out, /prefers-color-scheme/);
        assert.match(out, /a \{ color: red; \}/);
        assert.match(out, /c \{ color: blue; \}/);
    });
});

// ── inlineLocalStylesheet ─────────────────────────────────────────────────────

describe('inlineLocalStylesheet', () => {
    it('returns unchanged content when stylesheetPath is null', () => {
        const html = '<html><head></head><body></body></html>';
        assert.equal(inlineLocalStylesheet(html, null), html);
    });

    it('returns unchanged content when stylesheet file does not exist', () => {
        const html = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, path.join(tmpDir, 'missing.css'));
        assert.equal(result, html);
    });

    it('injects CSS as a <style> block into <head>', () => {
        const css  = 'body { color: red; }';
        const file = path.join(tmpDir, 'inject.css');
        fs.writeFileSync(file, css);
        const html   = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(result.includes('<style>'));
        assert.ok(result.includes('body { color: red; }'));
    });

    it('resolves a local @import by inlining the imported file', () => {
        const imported = path.join(tmpDir, 'imported.css');
        const main     = path.join(tmpDir, 'main-import.css');
        fs.writeFileSync(imported, '.imported { color: blue; }');
        fs.writeFileSync(main, `@import url("./imported.css");\n.main { color: red; }`);
        const html   = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, main);
        assert.ok(result.includes('.imported { color: blue; }'), 'imported CSS should be inlined');
        assert.ok(result.includes('.main { color: red; }'));
        assert.ok(!result.includes('@import'), 'local @import should be removed');
    });

    it('resolves nested local @imports recursively', () => {
        const deep   = path.join(tmpDir, 'deep.css');
        const mid    = path.join(tmpDir, 'mid.css');
        const top    = path.join(tmpDir, 'top.css');
        fs.writeFileSync(deep, '.deep { font-size: 10px; }');
        fs.writeFileSync(mid,  `@import url("./deep.css");\n.mid { font-size: 12px; }`);
        fs.writeFileSync(top,  `@import url("./mid.css");\n.top { font-size: 14px; }`);
        const html   = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, top);
        assert.ok(result.includes('.deep { font-size: 10px; }'), 'deep nested CSS should be inlined');
        assert.ok(result.includes('.mid { font-size: 12px; }'));
        assert.ok(result.includes('.top { font-size: 14px; }'));
    });

    it('strips Font Awesome and Phosphor remote @imports', () => {
        const css  = [
            '@import url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css");',
            '@import url("https://unpkg.com/@phosphor-icons/web@2.1.1/src/index.css");',
            'body { color: red; }',
        ].join('\n');
        const file = path.join(tmpDir, 'icon-imports.css');
        fs.writeFileSync(file, css);
        const html   = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(!result.includes('font-awesome'), 'FA @import should be stripped');
        assert.ok(!result.includes('phosphor-icons'), 'Phosphor @import should be stripped');
        assert.ok(result.includes('body { color: red; }'), 'normal CSS should remain');
    });

    it('keeps remote @imports that are not icon fonts (e.g. Google Fonts)', () => {
        const css  = '@import url("https://fonts.googleapis.com/css2?family=Roboto&display=swap");\nbody {}';
        const file = path.join(tmpDir, 'google-fonts.css');
        fs.writeFileSync(file, css);
        const html   = '<html><head></head><body></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(result.includes('fonts.googleapis.com'), 'Google Fonts @import should remain');
    });

    // The document mentioning the stylesheet's own filename is not exotic: every
    // shipped theme's stylesheet is named `theme.css`, so any document that
    // documents theming — this project's README included — used to satisfy the
    // old `includes(basename)` guard, match no <link>, and ship with NO CSS while
    // the log still said "Inlined".
    it('still injects the stylesheet when the document only mentions its filename in prose', () => {
        const file = path.join(tmpDir, 'theme.css');
        fs.writeFileSync(file, '.branded { color: rebeccapurple; }');
        const html   = '<html><head></head><body><p>Edit theme.css to change colours.</p></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(result.includes('.branded { color: rebeccapurple; }'), 'CSS must still be inlined');
        assert.ok(result.includes('</head>'), 'the style block goes into <head>');
    });

    it('replaces a real <link> to the stylesheet rather than appending a second copy', () => {
        const file = path.join(tmpDir, 'linked.css');
        fs.writeFileSync(file, '.linked { color: teal; }');
        const html   = '<html><head><link rel="stylesheet" href="linked.css"></head><body></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(!result.includes('<link'), 'the <link> element is consumed');
        assert.equal(result.match(/\.linked \{ color: teal; \}/g)?.length, 1, 'inlined exactly once');
    });

    it('replaces the <link> even when the filename also appears in the body text', () => {
        const file = path.join(tmpDir, 'both.css');
        fs.writeFileSync(file, '.both { color: olive; }');
        const html   = '<html><head><link rel="stylesheet" href="both.css"></head>'
                     + '<body><p>both.css is the stylesheet.</p></body></html>';
        const result = inlineLocalStylesheet(html, file);
        assert.ok(!result.includes('<link'), 'the <link> element is consumed');
        assert.equal(result.match(/\.both \{ color: olive; \}/g)?.length, 1, 'inlined exactly once, not twice');
        assert.ok(result.includes('both.css is the stylesheet.'), 'body prose is untouched');
    });

    it('warns instead of silently dropping the CSS when there is no <head> and no <link>', () => {
        const file = path.join(tmpDir, 'headless.css');
        fs.writeFileSync(file, '.headless { color: maroon; }');
        const html   = '<div><p>fragment with no head, mentioning headless.css</p></div>';
        const result = inlineLocalStylesheet(html, file);
        assert.equal(result, html, 'nothing to inject into — content returned unchanged');
    });
});

// ── Page geometry ─────────────────────────────────────────────────────────────
//
// The cover sizes itself from --page-width/--page-height. Before these existed
// every theme hardcoded 210mm x 297mm, so on A3 the whole cover sat in an
// A4-sized corner of the sheet.

describe('resolvePaperSize', () => {
    it('resolves named sizes case-insensitively', () => {
        assert.deepEqual(resolvePaperSize('A4'), { widthMm: 210, heightMm: 297 });
        assert.deepEqual(resolvePaperSize('a3'), { widthMm: 297, heightMm: 420 });
        assert.deepEqual(resolvePaperSize('Letter'), { widthMm: 216, heightMm: 279 });
    });

    it('defaults to A4 for null or an unknown name', () => {
        assert.deepEqual(resolvePaperSize(null), { widthMm: 210, heightMm: 297 });
        assert.deepEqual(resolvePaperSize('Foolscap'), { widthMm: 210, heightMm: 297 });
    });

    it('accepts the literal "<width> <height>" form the frontmatter also allows', () => {
        assert.deepEqual(resolvePaperSize('297mm 210mm'), { widthMm: 297, heightMm: 210 });
    });

    it('converts non-mm units', () => {
        const inches = resolvePaperSize('8.5in 11in');
        assert.equal(Math.round(inches.widthMm), 216);
        assert.equal(Math.round(inches.heightMm), 279);
    });
});

describe('buildPageMetricsCss', () => {
    it('emits the full sheet as --page-width/--page-height', () => {
        const css = buildPageMetricsCss('A3', null);
        assert.match(css, /--page-width:\s*297mm/);
        assert.match(css, /--page-height:\s*420mm/);
    });

    it('defaults to A4 when no size is given', () => {
        const css = buildPageMetricsCss(null, null);
        assert.match(css, /--page-width:\s*210mm/);
        assert.match(css, /--page-height:\s*297mm/);
    });

    it('derives the usable height from the sheet minus its vertical margins', () => {
        // A4 portrait, 20mm top+bottom, less the 10mm slack for a caption.
        assert.match(buildPageMetricsCss('A4', '20mm'), /--page-usable-height:\s*247mm/);
        // Landscape uses the short edge as its height.
        assert.match(buildPageMetricsCss('A4', '20mm'), /--page-usable-height-landscape:\s*160mm/);
    });
});

describe('verticalMarginMm', () => {
    it('follows the CSS shorthand rules', () => {
        assert.equal(verticalMarginMm('20mm'), 40);              // all sides
        assert.equal(verticalMarginMm('20mm 15mm'), 40);         // vertical horizontal
        assert.equal(verticalMarginMm('10mm 15mm 30mm'), 40);    // top horizontal bottom
        assert.equal(verticalMarginMm('10mm 15mm 30mm 15mm'), 40);
    });

    it('converts other units', () => {
        assert.equal(verticalMarginMm('1cm'), 20);
        assert.equal(Math.round(verticalMarginMm('1in')), 51);
    });
});

// ── Orientation ───────────────────────────────────────────────────────────────

describe('pageSizeCss', () => {
    it('appends the orientation keyword to a named size', () => {
        assert.equal(pageSizeCss('A4', 'portrait'), 'A4 portrait');
        assert.equal(pageSizeCss('A4', 'landscape'), 'A4 landscape');
        assert.equal(pageSizeCss(null, 'landscape'), 'A4 landscape');
    });

    it('swaps a literal W H pair instead, since the keyword is invalid there', () => {
        // Authored width-first, so 210mm 297mm is already portrait.
        assert.equal(pageSizeCss('210mm 297mm', 'portrait'), '210mm 297mm');
        assert.equal(pageSizeCss('210mm 297mm', 'landscape'), '297mm 210mm');
        // And an already-wide pair stays put for landscape.
        assert.equal(pageSizeCss('297mm 210mm', 'landscape'), '297mm 210mm');
        assert.equal(pageSizeCss('297mm 210mm', 'portrait'), '210mm 297mm');
    });
});

describe('buildPageMetricsCss — orientation', () => {
    it('swaps the sheet dimensions for a landscape document', () => {
        const css = buildPageMetricsCss('A4', null, 'landscape');
        assert.match(css, /--page-width:\s*297mm/);
        assert.match(css, /--page-height:\s*210mm/);
    });

    it('keeps portrait dimensions by default', () => {
        const css = buildPageMetricsCss('A4', null);
        assert.match(css, /--page-width:\s*210mm/);
        assert.match(css, /--page-height:\s*297mm/);
    });

    it('points the default usable height at the sheet actually in use', () => {
        // Landscape A4 with 20mm margins: 210 - 40 - 10 slack = 160mm.
        assert.match(buildPageMetricsCss('A4', '20mm', 'landscape'), /--page-usable-height:\s*160mm/);
        assert.match(buildPageMetricsCss('A4', '20mm', 'portrait'),  /--page-usable-height:\s*247mm/);
    });

    it('always exposes both per-orientation caps for the override containers', () => {
        const css = buildPageMetricsCss('A4', '20mm', 'landscape');
        assert.match(css, /--page-usable-height-landscape:\s*160mm/);
        assert.match(css, /--page-usable-height-portrait:\s*247mm/);
    });
});

// ── @page :first without a cover ──────────────────────────────────────────────
//
// `:first` dresses the cover: brand mark instead of the running header, no
// footer logo, author instead of the page number. With `Cover Page: false`
// those landed on the first page of real content, so page one carried a logo
// where every other page had header text, and an empty footer.

describe('buildPageCss — @page :first', () => {
    const base = { title: 'T', header: 'Head', footer: null, date: null,
                   revision: null, status: null, author: 'Someone' };

    function firstBlock(css: string): string {
        const m = /@page :first \{[\s\S]*?\n\}/.exec(css);
        assert.ok(m, '@page :first block should exist');
        return m[0];
    }

    it('dresses the cover when one is generated', () => {
        setActiveTheme(FIXTURE);
        const first = firstBlock(buildPageCss({ ...base, hasCover: true }));
        assert.match(first, /element\(logo-header\)/, 'brand mark in the top-left');
        assert.match(first, /"Someone"/, 'author instead of the page number');
        assert.doesNotMatch(first, /element\(logo-footer\)/, 'no footer logo on the cover');
    });

    it('falls back to ordinary page furniture when there is no cover', () => {
        setActiveTheme(FIXTURE);
        const first = firstBlock(buildPageCss({ ...base, hasCover: false }));
        assert.doesNotMatch(first, /element\(logo-header\)/,
            'page one must not carry the cover brand mark');
        assert.match(first, /"Head"/, 'the running header text, like every other page');
        assert.match(first, /element\(logo-footer\)/, 'the footer logo, like every other page');
        assert.match(first, /counter\(page\)/, 'the page number, like every other page');
    });

    it('defaults to the cover treatment when hasCover is unspecified', () => {
        setActiveTheme(FIXTURE);
        assert.match(firstBlock(buildPageCss(base)), /element\(logo-header\)/);
    });
});

// ── Page content area ─────────────────────────────────────────────────────────

describe('horizontalMarginMm', () => {
    it('doubles a single value', () => {
        assert.equal(horizontalMarginMm('2cm'), 40);
    });

    it('takes the second value of a "vertical horizontal" pair', () => {
        assert.equal(horizontalMarginMm('10mm 25mm'), 50);
    });

    it('takes the middle value of a three-value shorthand, which sets both sides', () => {
        assert.equal(horizontalMarginMm('10mm 25mm 30mm'), 50);
    });

    it('sums right and left of a four-value shorthand', () => {
        assert.equal(horizontalMarginMm('10mm 25mm 30mm 15mm'), 40);
    });

    it('counts an unparseable component as zero rather than NaN', () => {
        assert.equal(horizontalMarginMm('auto'), 0);
    });
});

describe('contentBoxMm', () => {
    it('reproduces the old hardcoded A4 body-image area exactly', () => {
        // The constants this replaced were 170 mm x 220 mm. The common case must
        // not move: those numbers are A4 portrait at the default 2 cm margin.
        assert.deepEqual(contentBoxMm(null, null, 'portrait'), { widthMm: 170, heightMm: 220 });
    });

    it('grows with the paper', () => {
        const a3 = contentBoxMm('A3', null, 'portrait');
        assert.equal(a3.widthMm, 297 - 40);
        assert.equal(a3.heightMm, 420 - 40 - 37);
    });

    it('swaps the sheet in landscape', () => {
        const box = contentBoxMm('A4', null, 'landscape');
        assert.equal(box.widthMm, 297 - 40, 'the long edge is now the width');
        assert.equal(box.heightMm, 210 - 40 - 37);
    });

    it('widens when the document narrows its margins', () => {
        const narrow = contentBoxMm('A4', '10mm', 'portrait');
        assert.equal(narrow.widthMm, 190);
        assert.ok(narrow.widthMm > contentBoxMm('A4', null, 'portrait').widthMm);
    });

    it('accepts a literal "W H" page size', () => {
        assert.equal(contentBoxMm('300mm 400mm', '0mm', 'portrait').widthMm, 300);
    });

    it('never returns a degenerate box, however absurd the margins', () => {
        const box = contentBoxMm('A5', '200mm', 'portrait');
        assert.ok(box.widthMm >= 20 && box.heightMm >= 20);
    });
});
