import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    loadHtmlTemplate,
    injectTocWrapper,
    rebuildToc,
    replaceTaskListInputs,
    inlineHexColorCode,
    inlineAlertIconColors,
    inlineAdmonitionIconColors,
    wrapEmoji,
    numberHeadings,
    buildCaptionIndex,
    injectCaptionIndexes,
    buildClassificationHeader,
    buildWatermark,
    injectPageChrome,
    addBodyClasses,
    TABLE_FIT_CSS,
    injectDocumentMetadata,
} from '../html';

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-html-test-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── loadHtmlTemplate ─────────────────────────────────────────────────────────

describe('loadHtmlTemplate', () => {
    it('throws for a missing file', () => {
        assert.throws(
            () => loadHtmlTemplate(path.join(tmpDir, 'nonexistent.html')),
            /HTML template not found/,
        );
    });

    it('throws when the file has no <body> element', () => {
        const file = path.join(tmpDir, 'nobody.html');
        fs.writeFileSync(file, '<div>no body here</div>');
        assert.throws(() => loadHtmlTemplate(file), /No <body> element found/);
    });

    it('extracts content between <body> tags', () => {
        const file = path.join(tmpDir, 'basic.html');
        fs.writeFileSync(file, '<html><body><p>Hello</p></body></html>');
        assert.ok(loadHtmlTemplate(file).includes('<p>Hello</p>'));
    });

    it('strips <script> blocks', () => {
        const file = path.join(tmpDir, 'script.html');
        fs.writeFileSync(file, '<html><body><p>Hi</p><script>alert(1)</script></body></html>');
        const result = loadHtmlTemplate(file);
        assert.ok(!result.includes('<script>'), `script should be removed: ${result}`);
        assert.ok(result.includes('<p>Hi</p>'));
    });

    it('strips <template> elements', () => {
        const file = path.join(tmpDir, 'template.html');
        fs.writeFileSync(file, '<html><body><p>Hi</p><template id="t"><span>data</span></template></body></html>');
        const result = loadHtmlTemplate(file);
        assert.ok(!result.includes('<template'), `template should be removed: ${result}`);
    });

    it('replaces {{TOKEN}} placeholders', () => {
        const file = path.join(tmpDir, 'tokens.html');
        fs.writeFileSync(file, '<html><body><p>{{GREETING}}</p></body></html>');
        assert.ok(loadHtmlTemplate(file, { GREETING: 'Hello World' }).includes('Hello World'));
    });

    it('replaces comment-wrapped <!--{{TOKEN}}--> placeholders', () => {
        const file = path.join(tmpDir, 'comment-tokens.html');
        fs.writeFileSync(file, '<html><body><tbody><!--{{ROW}}--></tbody></body></html>');
        assert.ok(loadHtmlTemplate(file, { ROW: '<tr><td>data</td></tr>' }).includes('<tr>'));
    });

    it('ignores a literal <body> mentioned inside an HTML comment', () => {
        // A doc comment that names the <body> tag must not fool body extraction
        // into dragging the head (e.g. stylesheet <link>s) into the output.
        const file = path.join(tmpDir, 'comment-body.html');
        fs.writeFileSync(file,
            '<!-- Only the <body> markup is exported -->\n' +
            '<html><head><link rel="stylesheet" href="../css/cover.css"></head>' +
            '<body><p>Real</p></body></html>');
        const result = loadHtmlTemplate(file);
        assert.ok(!result.includes('<link'), `head <link> must not leak: ${result}`);
        assert.ok(result.includes('<p>Real</p>'));
    });

    it('replaces all occurrences of a token', () => {
        const file = path.join(tmpDir, 'multi-token.html');
        fs.writeFileSync(file, '<html><body><p>{{X}}</p><p>{{X}}</p></body></html>');
        const result = loadHtmlTemplate(file, { X: 'replaced' });
        assert.equal((result.match(/replaced/g) ?? []).length, 2);
    });

    it('returns trimmed content', () => {
        const file = path.join(tmpDir, 'whitespace.html');
        fs.writeFileSync(file, '<html><body>  \n  <p>text</p>  \n  </body></html>');
        const result = loadHtmlTemplate(file);
        assert.ok(!result.startsWith(' ') && !result.endsWith(' '));
    });
});

