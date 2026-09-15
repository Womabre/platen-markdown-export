import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    hideFrontmatterTable, buildGlossary, stripMarkdownToc,
    cleanTocAttrs, prepareSourceUpdates, rewriteRelativeImagePaths, resolveIncludes,
    parseLineRange, sliceLines, convertMarkdownToHtml, documentUsesKatex, stripFencedCode,
} from '../markdown';
import { extractFrontmatter } from '../frontmatter';
import { applyVariables, wrapCodeLines, applyCaptions } from '../markdown-extras';

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-md-test-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── stripMarkdownToc ──────────────────────────────────────────────────────────

describe('stripMarkdownToc', () => {
    it('returns unchanged body when there is no list', () => {
        const body = '# Heading\n\nParagraph text.\n';
        assert.equal(stripMarkdownToc(body), body);
    });

    it('returns unchanged body when a list has external (non-hash) links', () => {
        const body = '- [Home](https://example.com)\n- [About](https://example.com/about)\n';
        assert.equal(stripMarkdownToc(body), body);
    });

    it('returns unchanged body when a list has only one hash link (< 2 required)', () => {
        const body = '- [Only](#only)\n';
        assert.equal(stripMarkdownToc(body), body);
    });

    it('strips a list where all items link to hash anchors', () => {
        const body = '- [Intro](#intro)\n- [Body](#body)\n- [End](#end)\n\nContent here.';
        const result = stripMarkdownToc(body);
        assert.ok(!result.includes('[Intro]'), `TOC list should be removed: ${result}`);
        assert.ok(result.includes('Content here.'));
    });

    it('also removes a preceding heading when present', () => {
        const body = '## Table of Contents\n\n- [Intro](#intro)\n- [Body](#body)\n\nContent.';
        const result = stripMarkdownToc(body);
        assert.ok(!result.includes('Table of Contents'), `heading should be removed: ${result}`);
        assert.ok(!result.includes('[Intro]'));
        assert.ok(result.includes('Content.'));
    });

    it('also removes a preceding heading separated by a blank line', () => {
        const body = '## Contents\n\n- [One](#one)\n- [Two](#two)\n\nAfter.';
        const result = stripMarkdownToc(body);
        assert.ok(!result.includes('## Contents'));
        assert.ok(result.includes('After.'));
    });

    it('handles asterisk (*) and plus (+) bullet markers', () => {
        const asterisk = '* [Intro](#intro)\n* [Body](#body)\n';
        const plus     = '+ [Intro](#intro)\n+ [Body](#body)\n';
        assert.ok(!stripMarkdownToc(asterisk).includes('[Intro]'));
        assert.ok(!stripMarkdownToc(plus).includes('[Intro]'));
    });

    it('does not strip a list where some items have non-hash links', () => {
        const body = '- [Intro](#intro)\n- [External](https://example.com)\n';
        assert.equal(stripMarkdownToc(body), body);
    });

    it('preserves content before and after the TOC block', () => {
        const body = 'Preamble.\n\n- [A](#a)\n- [B](#b)\n\nBody text.';
        const result = stripMarkdownToc(body);
        assert.ok(result.includes('Preamble.'));
        assert.ok(result.includes('Body text.'));
    });
});

// ── hideFrontmatterTable ──────────────────────────────────────────────────────

describe('hideFrontmatterTable', () => {
    it('wraps a leading table before any heading or paragraph', () => {
        const html = '<table><tr><td>key</td><td>val</td></tr></table><h1>Title</h1>';
        const result = hideFrontmatterTable(html);
        assert.ok(result.includes('<div class="frontmatter-table">'));
        assert.ok(result.includes('</div>'));
    });

    it('does not wrap a table that appears after a heading', () => {
        const html = '<h1>Title</h1><table><tr><td>data</td></tr></table>';
        const result = hideFrontmatterTable(html);
        assert.equal(result, html, 'should return unchanged when table follows heading');
        assert.ok(!result.includes('frontmatter-table'));
    });

    it('does not wrap a table that appears after a paragraph', () => {
        const html = '<p>Intro text</p><table><tr><td>data</td></tr></table>';
        const result = hideFrontmatterTable(html);
        assert.equal(result, html);
    });

    it('returns unchanged when there is no table', () => {
        const html = '<h1>Hello</h1><p>World</p>';
        assert.equal(hideFrontmatterTable(html), html);
    });

    it('handles empty string', () => {
        assert.equal(hideFrontmatterTable(''), '');
    });

    it('wraps correctly when the frontmatter table contains a nested table', () => {
        const html = '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table><h1>Body</h1>';
        const result = hideFrontmatterTable(html);
        assert.ok(result.startsWith('<div class="frontmatter-table">'));
        assert.ok(result.endsWith('</div><h1>Body</h1>'));
        // The wrapper must enclose both the outer and inner table
        assert.ok(result.includes('<table><tr><td><table>'));
    });
});

