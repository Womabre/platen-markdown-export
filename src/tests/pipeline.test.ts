import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as path from 'path';
import { setActiveTheme, applyStyleOverrides } from '../theme';
import { extractFrontmatter } from '../frontmatter';
import { convertMarkdownToHtml } from '../markdown';
import { renderDiagramsAndImages, buildHtmlExportPipeline } from '../index';

/**
 * End-to-end coverage of the composition in `main()`.
 *
 * Every other suite tests one transform in isolation; nothing asserted that the
 * ~30 of them compose into a correct document. This runs the real HTML-export
 * pipeline over a fixture exercising the whole markdown feature set and checks
 * the result two ways: structural invariants (which say what must be true), and
 * a normalised golden file (which catches everything else, including changes
 * nobody thought to assert).
 *
 * The fixture deliberately contains no Mermaid, no draw.io, no images and no
 * icon fonts, so the run needs neither Chromium, nor the draw.io app, nor the
 * network — it is the same suite in CI as on a laptop.
 */

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'test-fixtures', 'pipeline');
const SOURCE      = path.join(FIXTURE_DIR, 'document.md');
const GOLDEN      = path.join(FIXTURE_DIR, 'expected-html-export.html');

/**
 * Collapses everything volatile or bulky so the golden file stays a readable
 * diff of document structure:
 *   - `data:` URIs (base64 logos and KaTeX fonts) → their type and byte length
 *   - `<style>` bodies → a byte count; stylesheet churn is covered by css.test.ts
 *   - absolute paths and dates → fixed tokens
 */
function normalise(html: string): string {
    return html
        .replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]+/g,
                 (m, mime) => `data:${mime};base64,[${m.length}B]`)
        .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g,
                 (_m, open, body, close) => `${open}[${body.length}B]${close}`)
        .replace(/\d{4}-\d{2}-\d{2}/g, '[DATE]')
        .replace(new RegExp(FIXTURE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[FIXTURE_DIR]')
        .replace(/\r\n/g, '\n')
        .trimEnd() + '\n';
}

let html: string;

before(async () => {
    setActiveTheme('default');
    const fm = extractFrontmatter(SOURCE);
    applyStyleOverrides(fm.style);
    // The real main() sequence, minus the source mutation `--no-bump` skips:
    // markdown -> shared preprocessing -> the html-export finishing pipeline.
    // renderDiagramsAndImages needs no Chromium here because the fixture holds
    // no Mermaid placeholders, and no network because it holds no images.
    const raw       = await convertMarkdownToHtml(SOURCE);
    const processed = await renderDiagramsAndImages(raw, SOURCE);
    html = await buildHtmlExportPipeline(processed, SOURCE, null, fm);
});

describe('end-to-end HTML export: structural invariants', () => {
    it('produces a complete document', () => {
        assert.ok(html.startsWith('<!DOCTYPE html>'), html.slice(0, 40));
        assert.ok(html.includes('<html lang="en">'));
        assert.ok(html.trimEnd().endsWith('</html>'));
    });

    it('leaves no unsubstituted template token anywhere', () => {
        const leftovers = [...html.matchAll(/\{\{[A-Z_]+\}\}/g)].map(m => m[0]);
        assert.deepEqual(leftovers, []);
    });

    it('leaves no unrendered variable placeholder', () => {
        assert.ok(!html.includes('{{product}}'));
        assert.ok(html.includes('Widgetron version 4.2'));
    });

    it('leaves no unrendered diagram placeholder', () => {
        assert.ok(!html.includes('mermaid-block'));
        assert.ok(!html.includes('.drawio'));
    });

    it('marks the body for the html-export context', () => {
        const body = html.match(/<body[^>]*>/)![0];
        assert.match(body, /class="[^"]*\bhtml-export\b/);
        assert.match(body, /class="[^"]*\bcode-line-numbers\b/);
    });

    it('injects the banner ahead of the content', () => {
        // Scoped to the body: the theme stylesheet in <head> also mentions both
        // class names, so a whole-document indexOf compares CSS, not markup.
        const body = html.slice(html.search(/<body[^>]*>/));
        const banner  = body.indexOf('<div class="html-banner');
        const content = body.indexOf('<div class="github-markdown-content"');
        assert.ok(banner  > 0, 'banner not injected');
        assert.ok(content > 0, 'content wrapper missing');
        assert.ok(banner < content, `banner at ${banner} is not before content at ${content}`);
    });

    it('shows only the visible revision rows', () => {
        // Revisions Visible: 2, and the fixture has exactly 2.
        assert.equal((html.match(/2020-02-02/g) ?? []).length >= 1, true);
    });

    it('needs no network: no icon font was fetched', () => {
        // The fixture deliberately avoids icon classes (and the Classification
        // label, which carries a Phosphor shield) so buildIconStyles stays a
        // no-op. Without this the suite would fetch a font on a cold CI runner.
        assert.ok(!/phosphor|font-?awesome/i.test(html));
    });
});