// ── rebuildToc ────────────────────────────────────────────────────────────────

describe('rebuildToc', () => {
    it('returns unchanged HTML when no <nav class="toc"> is present', () => {
        const html = '<h1 id="s1">Section</h1><p>body</p>';
        assert.equal(rebuildToc(html), html);
    });

    it('returns unchanged HTML when no headings with IDs are found', () => {
        const html = '<nav class="toc"><ul><li>old</li></ul></nav><p>no headings</p>';
        assert.equal(rebuildToc(html), html);
    });

    it('replaces nav content with rebuilt list from page headings', () => {
        const html = [
            '<nav class="toc"><ul><li>old</li></ul></nav>',
            '<h1 id="title">Document Title</h1>',
            '<h2 id="intro">Introduction</h2>',
            '<h2 id="body">Body</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(result.includes('<a href="#intro">Introduction</a>'));
        assert.ok(result.includes('<a href="#body">Body</a>'));
        assert.ok(!result.includes('old'));
    });

    it('omits the document\'s first heading when it is an <h1> (the title)', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h1 id="title">Document Title</h1>',
            '<h2 id="s1">Section</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(!result.includes('"#title"'), 'title heading should be excluded');
        assert.ok(result.includes('"#s1"'));
    });

    it('keeps a later <h1> that is not the document\'s first heading', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h1 id="title">Document Title</h1>',
            '<h2 id="intro">Introduction</h2>',
            '<h1 id="demo">Heading 1 Demo</h1>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(!result.includes('"#title"'), 'title heading should still be excluded');
        assert.ok(result.includes('"#demo"'), 'a later h1 is real content, not the title');
    });

    it('keeps the first heading when it is not an <h1>', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h2 id="s1">Section</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(result.includes('"#s1"'), 'a non-h1 first heading is not treated as the title');
    });

    it('skips headings whose text matches TOC label patterns', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h2 id="toc">Table of Contents</h2>',
            '<h2 id="intro">Introduction</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(!result.includes('"#toc"'), 'TOC heading should be excluded');
        assert.ok(result.includes('"#intro"'));
    });

    it('skips headings whose text matches Dutch TOC label', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h2 id="inh">Inhoudsopgave</h2>',
            '<h2 id="s1">Section</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(!result.includes('"#inh"'));
        assert.ok(result.includes('"#s1"'));
    });

    it('strips inline tags from heading text', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h1 id="title">Document Title</h1>',
            '<h2 id="s1"><strong>Bold</strong> Heading</h2>',
        ].join('\n');
        const result = rebuildToc(html);
        assert.ok(result.includes('Bold Heading'));
        const navMatch = result.match(/<nav class="toc">[\s\S]*?<\/nav>/);
        assert.ok(navMatch && !navMatch[0].includes('<strong>'), 'nav link text should have inline tags stripped');
    });

    it('builds a nested list for h1 + h2 headings', () => {
        const html = [
            '<nav class="toc"><ul></ul></nav>',
            '<h1 id="title">Document Title</h1>',
            '<h1 id="ch1">Chapter 1</h1>',
            '<h2 id="sec1">Section 1</h2>',
            '<h2 id="sec2">Section 2</h2>',
            '<h1 id="ch2">Chapter 2</h1>',
        ].join('\n');
        const result = rebuildToc(html);
        // h2 items should appear nested inside h1 list items
        const ch1Pos  = result.indexOf('"#ch1"');
        const sec1Pos = result.indexOf('"#sec1"');
        const ch2Pos  = result.indexOf('"#ch2"');
        assert.ok(ch1Pos < sec1Pos && sec1Pos < ch2Pos, 'headings should appear in document order');
        // Nested ul for the h2 children
        assert.ok(result.includes('<ul>'), 'nested ul should be present');
    });
});

// ── replaceTaskListInputs ─────────────────────────────────────────────────────