// ── buildGlossary ─────────────────────────────────────────────────────────────

describe('buildGlossary', () => {
    it('returns empty string when no abbreviations are defined', () => {
        assert.equal(buildGlossary('No abbreviations here.', 'en'), '');
    });

    it('extracts and renders abbreviation definitions', () => {
        const body = '*[API]: Application Programming Interface\n*[CLI]: Command Line Interface\n';
        const result = buildGlossary(body, 'en');
        assert.ok(result.includes('API'), `expected API in result: ${result}`);
        assert.ok(result.includes('Application Programming Interface'));
        assert.ok(result.includes('CLI'));
        assert.ok(result.includes('Command Line Interface'));
    });

    it('sorts entries alphabetically', () => {
        const body = '*[ZZZ]: Last\n*[AAA]: First\n*[MMM]: Middle\n';
        const result = buildGlossary(body, 'en');
        const aaaPos = result.indexOf('AAA');
        const mmmPos = result.indexOf('MMM');
        const zzzPos = result.indexOf('ZZZ');
        assert.ok(aaaPos < mmmPos && mmmPos < zzzPos, 'entries should be sorted A→Z');
    });

    it('uses English headings for lang="en"', () => {
        const body = '*[API]: Application Programming Interface\n';
        const result = buildGlossary(body, 'en');
        assert.ok(result.includes('Abbreviations'));
        assert.ok(result.includes('Abbreviation'));
        assert.ok(result.includes('Description'));
    });

    it('uses Dutch headings for lang="nl"', () => {
        const body = '*[API]: Application Programming Interface\n';
        const result = buildGlossary(body, 'nl');
        assert.ok(result.includes('Afkortingen'));
        assert.ok(result.includes('Afkorting'));
        assert.ok(result.includes('Omschrijving'));
    });

    it('falls back to English for an unknown language', () => {
        const body = '*[API]: Application Programming Interface\n';
        const result = buildGlossary(body, 'xx');
        assert.ok(result.includes('Abbreviations'));
    });

    it('HTML-escapes special characters in abbreviations and definitions', () => {
        const body = '*[A&B]: <script>alert("xss")</script>\n';
        const result = buildGlossary(body, 'en');
        assert.ok(!result.includes('<script>'), 'script tag should be escaped');
        assert.ok(result.includes('&lt;script&gt;'));
        assert.ok(result.includes('A&amp;B'));
    });

    it('ignores duplicate abbreviation definitions (last wins)', () => {
        const body = '*[API]: First definition\n*[API]: Second definition\n';
        const result = buildGlossary(body, 'en');
        // Map overwrites duplicates — only one row should appear for API
        const count = (result.match(/API/g) ?? []).length;
        // Should appear in heading row (th) + one data row (td) = 2 times max
        assert.ok(count <= 2, `expected at most 2 occurrences, got ${count}`);
    });
});

// ── cleanTocAttrs ─────────────────────────────────────────────────────────────

describe('cleanTocAttrs', () => {
    it('returns unchanged body when there are no attrs blocks', () => {
        const body = '- [Introduction](#introduction)\n- [Setup](#setup)\n';
        assert.equal(cleanTocAttrs(body), body);
    });

    it('strips {.class} from link text', () => {
        const body = '- [Migration {.page-break-before}](#migration-page-break-before)\n';
        const result = cleanTocAttrs(body);
        assert.ok(!result.includes('{.page-break-before}'), `attrs should be removed: ${result}`);
        assert.ok(result.includes('[Migration]'));
    });

    it('fixes the anchor to match the slug without the attrs suffix', () => {
        const body = '- [Section {.page-break-before}](#section-page-break-before)\n';
        const result = cleanTocAttrs(body);
        assert.ok(result.includes('(#section)'), `anchor should be trimmed: ${result}`);
    });

    it('leaves anchor unchanged when it does not end with the derived suffix', () => {
        const body = '- [Title {.cls}](#some-other-anchor)\n';
        const result = cleanTocAttrs(body);
        assert.ok(result.includes('(#some-other-anchor)'));
    });

    it('handles multiple entries in one pass', () => {
        const body = [
            '- [A {.x}](#a-x)',
            '- [B {.y}](#b-y)',
            '- [C](#c)',
        ].join('\n') + '\n';
        const result = cleanTocAttrs(body);
        assert.ok(!result.includes('{.x}'));
        assert.ok(!result.includes('{.y}'));
        assert.ok(result.includes('[C](#c)'));
    });
});

// ── prepareSourceUpdates ──────────────────────────────────────────────────────
//
// Source edits are computed up front (the export needs today's stamped date) but
// written only once an export has succeeded. These tests pin both halves: what
// the export sees, and that nothing reaches disk until commit().

const DIRTY_TOC =
    '# Doc\n\n- [Frontmatter \\& Cover Page {.page-break-before}](#frontmatter--cover-page-page-break-before)\n\n## Frontmatter & Cover Page {.page-break-before}\n';

