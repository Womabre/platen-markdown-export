import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    graphvizPlaceholder, GRAPHVIZ_PLACEHOLDER_CLASS, hasGraphvizPlaceholders,
    graphvizErrorReplacement, applyGraphvizReplacements, graphvizSvgToDataUrl,
    renderGraphvizDiagrams,
} from '../graphviz';
import { warningCount, resetWarnings, setQuiet } from '../logger';

describe('graphvizPlaceholder', () => {
    it('returns a <pre> element with the correct class', () => {
        const result = graphvizPlaceholder('digraph { a -> b; }');
        assert.ok(result.startsWith(`<pre class="${GRAPHVIZ_PLACEHOLDER_CLASS}"`), `got: ${result}`);
        assert.ok(result.endsWith('></pre>'), `got: ${result}`);
    });

    it('encodes the diagram source as base64 in the data-src attribute', () => {
        const source = 'digraph { a -> b; }';
        const result = graphvizPlaceholder(source);
        const match  = result.match(/data-src="([^"]+)"/);
        assert.ok(match, 'data-src attribute should be present');
        assert.equal(Buffer.from(match![1], 'base64').toString('utf8'), source);
    });

    it('handles special HTML characters in the diagram source safely', () => {
        const source = 'digraph { a [label="<hello> & \\"quotes\\""] -> b; }';
        const result = graphvizPlaceholder(source);
        const match  = result.match(/data-src="([^"]+)"/);
        assert.ok(match, 'data-src should be present for source with special chars');
        assert.equal(Buffer.from(match![1], 'base64').toString('utf8'), source);
    });

    it('produces unique placeholders for different sources', () => {
        const a = graphvizPlaceholder('digraph { a -> b; }');
        const b = graphvizPlaceholder('graph { a -- b; }');
        assert.notEqual(a, b);
    });

    it('produces identical placeholders for identical sources', () => {
        const source = 'digraph { x -> y; }';
        assert.equal(graphvizPlaceholder(source), graphvizPlaceholder(source));
    });
});

// ── SVG post-processing ───────────────────────────────────────────────────────

describe('graphvizSvgToDataUrl', () => {
    const decode = (url: string): string => {
        assert.match(url, /^data:image\/svg\+xml;base64,/);
        return Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    };

    it('round-trips an ordinary SVG unchanged', () => {
        const svg = '<svg viewBox="0 0 10 10"><text>hello</text></svg>';
        assert.equal(decode(graphvizSvgToDataUrl(svg)), svg);
    });

    it('strips emoji by default (stripEmoji omitted)', () => {
        const svg = decode(graphvizSvgToDataUrl('<svg><text>Ship it 🚀</text></svg>'));
        assert.equal(svg, '<svg><text>Ship it </text></svg>');
    });

    it('keeps emoji when the caller confirms the target WeasyPrint can render them', () => {
        const svg = decode(graphvizSvgToDataUrl('<svg><text>Ship it 🚀</text></svg>', false));
        assert.equal(svg, '<svg><text>Ship it 🚀</text></svg>');
    });
});

// ── Substitution back into the document ───────────────────────────────────────