describe('replaceTaskListInputs', () => {
    it('replaces an unchecked checkbox with an SVG', () => {
        const result = replaceTaskListInputs('<input type="checkbox">');
        assert.ok(result.includes('<svg'), 'should produce an SVG');
        assert.ok(!result.includes('<input'), 'input should be removed');
    });

    it('replaces a checked checkbox with the checked SVG (blue fill)', () => {
        const result = replaceTaskListInputs('<input type="checkbox" checked>');
        assert.ok(result.includes('fill="#2563eb"'), `expected blue fill, got: ${result}`);
    });

    it('replaces an unchecked checkbox with the unchecked SVG (grey stroke)', () => {
        const result = replaceTaskListInputs('<input type="checkbox">');
        assert.ok(result.includes('stroke="#bbb"'), `expected grey stroke, got: ${result}`);
    });

    it('handles checked attribute before type', () => {
        const result = replaceTaskListInputs('<input checked type="checkbox">');
        assert.ok(result.includes('fill="#2563eb"'));
    });

    it('handles checked attribute with other attributes around it', () => {
        const result = replaceTaskListInputs('<input disabled type="checkbox" checked class="task">');
        assert.ok(result.includes('fill="#2563eb"'));
    });

    it('is case-insensitive for the type attribute value', () => {
        const result = replaceTaskListInputs('<input type="Checkbox">');
        assert.ok(result.includes('<svg'));
    });

    it('leaves non-checkbox inputs unchanged', () => {
        const html = '<input type="text" value="hello">';
        assert.equal(replaceTaskListInputs(html), html);
    });

    it('replaces multiple checkboxes in one pass', () => {
        const html = '<input type="checkbox" checked> done\n<input type="checkbox"> todo';
        const result = replaceTaskListInputs(html);
        assert.ok(!result.includes('<input'), 'all inputs should be replaced');
        assert.ok(result.includes('fill="#2563eb"'), 'checked item should be blue');
        assert.ok(result.includes('stroke="#bbb"'), 'unchecked item should be grey');
    });
});

// ── inlineHexColorCode ────────────────────────────────────────────────────────

describe('inlineHexColorCode', () => {
    it('returns unchanged HTML when there are no <code> elements', () => {
        const html = '<p>No code here #abc</p>';
        assert.equal(inlineHexColorCode(html), html);
    });

    it('leaves <code> with non-hex content unchanged', () => {
        const html = '<code>hello world</code>';
        assert.equal(inlineHexColorCode(html), html);
    });

    it('applies background style to a pure dark hex <code> and uses white text', () => {
        // Navy `main` from the default theme, which is dark enough that WCAG
        // contrast puts white on it. The colour has to be genuinely dark for
        // this case to cover the white-text branch at all: a mid-tone like the
        // green below reads better with dark text, and asserting white on it
        // only tests that the threshold is broken.
        const result = inlineHexColorCode('<code>#224466</code>');
        assert.ok(result.includes('background:#224466'), `got: ${result}`);
        assert.ok(result.includes('color:#ffffff'), `expected white text for dark color, got: ${result}`);
    });

    it('applies background style to a pure light hex <code> and uses dark text', () => {
        const result = inlineHexColorCode('<code>#ffffff</code>');
        assert.ok(result.includes('background:#ffffff'), `got: ${result}`);
        assert.ok(result.includes('color:#1a1a1a'), `expected dark text for light color, got: ${result}`);
    });

    it('handles 3-digit short hex', () => {
        const result = inlineHexColorCode('<code>#abc</code>');
        assert.ok(result.includes('background:#abc'), `got: ${result}`);
    });

    it('wraps a hex token in a pill span when mixed with other text', () => {
        const result = inlineHexColorCode('<code>color: #009146</code>');
        assert.ok(result.includes('<span style="background:#009146'), `got: ${result}`);
        assert.ok(result.includes('color: '), 'surrounding text should remain');
    });

    it('handles multiple hex tokens in mixed content', () => {
        const result = inlineHexColorCode('<code>from #fff to #000</code>');
        assert.ok(result.includes('background:#fff'), `got: ${result}`);
        assert.ok(result.includes('background:#000'), `got: ${result}`);
    });

    it('preserves <pre> blocks unchanged', () => {
        const html = '<pre><code>#009146 is a color</code></pre>';
        assert.equal(inlineHexColorCode(html), html);
    });

    it('does not colorize hex strings inside <pre> even when followed by <code> outside', () => {
        const html = '<pre>#fff</pre><code>#fff</code>';
        const result = inlineHexColorCode(html);
        assert.ok(result.startsWith('<pre>#fff</pre>'), `pre block should be unchanged: ${result}`);
        assert.ok(result.includes('background:#fff'), 'standalone code should be colorized');
    });
});