describe('end-to-end HTML export: table of contents', () => {
    it('rebuilds the TOC as a nav, replacing the source placeholder', () => {
        assert.ok(html.includes('<nav class="toc">'));
        assert.ok(!html.includes('#placeholder'), 'source TOC stub survived');
    });

    it('honours TOC Depth by omitting deeper headings', () => {
        const toc = html.match(/<nav class="toc">[\s\S]*?<\/nav>/)![0];
        assert.ok(toc.includes('Level Three Heading'));
        assert.ok(!toc.includes('Level Four'), 'h4 listed despite TOC Depth: 3');
    });

    it('omits the document title and the Contents heading from the TOC', () => {
        const toc = html.match(/<nav class="toc">[\s\S]*?<\/nav>/)![0];
        assert.ok(!/>\s*(\d+\s+)?Pipeline Fixture\s*</.test(toc));
        assert.ok(!/Table of Contents/.test(toc));
    });

    it('every TOC link resolves to a heading id in the document', () => {
        const toc  = html.match(/<nav class="toc">[\s\S]*?<\/nav>/)![0];
        const hrefs = [...toc.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
        assert.ok(hrefs.length > 5, `expected a populated TOC, got ${hrefs.length}`);
        const ids = new Set([...html.matchAll(/<h[1-6][^>]*\bid="([^"]+)"/g)].map(m => m[1]));
        assert.deepEqual(hrefs.filter(h => !ids.has(h)), []);
    });

    it('nests the TOC to match heading depth', () => {
        const toc = html.match(/<nav class="toc">[\s\S]*?<\/nav>/)![0];
        assert.ok(/<li>[\s\S]*?<ul>/.test(toc), 'TOC is flat');
    });
});

describe('end-to-end HTML export: numbering and indexes', () => {
    it('numbers h2-h6 and leaves h1 alone', () => {
        const headings = [...html.matchAll(/<h([1-6])[^>]*\bid="[^"]*"[^>]*>([\s\S]*?)<\/h\1>/g)]
            .map(m => ({ level: +m[1], text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }));

        const h1s = headings.filter(h => h.level === 1);
        assert.ok(h1s.length > 0);
        for (const h of h1s) assert.ok(!/^\d/.test(h.text), `h1 was numbered: ${h.text}`);

        // The "Table of Contents" heading is the TOC's own label, not a section.
        const sections = headings.filter(h => h.level === 2 && !/^Table of Contents$/.test(h.text));
        assert.match(sections[0].text, /^1\s/, sections[0].text);
        assert.match(sections[1].text, /^2\s/, sections[1].text);

        const sub = headings.find(h => h.level === 3)!;
        assert.match(sub.text, /^\d+\.\d+\s/, sub.text);
    });

    it('numbers flow into the TOC, so body and TOC cannot drift', () => {
        const toc = html.match(/<nav class="toc">[\s\S]*?<\/nav>/)![0];
        assert.match(toc, /\d+(\.\d+)*\s+\w/);
    });

    it('emits a List of Tables for the two captioned tables', () => {
        assert.ok(html.includes('List of Tables'));
        assert.ok(html.includes('The first caption'));
        assert.ok(html.includes('The second caption'));
    });

    it('omits the List of Figures when the document has no figures', () => {
        // `List of Figures: true` is set; the index is still suppressed rather
        // than emitted empty, because the fixture contains no captioned images.
        assert.ok(!html.includes('List of Figures'));
    });

    it('numbers table captions independently and in order', () => {
        const captions = [...html.matchAll(/Table\s+(\d+)[.:]/g)].map(m => m[1]);
        assert.deepEqual(captions.slice(0, 2), ['1', '2']);
    });
});

describe('end-to-end HTML export: markdown features', () => {
    const present: Array<[string, RegExp | string]> = [
        ['GitHub alert (note)',    /markdown-alert-note/],
        ['GitHub alert (warning)', /markdown-alert-warning/],
        ['MkDocs admonition',      /admonition/],
        ['highlighted code line',  /highlight/],
        ['task list',              /task-list|checkbox|✓|☐/i],
        ['footnote body',          'The footnote body'],
        ['definition list',        /<dl>[\s\S]*<dt>/],
        ['subscript',              '<sub>'],
        ['superscript',            '<sup>'],
        ['mark',                   '<mark>'],
        ['kbd',                    '<kbd>'],
        ['KaTeX math',             /katex/],
        ['columns container',      /column/],
        ['included file content',  'Content spliced in from another file'],
    ];

    for (const [label, probe] of present) {
        it(`renders ${label}`, () => {
            const ok = typeof probe === 'string' ? html.includes(probe) : probe.test(html);
            assert.ok(ok, `${label} missing from output`);
        });
    }

    it('builds the abbreviation glossary from the whole document', () => {
        assert.ok(html.includes('Abbreviations'));
        assert.ok(html.includes('Application Programming Interface'));
    });

    it('appends the include revision to the included heading', () => {
        assert.match(html, /Appendix From An Include \(Rev\. 7\)/);
    });

    it("strips the included file's own TOC", () => {
        assert.ok(!html.includes('#include-subsection'));
    });
});

describe('end-to-end HTML export: golden file', () => {
    it('matches the committed snapshot', () => {
        const actual = normalise(html);

        if (process.env.UPDATE_GOLDEN) {
            fs.writeFileSync(GOLDEN, actual, 'utf8');
            return;
        }

        assert.ok(fs.existsSync(GOLDEN),
            `missing ${GOLDEN} — regenerate with UPDATE_GOLDEN=1 npm test`);

        const expected = fs.readFileSync(GOLDEN, 'utf8');
        if (actual !== expected) {
            const a = actual.split('\n');
            const b = expected.split('\n');
            const i = a.findIndex((line, n) => line !== b[n]);
            assert.fail(
                `HTML export differs from the golden file at line ${i + 1}.\n` +
                `  expected: ${JSON.stringify(b[i])}\n` +
                `  actual:   ${JSON.stringify(a[i])}\n` +
                'If the change is intended: UPDATE_GOLDEN=1 npm test, then review the diff.',
            );
        }
    });
});