describe('prepareSourceUpdates', () => {
    it('computes the cleaned TOC without touching the file', () => {
        const file = path.join(tmpDir, 'toc-dirty.md');
        fs.writeFileSync(file, DIRTY_TOC);

        const pending = prepareSourceUpdates(file);

        assert.equal(pending.tocCleaned, true);
        assert.equal(pending.changed, true);
        assert.ok(pending.content.includes('[Frontmatter \\& Cover Page](#frontmatter--cover-page)'));
        // The heading line (not a link) must keep its attribute so page breaks still work.
        assert.ok(pending.content.includes('## Frontmatter & Cover Page {.page-break-before}'));
        assert.equal(fs.readFileSync(file, 'utf8'), DIRTY_TOC, 'file must be untouched before commit()');
    });

    it('writes the update only when commit() is called', () => {
        const file = path.join(tmpDir, 'toc-commit.md');
        fs.writeFileSync(file, DIRTY_TOC);

        const pending = prepareSourceUpdates(file);
        assert.equal(fs.readFileSync(file, 'utf8'), DIRTY_TOC);

        pending.commit();
        assert.equal(fs.readFileSync(file, 'utf8'), pending.content);
    });

    it('is idempotent and leaves an already-clean file untouched', () => {
        const file = path.join(tmpDir, 'toc-clean.md');
        const clean = '# Doc\n\n- [Setup](#setup)\n\n## Setup\n';
        fs.writeFileSync(file, clean);

        const pending = prepareSourceUpdates(file);
        assert.equal(pending.changed, false);
        assert.equal(pending.content, clean);

        pending.commit();   // no-op
        assert.equal(fs.readFileSync(file, 'utf8'), clean);
    });

    it('stamps today on the last Revisions entry when Status is Work In Progress', () => {
        const file  = path.join(tmpDir, 'dated.md');
        // Local calendar date, matching `formatDate` in frontmatter.ts — a
        // document's revision date is the author's date, not UTC's. Deriving the
        // expectation from `toISOString()` instead made this test fail for the
        // hours each day when the two disagree (anywhere east of UTC, after
        // local midnight), which is a flake nobody would enjoy diagnosing.
        const now   = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        fs.writeFileSync(file, [
            '---',
            'Title: Spec',
            'Status: Work In Progress',
            'Revisions:',
            '    - Revision: 1',
            '      Date: "2020-01-01"',
            '      Author: Someone',
            '---',
            '',
            '# Spec',
            '',
        ].join('\n'));

        const pending = prepareSourceUpdates(file);

        assert.equal(pending.dateStamped, true);
        assert.ok(pending.content.includes(`Date: "${today}"`), pending.content);
        assert.ok(!pending.content.includes('2020-01-01'));
        assert.ok(fs.readFileSync(file, 'utf8').includes('2020-01-01'), 'not written before commit()');
    });

    it('leaves the date alone for a status that is neither WIP nor Released', () => {
        const file = path.join(tmpDir, 'draft.md');
        const src  = [
            '---',
            'Status: Draft',
            'Revisions:',
            '    - Revision: 1',
            '      Date: "2020-01-01"',
            '---',
            '',
            '# Draft',
            '',
        ].join('\n');
        fs.writeFileSync(file, src);

        const pending = prepareSourceUpdates(file);

        assert.equal(pending.dateStamped, false);
        assert.equal(pending.changed, false);
        assert.ok(pending.content.includes('2020-01-01'));
    });
});

// ── rewriteRelativeImagePaths ─────────────────────────────────────────────────

describe('rewriteRelativeImagePaths', () => {
    it('leaves http URLs unchanged', () => {
        const body = '![alt](https://example.com/img.png)';
        assert.equal(rewriteRelativeImagePaths(body, '/some/dir'), body);
    });

    it('leaves absolute paths unchanged', () => {
        const body = '![alt](/abs/path/img.png)';
        assert.equal(rewriteRelativeImagePaths(body, '/some/dir'), body);
    });

    it('rewrites a relative path to an absolute path', () => {
        const result = rewriteRelativeImagePaths('![alt](img.png)', '/docs/sub');
        // The expectation is built with `path.resolve` too, because the code
        // uses it and it is platform-native: on Windows this is
        // `C:\docs\sub\img.png`, and asserting a POSIX literal here failed the
        // Windows CI leg on a test assumption rather than on a real defect.
        assert.ok(result.includes(path.resolve('/docs/sub', 'img.png')), `got: ${result}`);
    });

    it('wraps the rewritten path in angle brackets', () => {
        const result = rewriteRelativeImagePaths('![alt](img.png)', '/docs');
        assert.ok(result.match(/\(<[^>]+>\)/), `expected angle brackets: ${result}`);
    });

    it('preserves the alt text', () => {
        const result = rewriteRelativeImagePaths('![my alt](img.png)', '/docs');
        assert.ok(result.startsWith('![my alt]'));
    });

    it('preserves an optional title string', () => {
        const result = rewriteRelativeImagePaths('![alt](img.png "My Title")', '/docs');
        assert.ok(result.includes('"My Title"'), `title should be preserved: ${result}`);
    });

    it('resolves subdirectory traversal correctly', () => {
        const result = rewriteRelativeImagePaths('![alt](../assets/img.png)', '/docs/sub');
        assert.ok(result.includes(path.resolve('/docs/sub', '../assets/img.png')), `got: ${result}`);
    });
});