// ── injectTocWrapper ──────────────────────────────────────────────────────────

describe('injectTocWrapper', () => {
    it('wraps a TOC list following a "Table of Contents" heading', () => {
        const html = [
            '<h2 id="toc">Table of Contents</h2>',
            '<ul>',
            '  <li><a href="#intro">Introduction</a></li>',
            '  <li><a href="#body">Body</a></li>',
            '</ul>',
        ].join('\n');

        const result = injectTocWrapper(html);
        assert.ok(result.includes('<nav class="toc">'), 'should inject nav.toc');
        assert.ok(result.includes('</nav>'), 'should close nav');
        assert.ok(!result.match(/<ul>[\s\S]*?<\/ul>(?![^<]*<\/nav>)/), 'ul should be inside nav');
    });

    it('wraps a TOC list with "Contents" heading variant', () => {
        const html = '<h1>Contents</h1>\n<ul>\n<li><a href="#s1">S1</a></li>\n</ul>';
        const result = injectTocWrapper(html);
        assert.ok(result.includes('<nav class="toc">'));
    });

    it('wraps a TOC list with "Inhoudsopgave" heading variant', () => {
        const html = '<h2>Inhoudsopgave</h2>\n<ul>\n<li><a href="#s1">S1</a></li>\n</ul>';
        const result = injectTocWrapper(html);
        assert.ok(result.includes('<nav class="toc">'));
    });

    it('does not wrap when ul contains non-hash anchors', () => {
        const html = '<ul>\n<li><a href="https://example.com">External</a></li>\n</ul>';
        const result = injectTocWrapper(html);
        assert.equal(result, html, 'should return unchanged when anchors are not hash links');
        assert.ok(!result.includes('<nav class="toc">'));
    });

    it('returns unchanged when there is no ul element', () => {
        const html = '<p>No list here.</p>';
        assert.equal(injectTocWrapper(html), html);
    });

    it('handles nested ul correctly and wraps only the outermost', () => {
        const html = [
            '<h2>Table of Contents</h2>',
            '<ul>',
            '  <li><a href="#a">A</a>',
            '    <ul><li><a href="#a1">A1</a></li></ul>',
            '  </li>',
            '</ul>',
        ].join('\n');

        const result = injectTocWrapper(html);
        assert.ok(result.includes('<nav class="toc">'));
        // Only one nav wrapper
        assert.equal((result.match(/<nav class="toc">/g) ?? []).length, 1);
    });
});

// ── inlineAlertIconColors ─────────────────────────────────────────────────────

describe('inlineAlertIconColors', () => {
    it('injects the note color onto path elements inside a note alert', () => {
        const html = [
            '<div class="markdown-alert markdown-alert-note">',
            '  <svg><path d="M1 1"/></svg>',
            '  <p>Note text</p>',
            '</div>',
        ].join('\n');

        const result = inlineAlertIconColors(html);
        // Note color is #0969da
        assert.ok(result.includes('fill="#0969da"'), `got: ${result}`);
    });

    it('injects the warning color for warning alerts', () => {
        const html = [
            '<div class="markdown-alert markdown-alert-warning">',
            '  <svg><path d="M0 0"/></svg>',
            '</div>',
        ].join('\n');

        const result = inlineAlertIconColors(html);
        assert.ok(result.includes('fill="#9a6700"'));
    });

    it('leaves blocks without an alert class unchanged', () => {
        const html = '<div class="normal-block"><svg><path d="M0 0"/></svg></div>';
        assert.equal(inlineAlertIconColors(html), html);
    });

    it('does not add fill to path elements outside alert divs', () => {
        const html = [
            '<div class="markdown-alert markdown-alert-tip">',
            '  <p>tip</p>',
            '</div>',
            '<div class="other"><svg><path d="M0 0"/></svg></div>',
        ].join('\n');

        const result = inlineAlertIconColors(html);
        // The path in the non-alert div should not get a fill attribute
        const [, afterAlert] = result.split('</div>');
        assert.ok(!afterAlert?.includes('fill='), `path outside alert should not have fill, got: ${afterAlert}`);
    });
});