describe('applyGraphvizReplacements', () => {
    const ph = (src: string) => graphvizPlaceholder(src);

    it('substitutes each diagram where its placeholder was', () => {
        const a = ph('digraph { a -> b; }');
        const b = ph('graph { c -- d; }');
        const out = applyGraphvizReplacements(`<p>one</p>${a}<p>two</p>${b}`, [
            { placeholder: a, replacement: '<img alt="Graphviz diagram 1">' },
            { placeholder: b, replacement: '<img alt="Graphviz diagram 2">' },
        ]);
        assert.equal(out, '<p>one</p><img alt="Graphviz diagram 1"><p>two</p><img alt="Graphviz diagram 2">');
    });

    it('gives two identical diagrams their own replacement, in order', () => {
        const same = ph('digraph { a -> b; }');
        const out = applyGraphvizReplacements(`${same}${same}`, [
            { placeholder: same, replacement: '<img alt="Graphviz diagram 1">' },
            { placeholder: same, replacement: '<img alt="Graphviz diagram 2">' },
        ]);
        assert.equal(out, '<img alt="Graphviz diagram 1"><img alt="Graphviz diagram 2">');
    });

    it('leaves a document with no placeholder exactly as it was', () => {
        const orphan = ph('digraph { x -> y; }');
        assert.equal(applyGraphvizReplacements(orphan, []), orphan);
    });

    it('inserts a replacement verbatim, even one full of $ patterns', () => {
        const p = ph('digraph { a -> b; }');
        const out = applyGraphvizReplacements(p, [{ placeholder: p, replacement: '<img src="a$&b$`c">' }]);
        assert.equal(out, '<img src="a$&b$`c">');
    });
});

// ── hasGraphvizPlaceholders ───────────────────────────────────────────────────

describe('hasGraphvizPlaceholders', () => {
    const doc = (n: number) =>
        Array.from({ length: n }, (_, i) => graphvizPlaceholder(`digraph { a${i} -> b; }`)).join('\n');

    it('finds a placeholder', () => {
        assert.equal(hasGraphvizPlaceholders(doc(1)), true);
    });

    it('is false for a document with no diagram', () => {
        assert.equal(hasGraphvizPlaceholders('<p>Just prose.</p>'), false);
        assert.equal(hasGraphvizPlaceholders(''), false);
    });

    it('answers the same on repeated calls', () => {
        // PLACEHOLDER_RE is global, and `.test()` advances lastIndex — without
        // the reset this alternates true/false/true on the same input.
        const html = doc(2);
        for (let i = 0; i < 4; i++) {
            assert.equal(hasGraphvizPlaceholders(html), true, `call ${i + 1}`);
        }
    });
});

// ── Failure path (--strict) ───────────────────────────────────────────────────

describe('graphvizErrorReplacement', () => {
    let out: string[];
    let err: string[];
    let realLog: typeof console.log;
    let realError: typeof console.error;

    beforeEach(() => {
        out = []; err = [];
        realLog = console.log; realError = console.error;
        console.log   = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
        console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
        resetWarnings();
    });

    afterEach(() => {
        console.log = realLog; console.error = realError;
        setQuiet(false);
        resetWarnings();
    });

    it('raises a counted warning, so --strict refuses the document', () => {
        graphvizErrorReplacement(3, 'digraph { a ->', 'syntax error in line 1');
        assert.equal(warningCount(), 1);
    });

    it('names the diagram and the reason', () => {
        graphvizErrorReplacement(3, 'digraph { a ->', 'syntax error in line 1');
        const line = err.join('\n');
        assert.match(line, /WARNING:/);
        assert.match(line, /diagram 3/);
        assert.match(line, /syntax error in line 1/);
    });

    it('goes to stderr, not stdout', () => {
        graphvizErrorReplacement(1, 'digraph { a', 'boom');
        assert.equal(err.length, 1);
        assert.equal(out.length, 0);
    });

    it('survives --quiet, which suppresses everything except warnings', () => {
        setQuiet(true);
        graphvizErrorReplacement(1, 'digraph { a', 'boom');
        assert.equal(warningCount(), 1);
        assert.equal(err.length, 1, 'the warning is still printed');
    });

    it('still returns the error block that goes into the document', () => {
        const html = graphvizErrorReplacement(2, 'digraph { a', 'boom');
        assert.match(html, /class="graphviz-error"/);
        assert.match(html, /Graphviz render error/);
    });

    it('escapes both the message and the source', () => {
        const html = graphvizErrorReplacement(1, 'digraph { label="<script>x</script>" }', 'got <b>token</b>');
        assert.ok(!html.includes('<script>'), html);
        assert.ok(!html.includes('<b>token</b>'), html);
        assert.match(html, /&lt;script&gt;/);
    });
});