// ── resolveIncludes ───────────────────────────────────────────────────────────

describe('resolveIncludes', () => {
    it('returns body unchanged when there are no include directives', () => {
        const body = '# Heading\n\nParagraph.\n';
        assert.equal(resolveIncludes(body, tmpDir), body);
    });

    it('inlines the content of an existing included file', () => {
        fs.writeFileSync(path.join(tmpDir, 'child.md'), '# Child\n\nChild content.\n');
        const body = '[!include](child.md)\n';
        const result = resolveIncludes(body, tmpDir);
        assert.ok(result.includes('Child content.'), `got: ${result}`);
    });

    it('leaves the directive intact when the included file does not exist', () => {
        const body = '[!include](nonexistent.md)\n';
        const result = resolveIncludes(body, tmpDir);
        assert.ok(result.includes('[!include]'));
    });

    it('strips frontmatter from included files', () => {
        fs.writeFileSync(path.join(tmpDir, 'with-fm.md'), '---\ntitle: X\n---\nBody only.\n');
        const result = resolveIncludes('[!include](with-fm.md)\n', tmpDir);
        assert.ok(result.includes('Body only.'));
        assert.ok(!result.includes('title: X'));
    });

    it('inserts a page-break div before included content', () => {
        fs.writeFileSync(path.join(tmpDir, 'page.md'), 'Content.\n');
        const result = resolveIncludes('[!include](page.md)\n', tmpDir);
        assert.ok(result.includes('page-break-before'), `got: ${result}`);
    });

    it('skips circular includes and does not loop', () => {
        const visited = new Set([path.join(tmpDir, 'self.md')]);
        fs.writeFileSync(path.join(tmpDir, 'self.md'), '[!include](self.md)\n');
        const result = resolveIncludes('[!include](self.md)\n', tmpDir, visited);
        assert.equal(result.trim(), '');
    });
});

// ── Include line ranges ───────────────────────────────────────────────────────

describe('parseLineRange', () => {
    it('parses a single line and an L-prefixed or bare range', () => {
        assert.deepEqual(parseLineRange('#L7'), { from: 7, to: 7 });
        assert.deepEqual(parseLineRange('#L10-L25'), { from: 10, to: 25 });
        assert.deepEqual(parseLineRange('#L10-25'), { from: 10, to: 25 });
    });

    it('returns null for no fragment or a malformed one', () => {
        assert.equal(parseLineRange(undefined), null);
        assert.equal(parseLineRange('#section-name'), null);
        assert.equal(parseLineRange('#L'), null);
    });

    it('rejects a reversed or zero-based range rather than silently emptying', () => {
        assert.equal(parseLineRange('#L25-L10'), null);
        assert.equal(parseLineRange('#L0-L5'), null);
    });
});

describe('sliceLines', () => {
    const text = 'one\ntwo\nthree\nfour\nfive';

    it('slices an inclusive 1-indexed range', () => {
        assert.equal(sliceLines(text, { from: 2, to: 4 }), 'two\nthree\nfour');
    });

    it('slices a single line', () => {
        assert.equal(sliceLines(text, { from: 1, to: 1 }), 'one');
    });

    it('clamps a range that runs past the end', () => {
        assert.equal(sliceLines(text, { from: 4, to: 99 }), 'four\nfive');
    });
});