// ── inlineAdmonitionIconColors ────────────────────────────────────────────────

describe('inlineAdmonitionIconColors', () => {
    it('replaces fill="currentColor" inside an admonition-note heading', () => {
        const html = [
            '<div class="admonition admonition-note">',
            '  <div class="admonition-heading">',
            '    <svg><path fill="currentColor" d="M0 0"/></svg>',
            '    <span>Note</span>',
            '  </div>',
            '  <p>Content</p>',
            '</div>',
        ].join('\n');

        const result = inlineAdmonitionIconColors(html);
        assert.ok(result.includes('fill="#1565c0"'), `got: ${result}`);
        assert.ok(!result.includes('fill="currentColor"'), 'currentColor should be replaced');
    });

    it('leaves content outside the heading div unchanged', () => {
        const html = [
            '<div class="admonition admonition-tip">',
            '  <div class="admonition-heading">',
            '    <svg><path fill="currentColor" d="M0 0"/></svg>',
            '  </div>',
            '  <p><svg><path fill="currentColor" d="M1 1"/></svg></p>',
            '</div>',
        ].join('\n');

        const result = inlineAdmonitionIconColors(html);
        // Heading should have color applied
        assert.ok(result.includes('fill="#007a6e"'));
        // The path in the content (after the heading div) should still have currentColor
        const afterHeading = result.slice(result.indexOf('</div>') + 6);
        assert.ok(afterHeading.includes('fill="currentColor"'), 'content path should keep currentColor');
    });

    it('leaves non-admonition blocks unchanged', () => {
        const html = '<div class="info-box"><svg><path fill="currentColor"/></svg></div>';
        assert.equal(inlineAdmonitionIconColors(html), html);
    });
});

// ── wrapEmoji ─────────────────────────────────────────────────────────────────

describe('wrapEmoji', () => {
    it('replaces emoji with an inline Twemoji <img>', () => {
        const out = wrapEmoji('<p>Hi 🎉 there</p>');
        assert.match(out, /<img class="emoji" alt="🎉" src="[^"]*\/1f389\.svg">/u);
    });

    it('maps a multi-codepoint (ZWJ + skin tone) emoji to one image', () => {
        const out = wrapEmoji('<p>👩🏾‍💻 dev</p>');
        assert.match(out, /\/1f469-1f3fe-200d-1f4bb\.svg/);
        assert.equal((out.match(/class="emoji"/g) ?? []).length, 1);
    });

    it('strips VS16 from a non-ZWJ emoji codepoint name', () => {
        // ⚠️ is U+26A0 U+FE0F →  file is 26a0.svg (no fe0f).
        assert.match(wrapEmoji('<p>⚠️</p>'), /\/26a0\.svg/);
    });

    it('leaves text-presentation characters (VS15) as text', () => {
        // ↩︎ (U+21A9 U+FE0E) is the footnote back-arrow — must not become an image.
        const html = '<p>back ↩︎</p>';
        assert.equal(wrapEmoji(html), html);
    });

    it('leaves emoji inside <code>/<pre> untouched', () => {
        const html = '<pre><code>x = "🎉"</code></pre>';
        assert.equal(wrapEmoji(html), html);
    });

    it('does not touch emoji inside tag attributes', () => {
        const html = '<img alt="🎉" src="x.png">';
        assert.equal(wrapEmoji(html), html);
    });

    it('returns text without emoji unchanged', () => {
        const html = '<p>plain text</p>';
        assert.equal(wrapEmoji(html), html);
    });
});

// ── Heading auto-numbering ────────────────────────────────────────────────────

