import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { escHtml, parseImageSpec, extractFrontmatter, isReleasedStatus, stampRevisionDate,
         bumpRevisionAfterExport, yamlQuote, yamlScalar, setLastRevisionRemarks,
         resolveRevision, frontmatterTemplate } from '../frontmatter';
import { loadTheme } from '../theme';
import frontMatter from 'front-matter';

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-fm-test-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMd(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

describe('escHtml', () => {
    it('escapes ampersands', () => {
        assert.equal(escHtml('a & b'), 'a &amp; b');
    });

    it('escapes angle brackets', () => {
        assert.equal(escHtml('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
    });

    it('escapes double quotes', () => {
        assert.equal(escHtml('"quoted"'), '&quot;quoted&quot;');
    });

    it('leaves plain text unchanged', () => {
        assert.equal(escHtml('hello world'), 'hello world');
    });

    it('coerces non-strings', () => {
        assert.equal(escHtml(42 as unknown as string), '42');
    });
});

describe('parseImageSpec', () => {
    it('returns default position for plain path', () => {
        assert.deepEqual(parseImageSpec('assets/hero.webp'), { src: 'assets/hero.webp', position: 0.5 });
    });

    it('parses position percentage', () => {
        const result = parseImageSpec('assets/hero.webp position: 30%');
        assert.equal(result.src, 'assets/hero.webp');
        assert.ok(Math.abs(result.position - 0.7) < 0.001);
    });

    it('returns null src for null input', () => {
        assert.deepEqual(parseImageSpec(null), { src: null, position: 0.5 });
    });

    it('returns null src for undefined input', () => {
        assert.deepEqual(parseImageSpec(undefined), { src: null, position: 0.5 });
    });
});

// ── extractFrontmatter ────────────────────────────────────────────────────────

describe('extractFrontmatter', () => {
    it('returns empty defaults for null input', () => {
        const fm = extractFrontmatter(null);
        assert.equal(fm.title, '');
        assert.equal(fm.lang, 'en');
        assert.equal(fm.mode, null);
        assert.equal(fm.revision, null);
        assert.equal(fm.theme, null);
        assert.deepEqual(fm.revisions, []);
        assert.deepEqual(fm.documentInfo, []);
    });

    it('returns empty defaults when the file does not exist', () => {
        const fm = extractFrontmatter(path.join(tmpDir, 'ghost.md'));
        assert.equal(fm.title, '');
        assert.equal(fm.revision, null);
    });

    it('extracts Title (uppercase key)', () => {
        const f = writeMd('title-upper.md', '---\nTitle: My Document\n---\n# Body\n');
        assert.equal(extractFrontmatter(f).title, 'My Document');
    });

    it('extracts title (lowercase key)', () => {
        const f = writeMd('title-lower.md', '---\ntitle: Lower Title\n---\n');
        assert.equal(extractFrontmatter(f).title, 'Lower Title');
    });

    it('extracts mode and lowercases it', () => {
        const f = writeMd('mode.md', '---\nMode: PDF\n---\n');
        assert.equal(extractFrontmatter(f).mode, 'pdf');
    });

    it('returns null mode when mode field is absent', () => {
        const f = writeMd('no-mode.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).mode, null);
    });

    it('extracts lang (defaults to en when absent)', () => {
        const f = writeMd('no-lang.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).lang, 'en');
    });

    it('extracts lang when specified', () => {
        const f = writeMd('lang-nl.md', '---\nlang: nl\n---\n');
        assert.equal(extractFrontmatter(f).lang, 'nl');
    });

    it('extracts header and footer', () => {
        const f = writeMd('hf.md', '---\nHeader: My Header\nFooter: My Footer\n---\n');
        const fm = extractFrontmatter(f);
        assert.equal(fm.header, 'My Header');
        assert.equal(fm.footer, 'My Footer');
    });

    it('extracts standalone Revision field', () => {
        const f = writeMd('rev.md', '---\nRevision: "1.2"\n---\n');
        assert.equal(extractFrontmatter(f).revision, '1.2');
    });

    it('extracts author, date, status from top-level fields', () => {
        // Quote the date so the YAML parser treats it as a string, not a Date object.
        const f = writeMd('meta.md', '---\nAuthor: Jane Doe\nDate: "2026-01-15"\nStatus: Draft\n---\n');
        const fm = extractFrontmatter(f);
        assert.equal(fm.author, 'Jane Doe');
        assert.equal(fm.date, '2026-01-15');
        assert.equal(fm.status, 'Draft');
    });

    it('extracts Document Info fields', () => {
        const f = writeMd('docinfo.md', '---\nDocument Info:\n  Project: Alpha\n  Version: "2.0"\n---\n');
        const fm = extractFrontmatter(f);
        assert.ok(fm.documentInfo.some(e => e.label === 'Project' && e.value === 'Alpha'));
        assert.ok(fm.documentInfo.some(e => e.label === 'Version' && e.value === '2.0'));
    });

    it('prefers revision from Document Info over standalone Revision', () => {
        const f = writeMd('rev-priority.md', [
            '---',
            'Revision: "standalone"',
            'Document Info:',
            '  Revision: "from-info"',
            '---',
        ].join('\n'));
        assert.equal(extractFrontmatter(f).revision, 'from-info');
    });

    // There used to be two revision resolvers: this one, and a second copy in
    // markdown.ts for included files, which ordered the sources differently —
    // a top-level `Revision` ahead of the newest `Revisions` row instead of
    // behind it. A document carrying both reported one number as itself and
    // stamped the other on its own heading when included elsewhere. These pin
    // the order so the single shared function cannot drift back.
    it('prefers the newest Revisions row over a top-level Revision', () => {
        const f = writeMd('rev-conflict.md', [
            '---',
            'Revision: "2"',
            'Revisions:',
            '  - {Revision: "5", Date: 2025-01-01}',
            '---',
        ].join('\n'));
        assert.equal(extractFrontmatter(f).revision, '5');
    });

    it('resolves a document and the same document included identically', () => {
        const attrs = { Revision: '2', Revisions: [{ Revision: '5' }] };
        const f = writeMd('rev-same.md', [
            '---', 'Revision: "2"', 'Revisions:', '  - {Revision: "5"}', '---',
        ].join('\n'));
        // The include path calls resolveRevision directly; the export path goes
        // through extractFrontmatter. Both must land on the same string.
        assert.equal(resolveRevision(attrs), extractFrontmatter(f).revision);
    });

    it('skips an empty Revisions row rather than resolving to an empty string', () => {
        assert.equal(resolveRevision({ Revision: '3', Revisions: [{ Date: '2025-01-01' }] }), '3');
        assert.equal(resolveRevision({ Revisions: [{ Revision: '' }] }), null);
    });

    it('falls back to latest Revisions entry when no explicit revision', () => {
        const f = writeMd('rev-fallback.md', [
            '---',
            'Revisions:',
            '  - Revision: "A"',
            '    Date: 2025-01-01',
            '    Author: Alice',
            '    Remarks: first',
            '  - Revision: "B"',
            '    Date: 2025-06-01',
            '    Author: Bob',
            '    Remarks: second',
            '---',
        ].join('\n'));
        assert.equal(extractFrontmatter(f).revision, 'B');
    });

    it('extracts the full Revisions array', () => {
        const f = writeMd('revisions.md', [
            '---',
            'Revisions:',
            '  - Revision: "1.0"',
            '    Date: 2025-01-01',
            '    Author: Alice',
            '    Remarks: initial',
            '---',
        ].join('\n'));
        const { revisions } = extractFrontmatter(f);
        assert.equal(revisions.length, 1);
        assert.equal(revisions[0].revision, '1.0');
        assert.equal(revisions[0].author, 'Alice');
    });

    it('extracts revisionsVisible (defaults to 3)', () => {
        const f = writeMd('rv-default.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).revisionsVisible, 3);
    });

    it('extracts a custom revisionsVisible value', () => {
        const f = writeMd('rv-custom.md', '---\nRevisions Visible: 5\n---\n');
        assert.equal(extractFrontmatter(f).revisionsVisible, 5);
    });

    it('falls back to the default for a non-numeric revisionsVisible', () => {
        const f = writeMd('rv-nan.md', '---\nRevisions Visible: all\n---\n');
        assert.equal(extractFrontmatter(f).revisionsVisible, 3);
    });

    it('extracts a string Theme (brand package) and a string Style', () => {
        const f = writeMd('theme-str.md', '---\nTheme: modern\nStyle: Cherry\n---\n');
        const fm = extractFrontmatter(f);
        assert.equal(fm.theme, 'modern');
        assert.equal(fm.style, 'Cherry');
    });

    it('extracts an object Style with color and image', () => {
        const f = writeMd('style-obj.md', [
            '---',
            'Style:',
            '  Color: "#009146"',
            '  Image: assets/hero.webp',
            '---',
        ].join('\n'));
        const style = extractFrontmatter(f).style as { color: string; image: string };
        assert.equal(style.color, '#009146');
        assert.equal(style.image, 'assets/hero.webp');
    });

    it('extracts Style position as a fraction when given a percentage', () => {
        const f = writeMd('style-pos.md', [
            '---',
            'Style:',
            '  Color: "#000"',
            '  Position: 30%',
            '---',
        ].join('\n'));
        const style = extractFrontmatter(f).style as { position: number };
        // 30% → (100 - 30) / 100 = 0.7
        assert.ok(Math.abs(style.position - 0.7) < 0.001, `expected 0.7, got ${style.position}`);
    });

    it('extracts Cover Logo as a plain string', () => {
        const f = writeMd('logo-str.md', '---\nCover Logo: path/to/logo.png\n---\n');
        const cl = extractFrontmatter(f).coverLogo;
        assert.ok(cl !== null);
        assert.equal(cl!.path, 'path/to/logo.png');
        assert.equal(cl!.background, null);
    });

    it('extracts Cover Logo with Path and Background', () => {
        const f = writeMd('logo-arr.md', [
            '---',
            'Cover Logo:',
            '  - Path: assets/logo.svg',
            '  - Background: "#ffffff"',
            '---',
        ].join('\n'));
        const cl = extractFrontmatter(f).coverLogo;
        assert.ok(cl !== null);
        assert.equal(cl!.path, 'assets/logo.svg');
        assert.equal(cl!.background, '#ffffff');
    });

    it('extracts Cover Title Color', () => {
        const f = writeMd('title-color.md', '---\nCover Title Color: "#FFD84D"\n---\n');
        assert.equal(extractFrontmatter(f).coverTitleColor, '#FFD84D');
    });

    it('accepts the British spelling and a bare palette name', () => {
        const f = writeMd('title-colour.md', '---\nCover Title Colour: Grey\n---\n');
        assert.equal(extractFrontmatter(f).coverTitleColor, 'Grey');
    });

    it('returns null coverTitleColor when the field is absent', () => {
        const f = writeMd('no-title-color.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).coverTitleColor, null);
    });

    it('returns null coverLogo when the field is absent', () => {
        const f = writeMd('no-logo.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).coverLogo, null);
    });
});

// ── PDF Variant ──────────────────────────────────────────────────────────────

describe('PDF Variant frontmatter field', () => {
    it('extracts a valid PDF/A conformance level', () => {
        const f = writeMd('variant-valid.md', '---\nPDF Variant: pdf/a-2b\n---\n');
        assert.equal(extractFrontmatter(f).pdfVariant, 'pdf/a-2b');
    });

    it('lower-cases the value, matching WeasyPrint\'s own lowercase enum', () => {
        const f = writeMd('variant-case.md', '---\nPDF Variant: PDF/A-2B\n---\n');
        assert.equal(extractFrontmatter(f).pdfVariant, 'pdf/a-2b');
    });

    it('accepts PDF/UA and PDF/X levels too', () => {
        const f = writeMd('variant-ua.md', '---\nPDF Variant: pdf/ua-1\n---\n');
        assert.equal(extractFrontmatter(f).pdfVariant, 'pdf/ua-1');
    });

    it('returns null (an ordinary PDF) when the field is absent', () => {
        const f = writeMd('variant-absent.md', '---\ntitle: X\n---\n');
        assert.equal(extractFrontmatter(f).pdfVariant, null);
    });

    it('ignores a value WeasyPrint does not recognise, rather than passing it through', () => {
        const f = writeMd('variant-bad.md', '---\nPDF Variant: pdf/a-99z\n---\n');
        assert.equal(extractFrontmatter(f).pdfVariant, null);
    });
});

// ── Cover / footer overrides ──────────────────────────────────────────────────

describe('cover and footer overrides', () => {
    function fm(yaml: string) {
        const f = path.join(tmpDir, `ovr-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(f, `---\n${yaml}\n---\n\n# Body\n`);
        return extractFrontmatter(f);
    }

    it('defaults to a cover page and no overrides', () => {
        const d = fm('Title: T');
        assert.equal(d.coverPage, true);
        assert.equal(d.footerLogo, null);
        assert.equal(d.coverSlogan, null);
        assert.equal(d.coverAddress, null);
        assert.equal(d.coverFooterLogo, null);
    });

    it('Cover Page: false suppresses the cover', () => {
        assert.equal(fm('Cover Page: false').coverPage, false);
        assert.equal(fm('Cover Page: true').coverPage, true);
    });

    it('reads false / no / none / off as "remove"', () => {
        for (const v of ['false', 'no', 'none', 'off', 'FALSE']) {
            assert.equal(fm(`Footer Logo: ${v}`).footerLogo, false, v);
        }
    });

    it('reads any other string as a replacement', () => {
        assert.equal(fm('Footer Logo: Cherry').footerLogo, 'Cherry');
        assert.equal(fm('Cover Slogan: Engineering, delivered.').coverSlogan, 'Engineering, delivered.');
    });

    it('joins a YAML list address into lines', () => {
        assert.equal(
            fm('Cover Address:\n  - Acme B.V.\n  - Industrieweg 12').coverAddress,
            'Acme B.V.\nIndustrieweg 12',
        );
    });

    it('treats an empty address list as removal', () => {
        assert.equal(fm('Cover Address: []').coverAddress, false);
    });

    it('treats `true` as "keep the theme default"', () => {
        assert.equal(fm('Cover Slogan: true').coverSlogan, null);
    });
});

// ── Released-status vocabulary ────────────────────────────────────────────────

describe('released status is one vocabulary, not three', () => {
    const doc = (status: string) => [
        '---',
        'Title: T',
        `Status: ${status}`,
        'Revisions:',
        '  - Revision: 1',
        '    Date: "2020-01-01"',
        '    Author: W',
        '---',
        '',
        '# T',
    ].join('\n');

    const TODAY = new Date('2026-09-02T12:00:00Z');
    const stampedToday = (status: string) => /2026-09-02/.test(stampRevisionDate(doc(status), TODAY));

    it('recognises both spellings of released', () => {
        assert.equal(isReleasedStatus('Released'), true);
        assert.equal(isReleasedStatus('Vrijgegeven'), true);
        assert.equal(isReleasedStatus('  vrijgegeven  '), true);
        assert.equal(isReleasedStatus('Final'), false);
        assert.equal(isReleasedStatus(null), false);
    });

    it('stamps the revision date for a Dutch released document', () => {
        // The bug this locks down: `isReleasedStatus` knew about Vrijgegeven,
        // but stampRevisionDate and bumpRevisionAfterExport each hardcoded the
        // English string — so a Dutch document had its watermark suppressed for
        // being released, then was never dated and never bumped.
        assert.equal(stampedToday('Vrijgegeven'), true);
    });

    it('still stamps for the English spellings', () => {
        assert.equal(stampedToday('Released'), true);
        assert.equal(stampedToday('Work In Progress'), true);
        assert.equal(stampedToday('work in progress'), true);
    });

    it('leaves a document with any other status alone', () => {
        assert.equal(stampedToday('Final'), false);
        assert.equal(stampedToday('Draft'), false);
    });
});

// ── Appending a revisions row ─────────────────────────────────────────────────

describe('yamlQuote', () => {
    it('quotes a plain value', () => {
        assert.equal(yamlQuote('Jane Doe'), '"Jane Doe"');
    });

    it('escapes the two characters a double-quoted scalar cares about', () => {
        assert.equal(yamlQuote('say "hi"'), '"say \\"hi\\""');
        assert.equal(yamlQuote('a\\b'), '"a\\\\b"');
    });

    it('leaves everything else as ordinary text', () => {
        // The point of quoting: none of these mean anything once quoted.
        assert.equal(yamlQuote('Smith, John: PDM'), '"Smith, John: PDM"');
        assert.equal(yamlQuote('{a}'), '"{a}"');
        assert.equal(yamlQuote('- x #y'), '"- x #y"');
    });

    it('keeps an empty value a string rather than YAML null', () => {
        assert.equal(yamlQuote(''), '""');
    });
});

describe('the release bump writes YAML that still parses', () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pme-bump-'));

    /** A released document whose last revisions row carries `author`. */
    const doc = (author: string, inline = false) => [
        '---',
        'Title: T',
        'Status: Released',
        'Revisions:',
        inline
            ? `  - {Revision: 1, Date: "2020-01-01", Author: ${author}, Remarks: first}`
            : `  - Revision: 1\n    Date: "2020-01-01"\n    Author: ${author}`,
        '---',
        '',
        '# T',
    ].join('\n');

    /** Bumps `content` in a temp file and returns what was written. */
    const bump = (content: string): string => {
        const dir  = tmp();
        const file = path.join(dir, 'doc.md');
        fs.writeFileSync(file, content);
        try {
            const fm = extractFrontmatter(file);
            bumpRevisionAfterExport(file, fm);
            return fs.readFileSync(file, 'utf8');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    it('survives an author whose name contains a colon', () => {
        // Unquoted, `Author: Smith, John: PDM` is not a YAML scalar — the whole
        // frontmatter stops parsing, on the export that cut the release.
        const out = bump(doc('"Smith, John: PDM"'));
        const parsed = frontMatter(out) as { attributes: Record<string, unknown> };
        assert.ok(Array.isArray(parsed.attributes.Revisions), 'frontmatter still parses');
        assert.equal((parsed.attributes.Revisions as Array<Record<string, unknown>>).length, 2);
    });

    it('quotes the author it copies into the new row', () => {
        assert.match(bump(doc('Jane Doe')), /Author: "Jane Doe"/);
    });

    it('does the same inside the inline row form', () => {
        const out = bump(doc('"Smith, John: PDM"', true));
        const parsed = frontMatter(out) as { attributes: Record<string, unknown> };
        const revs = parsed.attributes.Revisions as Array<Record<string, unknown>>;
        assert.equal(revs.length, 2, 'the flow mapping is still a mapping');
        assert.equal(revs[1].Author, 'Smith, John: PDM');
    });

    it('still reads the date and revision back as it wrote them', () => {
        const out = bump(doc('Jane Doe'));
        const revs = (frontMatter(out) as { attributes: Record<string, unknown> })
            .attributes.Revisions as Array<Record<string, unknown>>;
        assert.equal(String(revs[1].Revision), '2');
        assert.equal(revs[1].Author, 'Jane Doe');
    });
});

// ── The `--init` scaffold ─────────────────────────────────────────────────────

describe('frontmatterTemplate', () => {
    /** The frontmatter keys a template declares, comments and nesting ignored. */
    const keysOf = (block: string): string[] =>
        block.split('\n')
            .filter(l => /^[A-Z]/.test(l))          // top-level, uncommented
            .map(l => l.split(':')[0].trim())
            .sort();

    it('parses as the frontmatter the exporter actually reads', () => {
        // A scaffold that does not round-trip through the parser is worse than
        // no scaffold: whoever follows it cannot tell whose fault the error is.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-init-'));
        try {
            const f = path.join(dir, 'scaffold.md');
            fs.writeFileSync(f, frontmatterTemplate('2026-01-02') + '\n# Heading\n', 'utf8');
            const fm = extractFrontmatter(f);

            assert.equal(fm.title, 'Document Title');
            assert.equal(fm.author, 'Your Name');
            assert.equal(fm.revision, '1');
            assert.equal(fm.date, '2026-01-02');
            assert.equal(fm.status, 'Work In Progress');
            // Normalised: lowercased with whitespace stripped, so `Mode: pdf, html`
            // reaches the exporter as the two modes it names.
            assert.equal(fm.mode, 'pdf,html');
            assert.equal(fm.theme, 'default');
            assert.equal(fm.style, 'Navy');
            assert.equal(fm.revisionsVisible, 3);
            assert.equal(fm.revisions.length, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names a theme and a style that exist', () => {
        // `Style: Navy` is only useful if the `default` theme still has a Navy.
        // Nothing else would notice it being renamed.
        const theme = loadTheme('default');
        assert.ok(Object.keys(theme.styles).includes('Navy'),
                  `default theme styles: ${Object.keys(theme.styles).join(', ')}`);
    });

    it('is deterministic for a given date', () => {
        assert.equal(frontmatterTemplate('2026-01-02'), frontmatterTemplate('2026-01-02'));
        assert.ok(frontmatterTemplate('2026-01-02').includes('Date: "2026-01-02"'));
    });

    // Two copies that must agree, with something that fails when they stop —
    // the same arrangement `check:versions` makes for the two manifests. The
    // extension compiles as its own package and inserts this into an editor
    // buffer rather than a file, so it cannot import the canonical one.
    it('declares the same keys as the VS Code extension\'s copy', () => {
        const core = fs.readFileSync(
            path.join(__dirname, '..', '..', 'vscode-extension', 'src', 'core.ts'), 'utf8');

        const body = /export function frontmatterTemplate[\s\S]*?\n\}/.exec(core);
        assert.ok(body, 'the extension should still carry a frontmatterTemplate');

        // The quoted lines of its array literal, unescaped back to plain text.
        const extensionKeys = [...body[0].matchAll(/^\s*[`'"](.*?)[`'"],\s*$/gm)]
            .map(m => m[1])
            .filter(l => /^[A-Z]/.test(l))
            .map(l => l.split(':')[0].trim())
            .sort();

        assert.deepEqual(keysOf(frontmatterTemplate('2026-01-02')), extensionKeys);
    });
});

// ── yamlScalar ────────────────────────────────────────────────────────────────

/**
 * `yamlQuote` always quotes, which is right for an author carried into an
 * appended revisions row and wrong for the `--init` scaffold — people read that
 * as documentation, and quoting all of it turns every example line into
 * `Title: "Document Title"` for the benefit of the rare value that needs it.
 */
describe('yamlScalar', () => {
    const bare = (v: string, opts?: { flow?: boolean }) => assert.equal(yamlScalar(v, opts), v);
    const quoted = (v: string, opts?: { flow?: boolean }) =>
        assert.equal(yamlScalar(v, opts), yamlQuote(v), `expected ${JSON.stringify(v)} to be quoted`);

    it('leaves an ordinary scalar bare', () => {
        bare('Document Title');
        bare('Your Name');
        bare('Work In Progress');
        bare('A4');
    });

    it('quotes a value that would read as a nested mapping', () => {
        quoted('Q3 Report: Draft');
        quoted('Trailing colon:');
    });

    it('quotes a value opening with a YAML indicator', () => {
        for (const v of ['- dash', '? question', '#hash', '&anchor', '*alias', '!tag',
                         '|literal', '>folded', "'quote", '"quote', '%directive', '@at', '`tick',
                         '{brace', '[bracket', ',comma', ':colon'])
            quoted(v);
    });

    it('quotes the YAML keywords, so they stay strings', () => {
        // `Status: No` is a status, not the boolean false.
        for (const v of ['true', 'False', 'yes', 'NO', 'on', 'Off', 'null', '~']) quoted(v);
    });

    it('quotes anything number-like', () => {
        for (const v of ['1', '-2', '3.5', '.5', '1e3', '1_000']) quoted(v);
    });

    it('quotes a value whose surrounding space would be lost', () => {
        quoted(' leading');
        quoted('trailing ');
        quoted('');
    });

    it('quotes a value that would start a comment', () => {
        quoted('done #2');
    });

    it('only quotes flow-breaking characters in flow context', () => {
        // A comma is harmless in a block scalar and ends the value inside `{…}`.
        bare("O'Brien, Jr.");
        quoted("O'Brien, Jr.", { flow: true });
        bare('a}b');
        quoted('a}b', { flow: true });
    });

    it('round-trips every awkward value through the real parser', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-scalar-'));
        try {
            for (const value of ['Q3 Report: Draft', "O'Brien, Jr.", 'No', '1.0', ' spaced ',
                                 'done #2', '- dash', 'a, b', '']) {
                const f = path.join(dir, 'x.md');
                fs.writeFileSync(f, [
                    '---',
                    `Title: ${yamlScalar(value)}`,
                    'Revisions:',
                    `    - {Revision: 1, Date: "2026-01-02", Author: A, Remarks: ${yamlScalar(value, { flow: true })}}`,
                    '---',
                    '',
                    '# H',
                ].join('\n'), 'utf8');
                const fm = extractFrontmatter(f);
                assert.equal(fm.title, value, `Title round-trip failed for ${JSON.stringify(value)}`);
                assert.equal(fm.revisions[0].remarks, value,
                             `Remarks round-trip failed for ${JSON.stringify(value)}`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── setLastRevisionRemarks ────────────────────────────────────────────────────

/**
 * The release note goes on the OUTGOING revision — the row already there,
 * describing the work being signed off — not the fresh row `--release` appends
 * for the next one. Getting that backwards would annotate a revision in which
 * nothing has happened yet.
 */
describe('setLastRevisionRemarks', () => {
    const lines = (s: string): string[] => s.split('\n');

    it('fills an empty inline Remarks', () => {
        const l = lines([
            'Revisions:',
            '    - {Revision: 2, Date: "2026-01-01", Author: A, Remarks: older}',
            '    - {Revision: 3, Date: "2026-02-01", Author: A, Remarks: }',
        ].join('\n'));
        assert.equal(setLastRevisionRemarks(l, 'signed off'), true);
        assert.match(l[2], /Remarks: signed off\}/);
        assert.match(l[1], /Remarks: older\}/, 'earlier rows are untouched');
    });

    it('replaces a non-empty inline Remarks', () => {
        const l = lines('Revisions:\n    - {Revision: 3, Date: "d", Author: A, Remarks: old}');
        setLastRevisionRemarks(l, 'new');
        assert.match(l[1], /Remarks: new\}/);
    });

    it('quotes a note that would break the flow mapping', () => {
        const l = lines('Revisions:\n    - {Revision: 3, Date: "d", Author: A, Remarks: }');
        setLastRevisionRemarks(l, 'fixed A, added B');
        assert.match(l[1], /Remarks: "fixed A, added B"\}/);
    });

    it('adds a Remarks key to an inline row that has none', () => {
        const l = lines('Revisions:\n    - {Revision: 3, Date: "d", Author: A}');
        setLastRevisionRemarks(l, 'note');
        assert.match(l[1], /, Remarks: note\}$/);
    });

    it('fills a block-form Remarks', () => {
        const l = lines([
            'Revisions:',
            '    - Revision: 3',
            '      Date: "2026-02-01"',
            '      Author: A',
            '      Remarks:',
        ].join('\n'));
        assert.equal(setLastRevisionRemarks(l, 'signed off'), true);
        assert.equal(l[4], '      Remarks: signed off');
    });

    it('adds a Remarks key to a block row that has none', () => {
        const l = lines('Revisions:\n    - Revision: 3\n      Author: A');
        setLastRevisionRemarks(l, 'note');
        assert.equal(l[3], '      Remarks: note');
    });

    it('keeps the document\'s own key casing', () => {
        const l = lines('revisions:\n    - {revision: 3, date: "d", author: a, remarks: }');
        setLastRevisionRemarks(l, 'note');
        assert.match(l[1], /remarks: note\}/);
        assert.ok(!/Remarks/.test(l[1]), 'must not introduce a capitalised key');
    });

    it('reports false when there is no revisions list to annotate', () => {
        assert.equal(setLastRevisionRemarks(lines('Title: x'), 'note'), false);
    });

    it('inserts a note containing $& verbatim', () => {
        const l = lines('Revisions:\n    - {Revision: 3, Date: "d", Author: A, Remarks: }');
        setLastRevisionRemarks(l, 'a$&b');
        assert.match(l[1], /Remarks: a\$&b\}/);
    });
});

// ── frontmatterTemplate with answers ──────────────────────────────────────────

describe('frontmatterTemplate --answers', () => {
    it('is byte-identical to the placeholder scaffold when given nothing', () => {
        assert.equal(frontmatterTemplate('2026-01-02', {}), frontmatterTemplate('2026-01-02'));
    });

    it('substitutes the answers it was given', () => {
        const out = frontmatterTemplate('2026-01-02', { title: 'My Doc', author: 'Wouter', theme: 'acme' });
        assert.match(out, /^Title: My Doc$/m);
        assert.match(out, /^    Author: Wouter$/m);
        assert.match(out, /^Theme: acme$/m);
    });

    it('omits an optional key that was not answered', () => {
        const out = frontmatterTemplate('2026-01-02', { title: 'x' });
        for (const key of ['Classification', 'Watermark', 'Numbered Headings', 'TOC Depth', 'Page Size'])
            assert.ok(!out.includes(`${key}:`), `${key} should not appear unasked`);
    });

    it('emits optional keys that were answered', () => {
        const out = frontmatterTemplate('2026-01-02', {
            classification: 'Confidential', numberedHeadings: true, tocDepth: 3, pageSize: 'A3',
        });
        assert.match(out, /^Classification: Confidential$/m);
        assert.match(out, /^Numbered Headings: true$/m);
        assert.match(out, /^TOC Depth: 3$/m);
        assert.match(out, /^Page Size: A3$/m);
    });

    it('omits a false boolean rather than writing it', () => {
        // `Numbered Headings: false` is the default; writing it out is noise the
        // author then has to read and decide about.
        const out = frontmatterTemplate('2026-01-02', { numberedHeadings: false });
        assert.ok(!out.includes('Numbered Headings'));
    });

    it('produces a document the exporter parses, for awkward answers', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-answers-'));
        try {
            const f = path.join(dir, 'x.md');
            fs.writeFileSync(f, frontmatterTemplate('2026-01-02', {
                title: 'Q3 Report: Draft', author: "O'Brien, Jr.", status: 'No', mode: 'pdf',
            }) + '\n# H\n', 'utf8');
            const fm = extractFrontmatter(f);
            assert.equal(fm.title, 'Q3 Report: Draft');
            assert.equal(fm.author, "O'Brien, Jr.");
            assert.equal(fm.status, 'No');
            assert.equal(fm.revisions[0].author, "O'Brien, Jr.");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