describe('resolveIncludes — non-markdown and line ranges', () => {
    it('quotes a non-markdown file as a fenced code block with an inferred language', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
        const out = resolveIncludes('[!include](a.ts)', dir);
        assert.match(out, /^```typescript\n/);
        assert.match(out, /const a = 1;/);
        assert.match(out, /const c = 3;\n```$/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('takes only the requested lines of a code include', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        fs.writeFileSync(path.join(dir, 'a.py'), 'one\ntwo\nthree\nfour\n');
        const out = resolveIncludes('[!include](a.py#L2-L3)', dir);
        assert.match(out, /^```python\ntwo\nthree\n```$/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lengthens the fence so embedded backticks cannot close it early', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        fs.writeFileSync(path.join(dir, 'a.md.txt'), 'text\n```\nfenced\n```\n');
        const out = resolveIncludes('[!include](a.md.txt)', dir);
        assert.match(out, /^````/, 'fence must be longer than the longest run inside');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('splices a markdown excerpt inline — no page break, no revision heading', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        fs.writeFileSync(path.join(dir, 'part.md'), '# Head\n\nkeep me\n\ndrop me\n');
        const out = resolveIncludes('[!include](part.md#L3-L3)', dir);
        assert.equal(out.trim(), 'keep me');
        assert.doesNotMatch(out, /page-break-before/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('still page-breaks a whole-file markdown include', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        fs.writeFileSync(path.join(dir, 'part.md'), 'body text\n');
        const out = resolveIncludes('[!include](part.md)', dir);
        assert.match(out, /page-break-before/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('leaves the directive untouched when the file is missing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
        assert.equal(resolveIncludes('[!include](nope.ts)', dir), '[!include](nope.ts)');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ── Variables & conditional content ───────────────────────────────────────────

describe('applyVariables', () => {
    it('substitutes known names, with or without inner spaces', () => {
        const out = applyVariables('Hi {{Customer}} and {{ Project }}.',
                                   { Customer: 'Acme', Project: 'PDM' });
        assert.equal(out, 'Hi Acme and PDM.');
    });

    it('leaves an unknown placeholder verbatim rather than blanking it', () => {
        const out = applyVariables('Hi {{Cutsomer}}.', { Customer: 'Acme' });
        assert.equal(out, 'Hi {{Cutsomer}}.');
    });

    it('substitutes every occurrence', () => {
        assert.equal(applyVariables('{{A}}-{{A}}', { A: 'x' }), 'x-x');
    });

    it('supports an empty value', () => {
        assert.equal(applyVariables('[{{A}}]', { A: '' }), '[]');
    });
});

describe('code-fence safety', () => {
    it('does not substitute variables inside fenced or inline code', () => {
        const src = 'Real {{A}}\n\n```\nliteral {{A}}\n```\n\ninline `{{A}}` stays';
        const out = applyVariables(src, { A: 'X' });
        assert.match(out, /Real X/);
        assert.match(out, /literal \{\{A\}\}/);
        assert.match(out, /inline `\{\{A\}\}` stays/);
    });
});

// ── Include language override ─────────────────────────────────────────────────

describe('resolveIncludes — language override', () => {
    function withFile(name: string, content: string, fn: (dir: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-lang-'));
        fs.writeFileSync(path.join(dir, name), content);
        try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    it('overrides the extension-derived language via a link title', () => {
        withFile('Main.config', '<?xml version="1.0"?>\n', dir => {
            assert.match(resolveIncludes('[!include](Main.config)', dir), /^```config\n/,
                'baseline: the extension is used when no title is given');
            assert.match(resolveIncludes('[!include](Main.config "xml")', dir), /^```xml\n/);
        });
    });

    it('accepts single quotes too', () => {
        withFile('a.config', 'x\n', dir => {
            assert.match(resolveIncludes("[!include](a.config 'xml')", dir), /^```xml\n/);
        });
    });

    it('combines an override with a line range', () => {
        withFile('a.config', 'one\ntwo\nthree\nfour\n', dir => {
            const out = resolveIncludes('[!include](a.config#L2-L3 "xml")', dir);
            assert.match(out, /^```xml\ntwo\nthree\n```$/);
        });
    });

    it('an explicit language forces code-block treatment of a .md file', () => {
        withFile('part.md', '# Heading\n\nbody\n', dir => {
            const spliced = resolveIncludes('[!include](part.md)', dir);
            assert.match(spliced, /page-break-before/, 'baseline: markdown is spliced, not quoted');

            const quoted = resolveIncludes('[!include](part.md "markdown")', dir);
            assert.match(quoted, /^```markdown\n# Heading/);
            assert.doesNotMatch(quoted, /page-break-before/);
        });
    });

    it('leaves a path containing spaces and brackets intact', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-lang-'));
        const sub = path.join(dir, '[Best Practice] Docs');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'Main.config'), '<a/>\n');
        const out = resolveIncludes('[!include]([Best Practice] Docs/Main.config "xml")', dir);
        assert.match(out, /^```xml\n<a\/>\n```$/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('wrapCodeLines — trailing newline inside an open span', () => {
    it('does not emit a phantom final line when a span stays open past the newline', () => {
        // highlight.js closes an unterminated construct AFTER the final newline,
        // so the string ends with "</span>" rather than "\n".
        const html = '<span class="hljs-meta">one\ntwo\n</span>';
        const out  = wrapCodeLines(html, new Set());
        assert.equal((out.match(/class="code-line/g) ?? []).length, 2);
    });

    it('still handles a plain trailing newline', () => {
        assert.equal((wrapCodeLines('a\nb\n', new Set()).match(/class="code-line/g) ?? []).length, 2);
    });

    it('still handles no trailing newline', () => {
        assert.equal((wrapCodeLines('a\nb', new Set()).match(/class="code-line/g) ?? []).length, 2);
    });
});

// ── commit() idempotency ──────────────────────────────────────────────────────

describe('prepareSourceUpdates commit() is idempotent', () => {
    const DATED = [
        '---',
        'Title: T',
        'Status: Work In Progress',
        'Revisions:',
        '  - Revision: 1',
        '    Date: "2020-01-01"',
        '    Author: W',
        '---',
        '',
        '# T',
    ].join('\n');

    it('writes once and reports it, then reports false on every later call', () => {
        // `--mode pdf,html` produces two outputs and each of them earns the
        // source stamp, so main() commits after both. Only the first may write
        // or log; the second must be a silent no-op.
        const file = path.join(tmpDir, 'commit-twice.md');
        fs.writeFileSync(file, DATED);

        const pending = prepareSourceUpdates(file);
        assert.equal(pending.changed, true);

        assert.equal(pending.commit(), true,  'first commit writes');
        const afterFirst = fs.readFileSync(file, 'utf8');

        assert.equal(pending.commit(), false, 'second commit is a no-op');
        assert.equal(pending.commit(), false, 'and stays one');
        assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'the file must not change again');
    });

    it('reports false when there was nothing to write in the first place', () => {
        const file = path.join(tmpDir, 'commit-clean.md');
        const clean = '# Nothing to stamp\n';
        fs.writeFileSync(file, clean);

        const pending = prepareSourceUpdates(file);
        assert.equal(pending.changed, false);
        assert.equal(pending.commit(), false);
        assert.equal(fs.readFileSync(file, 'utf8'), clean);
    });
});

// ── convertMarkdownToHtml: injected source + frontmatter ──────────────────────

describe('convertMarkdownToHtml reuses what the caller already has', () => {
    it('renders the supplied source rather than re-reading the file', async () => {
        // main() reads the document once, to compute the deferred source edits,
        // and hands that content back. Passing content that differs from disk is
        // how we prove it is really used — and that the render sees exactly the
        // bytes that will be written, not the pre-stamp file.
        const file = path.join(tmpDir, 'injected.md');
        fs.writeFileSync(file, '---\nTitle: On Disk\n---\n\n# On Disk\n');

        const html = await convertMarkdownToHtml(file, '---\nTitle: In Memory\n---\n\n# In Memory\n');

        assert.match(html, /In Memory/);
        assert.ok(!html.includes('On Disk'), 'the on-disk body must not appear');
    });

    it('honours the supplied frontmatter, including Lang', async () => {
        const file = path.join(tmpDir, 'injected-lang.md');
        fs.writeFileSync(file, '# x\n');
        const source = '---\nLang: nl\n---\n\n# x\n\n*[HTML]: HyperText Markup Language\n';

        const html = await convertMarkdownToHtml(file, source, extractFrontmatter(file, source));

        assert.match(html, /<html lang="nl">/);
        // The glossary heading is localised from the same Lang value.
        assert.match(html, /Afkortingen/);
    });

    it('still reads the file when nothing is supplied', async () => {
        const file = path.join(tmpDir, 'not-injected.md');
        fs.writeFileSync(file, '---\nTitle: From Disk\n---\n\n# From Disk\n');

        assert.match(await convertMarkdownToHtml(file), /From Disk/);
    });
});

// ── KaTeX stylesheet gating ───────────────────────────────────────────────────
//
// The block is ~370 KB (25 KB of CSS plus twenty base64 woff2 faces) and used to
// ship with every export. On a document with no math that was ~90% of the file,
// referenced by nothing.

describe('documentUsesKatex', () => {
    for (const cls of ['katex', 'katex-display', 'katex-block ', 'katex-html', 'katex-mathml', 'katex-error']) {
        it(`detects class="${cls.trim()}"`, () => {
            assert.equal(documentUsesKatex(`<span class="${cls}">x</span>`), true);
        });
    }

    it('detects the class in a multi-class attribute', () => {
        assert.equal(documentUsesKatex('<span class="foo katex-display">x</span>'), true);
    });

    it('is not fooled by prose that merely mentions KaTeX', () => {
        // The reason this matches markup rather than the word: the KaTeX
        // stylesheet itself carries hundreds of `.katex` selectors, so a
        // bare-word search reports a hit on any document that inlined it once —
        // which would gate nothing at all.
        assert.equal(documentUsesKatex('<p>We render math with KaTeX, but not here.</p>'), false);
        assert.equal(documentUsesKatex('<style>.katex { font: x; }</style>'), false);
        assert.equal(documentUsesKatex('<pre><code>npm install katex</code></pre>'), false);
    });

    it('ignores an empty document', () => {
        assert.equal(documentUsesKatex(''), false);
    });
});

describe('convertMarkdownToHtml only inlines KaTeX when the document has math', () => {
    const KATEX_FONT = /data:font\/woff2;base64,/;

    it('inlines the stylesheet and its fonts for a document with math', async () => {
        const file   = path.join(tmpDir, 'with-math.md');
        const source = '---\nTitle: Math\n---\n\n# Math\n\nInline $E = mc^2$ here.\n';

        const html = await convertMarkdownToHtml(file, source);

        assert.match(html, /class="katex/, 'math must still render');
        assert.match(html, KATEX_FONT, 'its fonts must be embedded');
    });

    it('leaves no font reference the PDF renderer could not resolve', async () => {
        // The stronger form of the assertion above, and the one that actually
        // matters. The inliner rewrites katex.min.css with hand-written regexes;
        // a katex release that reformats its @font-face rules would silently
        // match fewer of them, and WeasyPrint — which is handed the document
        // from the user's own directory, not katex's — cannot resolve a leftover
        // `url(fonts/KaTeX_Main-Regular.woff2)`. Math would render in a fallback
        // face with no test failing. `katex` is pinned exactly for the same
        // reason; this is what would catch the bump going wrong.
        const file = path.join(tmpDir, 'font-refs.md');
        const html = await convertMarkdownToHtml(file, '---\nTitle: M\n---\n\n$x^2$\n');

        const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
        const katexCss    = styleBlocks.find(b => b.includes('.katex'));
        assert.ok(katexCss, 'the katex stylesheet must be present');

        const unresolved = [...katexCss.matchAll(/url\(([^)]*)\)/g)]
            .map(m => m[1].replace(/['"]/g, ''))
            .filter(u => !u.startsWith('data:'));

        assert.deepEqual(unresolved, [], `every font URL must be a data: URI, found: ${unresolved.join(', ')}`);
        assert.ok((katexCss.match(/data:font\/woff2/g) ?? []).length >= 20,
            'all twenty KaTeX faces should be embedded, not just the ones a loose regex caught');
    });

    it('omits it entirely for a document with no math', async () => {
        const file   = path.join(tmpDir, 'no-math.md');
        const source = '---\nTitle: Plain\n---\n\n# Plain\n\nJust prose.\n';

        const html = await convertMarkdownToHtml(file, source);

        assert.ok(!KATEX_FONT.test(html), 'no font payload for a document without math');
        assert.ok(!html.includes('.katex'), 'no KaTeX stylesheet at all');
    });

    it('omits it for a document that only writes *about* KaTeX', async () => {
        const file   = path.join(tmpDir, 'about-katex.md');
        const source = '---\nTitle: About\n---\n\n# About KaTeX\n\nWe use KaTeX. `katex` is a package.\n';

        const html = await convertMarkdownToHtml(file, source);

        assert.ok(!KATEX_FONT.test(html));
    });

    it('is dramatically smaller without math, for the same prose', async () => {
        const file = path.join(tmpDir, 'size-compare.md');
        const prose = '# Doc\n\nSome prose that is identical in both documents.\n';

        const withMath = await convertMarkdownToHtml(file, `---\nTitle: A\n---\n\n${prose}\n$x^2$\n`);
        const without  = await convertMarkdownToHtml(file, `---\nTitle: A\n---\n\n${prose}`);

        assert.ok(
            without.length * 4 < withMath.length,
            `expected the math-free render to be far smaller, got ${without.length} vs ${withMath.length}`,
        );
    });
});

// ── stripFencedCode / glossary scope ──────────────────────────────────────────
//
// The glossary scan reads raw markdown; markdown-it-abbr reads the token stream.
// Without this the two disagreed, and a document *documenting* the abbreviation
// syntax grew a glossary entry for its own example.

describe('stripFencedCode', () => {
    it('blanks a fenced block but keeps the fences and the line count', () => {
        const body = ['before', '```', 'secret', '```', 'after'].join('\n');
        assert.deepEqual(stripFencedCode(body).split('\n'), ['before', '```', '', '```', 'after']);
    });

    it('leaves prose completely alone', () => {
        const body = 'just\nsome\nprose';
        assert.equal(stripFencedCode(body), body);
    });

    it('handles tilde fences', () => {
        assert.deepEqual(stripFencedCode('~~~\nx\n~~~').split('\n'), ['~~~', '', '~~~']);
    });

    it('does not let a shorter inner fence close a longer outer one', () => {
        // A four-backtick block quoting a three-backtick one, which is exactly
        // what includeAsCodeBlock emits.
        const body = ['````', '```', 'inner', '```', '````', 'after'].join('\n');
        assert.deepEqual(stripFencedCode(body).split('\n'), ['````', '', '', '', '````', 'after']);
    });

    it('does not let a different fence character close a block', () => {
        assert.deepEqual(stripFencedCode('```\n~~~\nx\n```').split('\n'), ['```', '', '', '```']);
    });

    it('tolerates an unclosed fence by blanking to the end', () => {
        assert.deepEqual(stripFencedCode('```\nrest').split('\n'), ['```', '']);
    });
});

describe('buildGlossary ignores fenced code', () => {
    it('does not take an abbreviation definition out of a code block', () => {
        const body = [
            '# Doc',
            '',
            'Write a definition like this:',
            '',
            '```markdown',
            '*[EXAMPLE]: not a real abbreviation',
            '```',
        ].join('\n');

        assert.equal(buildGlossary(body, 'en'), '', 'a documented example is not a glossary entry');
    });

    it('still collects a real definition in prose', () => {
        const html = buildGlossary('*[HTML]: HyperText Markup Language', 'en');
        assert.match(html, /HyperText Markup Language/);
    });

    it('collects the prose one while ignoring the fenced one', () => {
        const body = [
            '*[HTML]: HyperText Markup Language',
            '',
            '```',
            '*[FAKE]: should not appear',
            '```',
        ].join('\n');

        const html = buildGlossary(body, 'en');
        assert.match(html, /HyperText Markup Language/);
        assert.ok(!html.includes('FAKE'), 'the fenced definition must not appear');
    });
});

// ── Include depth cap ─────────────────────────────────────────────────────────
//
// The cycle guard copies `visited` per branch so a diamond expands both legs
// legitimately. The cost is that fan-out is unbounded without a depth limit:
// each level can double, with no cycle anywhere for the guard to catch.

describe('resolveIncludes depth limit', () => {
    let dir: string;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-include-depth-'));
        // A 25-deep chain: each file includes the next, no cycle anywhere.
        for (let i = 0; i < 25; i++) {
            const next = i < 24 ? `[!include](level${i + 1}.md)\n` : '';
            fs.writeFileSync(path.join(dir, `level${i}.md`), `# Level ${i}\n\n${next}`);
        }
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('expands a chain but stops at the cap instead of running to the end', () => {
        const out = resolveIncludes('[!include](level0.md)\n', dir);

        assert.match(out, /Level 0/, 'the first level must still expand');
        assert.match(out, /Level 5/, 'ordinary nesting depth must be unaffected');
        assert.ok(!out.includes('Level 24'), 'expansion must not run to the bottom of a 25-deep chain');
    });

    it('leaves the unexpanded directive in place rather than dropping content', () => {
        const out = resolveIncludes('[!include](level0.md)\n', dir);
        assert.match(out, /\[!include\]\(level\d+\.md\)/, 'the directive it stopped at stays visible');
    });

    it('does not interfere with a shallow include', () => {
        fs.writeFileSync(path.join(dir, 'leaf.md'), '# Leaf\n');
        const out = resolveIncludes('[!include](leaf.md)\n', dir);
        assert.match(out, /# Leaf/);
        assert.ok(!out.includes('[!include]'));
    });
});

// ── Diagram fences and figure captions ────────────────────────────────────────

describe('```infographic fences', () => {
    it('become a placeholder carrying the block source, for the renderer to find', async () => {
        const file = path.join(tmpDir, 'infographic-fence.md');
        const source = 'infographic list-grid-badge-card\ndata\n  lists\n    - label <Alpha> & co';
        const html = await convertMarkdownToHtml(file, `# Doc\n\n\`\`\`infographic\n${source}\n\`\`\`\n`);
        const m = /<pre class="infographic-block" data-src="([^"]+)"><\/pre>/.exec(html);
        assert.ok(m, 'placeholder present');
        assert.equal(Buffer.from(m[1], 'base64').toString('utf8').trimEnd(), source);
        assert.ok(!html.includes('&lt;Alpha&gt;'), 'the source is not also rendered as a code block');
    });
});

describe('applyCaptions', () => {
    const img = '<img src="x.png" alt="x">';

    it('numbers the caption under every renderer\'s diagram figure', () => {
        // The shared diagram-figure class is the point: this matched only
        // mermaid-figure, so Graphviz and infographic captions were never numbered.
        const html = ['mermaid', 'graphviz', 'infographic']
            .map(kind => `<div class="diagram-figure ${kind}-figure">${img}</div><p>Figure: ${kind}</p>`)
            .join('\n');
        const out = applyCaptions(html);
        assert.match(out, /id="figure-1"><span class="caption-label">Figure 1\.<\/span> mermaid<\/p>/);
        assert.match(out, /id="figure-2"><span class="caption-label">Figure 2\.<\/span> graphviz<\/p>/);
        assert.match(out, /id="figure-3"><span class="caption-label">Figure 3\.<\/span> infographic<\/p>/);
    });

    it('numbers plain images and diagrams in one sequence, in document order', () => {
        const html = `<p>${img}</p><p>Figure: photo</p><div class="diagram-figure graphviz-figure">${img}</div><p>Figure: graph</p>`;
        const out = applyCaptions(html);
        assert.match(out, /Figure 1\.<\/span> photo/);
        assert.match(out, /Figure 2\.<\/span> graph/);
    });

    it('leaves a Figure: paragraph that follows no figure alone', () => {
        const html = '<p>Some prose.</p><p>Figure: not a caption</p>';
        assert.equal(applyCaptions(html), html);
    });

    it('does not treat a figure-looking class that is not a diagram figure as one', () => {
        const html = `<div class="my-diagram-figure">${img}</div><p>Figure: x</p>`;
        assert.equal(applyCaptions(html), html);
    });
});