describe('numberHeadings', () => {
    const h = (level: number, id: string, text: string) =>
        `<h${level} id="${id}">${text}</h${level}>`;

    it('numbers h2-h6 hierarchically and resets deeper levels', () => {
        const out = numberHeadings(
            h(2, 'a', 'Alpha') + h(3, 'a1', 'Sub') + h(4, 'a1a', 'Deep') + h(2, 'b', 'Beta') + h(3, 'b1', 'Sub2'),
        );
        assert.match(out, /<span class="heading-number">1<\/span> Alpha/);
        assert.match(out, /<span class="heading-number">1\.1<\/span> Sub/);
        assert.match(out, /<span class="heading-number">1\.1\.1<\/span> Deep/);
        assert.match(out, /<span class="heading-number">2<\/span> Beta/);
        assert.match(out, /<span class="heading-number">2\.1<\/span> Sub2/);
    });

    it('never numbers h1 — it is the document title, not a section', () => {
        const out = numberHeadings(h(1, 't', 'Title') + h(2, 'a', 'Alpha'));
        assert.match(out, /<h1 id="t">Title<\/h1>/);
        assert.match(out, /<span class="heading-number">1<\/span> Alpha/);
    });

    it('skips the Contents heading without consuming a number', () => {
        const out = numberHeadings(h(2, 'contents', 'Contents') + h(2, 'a', 'Alpha'));
        assert.match(out, /<h2 id="contents">Contents<\/h2>/);
        assert.match(out, /<span class="heading-number">1<\/span> Alpha/);
    });

    it('leaves id-less headings (the generated glossary) alone', () => {
        const out = numberHeadings('<h2>Abbreviations</h2>' + h(2, 'a', 'Alpha'));
        assert.match(out, /<h2>Abbreviations<\/h2>/);
        assert.match(out, /<span class="heading-number">1<\/span> Alpha/);
    });

    it('emits a real space so the number survives into the tag-stripped TOC', () => {
        const numbered = numberHeadings(h(2, 'a', 'Alpha'));
        const stripped = numbered.replace(/<[^>]+>/g, '');
        assert.equal(stripped, '1 Alpha');
    });

    it('numbers flow into the rebuilt TOC', () => {
        const doc = '<nav class="toc"><ul><li>old</li></ul></nav>' + h(2, 'a', 'Alpha');
        const out = rebuildToc(numberHeadings(doc));
        assert.match(out, /<a href="#a">1 Alpha<\/a>/);
    });
});

// ── List of Tables / Figures ──────────────────────────────────────────────────

describe('buildCaptionIndex', () => {
    const captions =
        '<p class="caption caption-table" id="table-1"><span class="caption-label">Table 1.</span> First</p>' +
        '<p class="caption caption-table" id="table-2"><span class="caption-label">Table 2.</span> Second</p>' +
        '<p class="caption caption-figure" id="figure-1"><span class="caption-label">Figure 1.</span> Pic</p>';

    it('lists only captions of the requested kind, linked by id', () => {
        const out = buildCaptionIndex(captions, 'table', 'List of Tables');
        assert.match(out, /<h2 class="caption-index-heading">List of Tables<\/h2>/);
        assert.match(out, /<a href="#table-1">Table 1\. First<\/a>/);
        assert.match(out, /<a href="#table-2">Table 2\. Second<\/a>/);
        assert.doesNotMatch(out, /figure-1/);
    });

    it('returns empty string when the document has no captions of that kind', () => {
        assert.equal(buildCaptionIndex('<p>nothing</p>', 'figure', 'List of Figures'), '');
    });

    it('injects indexes right after the TOC nav', () => {
        const doc = '<nav class="toc"><ul></ul></nav><h2>Body</h2>';
        const out = injectCaptionIndexes(doc, ['<nav class="caption-index">X</nav>']);
        assert.match(out, /<\/nav>\n<nav class="caption-index">X<\/nav><h2>Body<\/h2>/);
    });

    it('is a no-op when there is no TOC to anchor to', () => {
        const doc = '<h2>Body</h2>';
        assert.equal(injectCaptionIndexes(doc, ['<nav class="caption-index">X</nav>']), doc);
    });
});

// ── Page chrome: classification + watermark ───────────────────────────────────