// ── End-to-end rendering (real WASM, no mocking) ──────────────────────────────
//
// Unlike Mermaid, the WASM engine needs no browser and no setup step, so these
// run unconditionally — there is no "Graphviz unavailable" state to skip on a
// cold CI runner.

describe('renderGraphvizDiagrams', () => {
    it('returns the input unchanged when there are no placeholders', async () => {
        const html = '<p>Just prose.</p>';
        assert.equal(await renderGraphvizDiagrams(html), html);
    });

    it('strips emoji from a diagram label by default', async () => {
        const html = graphvizPlaceholder('digraph { a [label="Ship it 🚀"]; }');
        const out  = await renderGraphvizDiagrams(html);
        const match = out.match(/src="data:image\/svg\+xml;base64,([^"]+)"/);
        assert.ok(match);
        assert.ok(!/🚀/u.test(Buffer.from(match![1], 'base64').toString('utf8')));
    });

    it('keeps emoji end-to-end when stripEmoji is false', async () => {
        const html = graphvizPlaceholder('digraph { a [label="Ship it 🚀"]; }');
        const out  = await renderGraphvizDiagrams(html, false);
        const match = out.match(/src="data:image\/svg\+xml;base64,([^"]+)"/);
        assert.ok(match);
        assert.match(Buffer.from(match![1], 'base64').toString('utf8'), /🚀/u);
    });

    it('renders a valid diagram to an embedded SVG data URI', async () => {
        const html = `<p>before</p>${graphvizPlaceholder('digraph { a -> b; }')}<p>after</p>`;
        const out  = await renderGraphvizDiagrams(html);
        assert.ok(!out.includes(GRAPHVIZ_PLACEHOLDER_CLASS), 'placeholder must be gone');
        assert.match(out, /<div class="diagram-figure graphviz-figure"><img src="data:image\/svg\+xml;base64,[^"]+" alt="Graphviz diagram 1"><\/div>/);
        assert.ok(out.startsWith('<p>before</p>'));
        assert.ok(out.endsWith('<p>after</p>'));
    });

    it('renders multiple diagrams in document order', async () => {
        const html = graphvizPlaceholder('digraph { a -> b; }') + graphvizPlaceholder('digraph { c -> d; }');
        const out  = await renderGraphvizDiagrams(html);
        const first  = out.indexOf('Graphviz diagram 1');
        const second = out.indexOf('Graphviz diagram 2');
        assert.ok(first >= 0 && second > first);
    });

    it('produces a decodable SVG with a real viewBox from Graphviz itself', async () => {
        const out = await renderGraphvizDiagrams(graphvizPlaceholder('digraph { a -> b; }'));
        const match = out.match(/src="data:image\/svg\+xml;base64,([^"]+)"/);
        assert.ok(match);
        const svg = Buffer.from(match![1], 'base64').toString('utf8');
        assert.match(svg, /<svg[^>]+viewBox="[\d.]+ [\d.]+ [\d.]+ [\d.]+"/);
        assert.ok(!svg.includes('foreignObject'), 'Graphviz never emits foreignObject');
    });

    it('falls back to an error block for invalid DOT and raises a warning', async () => {
        resetWarnings();
        const html = graphvizPlaceholder('digraph { a ->');
        const out  = await renderGraphvizDiagrams(html);
        assert.match(out, /class="graphviz-error"/);
        assert.equal(warningCount(), 1);
    });

    it('one broken diagram does not stop the others from rendering', async () => {
        const html = graphvizPlaceholder('digraph { a ->') + graphvizPlaceholder('digraph { c -> d; }');
        const out  = await renderGraphvizDiagrams(html);
        assert.match(out, /class="graphviz-error"/);
        assert.match(out, /class="diagram-figure graphviz-figure"/);
    });
});