describe('page chrome', () => {
    it('renders Internal with the amber duotone shield', () => {
        const out = buildClassificationHeader('Internal');
        assert.match(out, /ph-duotone ph-shield/);
        assert.match(out, /#eaa300/);
        assert.match(out, /Internal/);
    });

    it('renders Confidential with the orange duotone shield', () => {
        const out = buildClassificationHeader('Confidential');
        assert.match(out, /#f7630a/);
        assert.match(out, /Confidential/);
    });

    it('renders Public with the green duotone shield', () => {
        const out = buildClassificationHeader('Public');
        assert.match(out, /ph-duotone ph-shield/);
        assert.match(out, /#14a10f/);
        assert.match(out, /Public/);
    });

    it('escapes watermark text', () => {
        assert.match(buildWatermark('A & <B>'), /A &amp; &lt;B&gt;/);
    });

    it('injects chrome directly after <body>, preserving body attributes', () => {
        const out = injectPageChrome('<body class="x">\n<p>hi</p>', ['<div id="page-watermark">W</div>']);
        assert.match(out, /<body class="x">\n<div id="page-watermark">W<\/div>\n<p>hi<\/p>/);
    });

    it('is a no-op when every chrome element is empty', () => {
        const doc = '<body>\n<p>hi</p>';
        assert.equal(injectPageChrome(doc, ['', '']), doc);
    });
});

// ── TOC depth ─────────────────────────────────────────────────────────────────

describe('rebuildToc — TOC Depth', () => {
    const doc = [
        '<nav class="toc"><ul></ul></nav>',
        '<h1 id="title">Title</h1>',
        '<h2 id="a">Alpha</h2>',
        '<h3 id="a1">Sub</h3>',
        '<h4 id="a1a">Deep</h4>',
    ].join('\n');

    it('lists every level when no depth is given', () => {
        const out = rebuildToc(doc);
        for (const id of ['#a', '#a1', '#a1a']) assert.ok(out.includes(`"${id}"`), id);
    });

    it('drops headings deeper than the limit', () => {
        const out = rebuildToc(doc, 3);
        assert.ok(out.includes('"#a"'));
        assert.ok(out.includes('"#a1"'));
        assert.ok(!out.includes('"#a1a"'), 'h4 is past depth 3');
    });

    it('depth 2 keeps only the top sections', () => {
        const out = rebuildToc(doc, 2);
        assert.ok(out.includes('"#a"'));
        assert.ok(!out.includes('"#a1"'));
    });
});

// ── Tables never break words ──────────────────────────────────────────────────

describe('TABLE_FIT_CSS', () => {
    it('never lets a table break a word', () => {
        // A value split mid-word reads as a typo. Wide tables buy their width
        // back from padding and type size instead.
        assert.doesNotMatch(TABLE_FIT_CSS, /overflow-wrap:\s*anywhere/);
        assert.doesNotMatch(TABLE_FIT_CSS, /overflow-wrap:\s*break-word/);
        assert.doesNotMatch(TABLE_FIT_CSS, /word-break:\s*break-(all|word)/);
        assert.match(TABLE_FIT_CSS, /overflow-wrap:\s*normal/);
        assert.match(TABLE_FIT_CSS, /word-break:\s*normal/);
        assert.match(TABLE_FIT_CSS, /hyphens:\s*none/);
    });

    it('gives dense tables a non-word-breaking way to fit', () => {
        const dense = /\.table-dense[\s\S]*?\}/.exec(TABLE_FIT_CSS);
        assert.ok(dense, 'a .table-dense rule should exist');
        assert.match(dense[0], /font-size:/);
        assert.match(dense[0], /padding:/);
    });
});

// ── addBodyClasses ────────────────────────────────────────────────────────────

describe('addBodyClasses', () => {
    it('prepends to an existing class attribute', () => {
        assert.equal(
            addBodyClasses('<body class="vscode-body vscode-light">x</body>', ['html-export']),
            '<body class="html-export vscode-body vscode-light">x</body>',
        );
    });

    it('adds a class attribute to a bare <body>', () => {
        // The regression this exists for: the html-export pipeline matched only
        // bodies that ALREADY had a class, so a hand-written .html input was
        // never marked and body.html-export layout CSS silently did nothing.
        assert.equal(
            addBodyClasses('<body>x</body>', ['html-export']),
            '<body class="html-export">x</body>',
        );
    });

    it('adds a class attribute to a <body> that has other attributes', () => {
        assert.equal(
            addBodyClasses('<body id="top" data-x="1">x</body>', ['html-export']),
            '<body id="top" data-x="1" class="html-export">x</body>',
        );
    });

    it('handles a single-quoted class attribute', () => {
        assert.equal(
            addBodyClasses("<body class='a b'>x</body>", ['html-export']),
            "<body class='html-export a b'>x</body>",
        );
    });

    it('adds several classes in order', () => {
        assert.equal(
            addBodyClasses('<body class="vscode-body">x</body>', ['html-export', 'code-line-numbers']),
            '<body class="html-export code-line-numbers vscode-body">x</body>',
        );
    });

    it('drops falsy entries, so a conditional class needs no filtering at the call site', () => {
        assert.equal(
            addBodyClasses('<body class="a">x</body>', ['html-export', false, null, undefined]),
            '<body class="html-export a">x</body>',
        );
    });

    it('is a no-op when there is nothing to add', () => {
        const html = '<body class="a">x</body>';
        assert.equal(addBodyClasses(html, []), html);
        assert.equal(addBodyClasses(html, [false, null]), html);
    });

    it('only touches the first <body> and leaves later prose alone', () => {
        const html = '<body>x <code>&lt;body class="y"&gt;</code></body>';
        const out  = addBodyClasses(html, ['html-export']);
        assert.equal(out, '<body class="html-export">x <code>&lt;body class="y"&gt;</code></body>');
    });

    it('leaves a document with no <body> untouched', () => {
        const html = '<div>fragment</div>';
        assert.equal(addBodyClasses(html, ['html-export']), html);
    });
});


// ── injectDocumentMetadata ────────────────────────────────────────────────────

describe('injectDocumentMetadata', () => {
    const HEAD = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n</head>\n<body></body></html>';

    // Nothing emitted either of these, so the exported PDF carried no /Title and
    // no /Author at all — the frontmatter had both the whole time. /Title is what
    // a PDF reader shows in its Document Properties, what a DMS indexes on, and
    // what PDF/UA requires; this tool exists to produce exactly that kind of
    // controlled deliverable.
    it('adds a title and an author from the document', () => {
        const out = injectDocumentMetadata(HEAD, { title: 'Quarterly Report', author: 'Jane Doe' });
        assert.match(out, /<title>Quarterly Report<\/title>/);
        assert.match(out, /<meta name="author" content="Jane Doe">/);
    });

    it('puts them inside <head>, not before it', () => {
        const out = injectDocumentMetadata(HEAD, { title: 'T', author: 'A' });
        assert.ok(out.indexOf('<head>') < out.indexOf('<title>'), 'title must be inside head');
        assert.ok(out.indexOf('<title>') < out.indexOf('</head>'), 'title must be inside head');
    });

    it('escapes a title that contains markup or quotes', () => {
        const out = injectDocumentMetadata(HEAD, { title: 'A <b>&</b> "B"', author: 'X & Y' });
        assert.match(out, /<title>A &lt;b&gt;&amp;&lt;\/b&gt; &quot;B&quot;<\/title>/);
        assert.match(out, /content="X &amp; Y"/);
    });

    it('does not let $& in a title expand against the match', () => {
        // A string replacement treats `$&` as "the matched text", which would
        // splice `<head>` into the title. A function replacement has no such
        // syntax — the same rule literal() exists for. The `&` is then escaped
        // as ordinary content, which is why this reads `$&amp;` and not `$&`.
        const out = injectDocumentMetadata(HEAD, { title: 'Q1 $& Q2', author: null });
        assert.match(out, /<title>Q1 \$&amp; Q2<\/title>/);
        assert.doesNotMatch(out, /<title>[^<]*<head/, 'the match must not be spliced in');
    });

    it('never overwrites a title or author the document already declares', () => {
        // An .html input said something deliberate; the frontmatter may only be
        // a sibling .md guess.
        const own = '<head><title>Mine</title><meta name="author" content="Me"></head>';
        const out = injectDocumentMetadata(own, { title: 'Theirs', author: 'Them' });
        assert.match(out, /<title>Mine<\/title>/);
        assert.doesNotMatch(out, /Theirs/);
        assert.doesNotMatch(out, /Them/);
    });

    it('adds nothing for absent values, leaving the heading fallback in place', () => {
        assert.equal(injectDocumentMetadata(HEAD, { title: null, author: null }), HEAD);
        assert.equal(injectDocumentMetadata(HEAD, { title: '', author: undefined }), HEAD);
    });

    it('adds only the half that is missing', () => {
        const out = injectDocumentMetadata('<head><title>Mine</title></head>', { title: 'T', author: 'A' });
        assert.match(out, /<title>Mine<\/title>/);
        assert.match(out, /name="author" content="A"/);
    });
});
