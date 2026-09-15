import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    mermaidPlaceholder, MERMAID_PLACEHOLDER_CLASS, buildMermaidPage,
    stripSvgEmoji, replaceForeignObjects, svgToDataUrl, applyMermaidReplacements,
    hasMermaidPlaceholders, findMermaidPlaceholders, chromiumInstalled, CHROMIUM_MISSING_MESSAGE,
    PLAYWRIGHT_MISSING_MESSAGE, isModuleNotFound, mermaidUnavailableReason,
    mermaidErrorReplacement,
} from '../mermaid';
import { warningCount, resetWarnings, setQuiet } from '../logger';

describe('mermaidPlaceholder', () => {
    it('returns a <pre> element with the correct class', () => {
        const result = mermaidPlaceholder('graph LR\nA-->B');
        assert.ok(result.startsWith(`<pre class="${MERMAID_PLACEHOLDER_CLASS}"`), `got: ${result}`);
        assert.ok(result.endsWith('></pre>'), `got: ${result}`);
    });

    it('encodes the diagram source as base64 in the data-src attribute', () => {
        const source = 'graph LR\nA-->B';
        const result = mermaidPlaceholder(source);
        const match  = result.match(/data-src="([^"]+)"/);
        assert.ok(match, 'data-src attribute should be present');
        const decoded = Buffer.from(match![1], 'base64').toString('utf8');
        assert.equal(decoded, source);
    });

    it('handles special HTML characters in the diagram source safely', () => {
        const source = 'graph LR\nA["<hello>"] --> B["it\'s & fine"]';
        const result = mermaidPlaceholder(source);
        const match  = result.match(/data-src="([^"]+)"/);
        assert.ok(match, 'data-src should be present for source with special chars');
        const decoded = Buffer.from(match![1], 'base64').toString('utf8');
        assert.equal(decoded, source, 'round-trip decode should match original source');
    });

    it('produces unique placeholders for different sources', () => {
        const a = mermaidPlaceholder('graph LR\nA-->B');
        const b = mermaidPlaceholder('sequenceDiagram\nA->>B: Hello');
        assert.notEqual(a, b);
    });

    it('produces identical placeholders for identical sources', () => {
        const source = 'graph TD\nX-->Y';
        assert.equal(mermaidPlaceholder(source), mermaidPlaceholder(source));
    });
});

// ── buildMermaidPage: the render page's security properties ───────────────────
//
// Both settings below are invisible in the output — a diagram renders the same
// whether or not it just fetched a remote URL — so they are locked here rather
// than left to a comment. The network abort itself needs a real browser and is
// covered by the end-to-end export, not by this suite.

describe('buildMermaidPage', () => {
    const page = (code = 'graph TD\n  A --> B') => buildMermaidPage('/*BUNDLE*/', 'mermaid-diag-1', code);

    it("initialises mermaid at securityLevel 'strict'", () => {
        assert.match(page(), /securityLevel:\s*'strict'/);
    });

    it("never ships 'loose', which is what it used to be", () => {
        assert.ok(!page().includes("securityLevel: 'loose'"));
    });

    it('inlines the bundle so the page needs no network', () => {
        // What makes aborting every request safe in renderSvgWithBrowser.
        assert.ok(page().includes('/*BUNDLE*/'));
        assert.ok(!/<script[^>]+src=/.test(page()), 'no external script may be referenced');
    });

    it('escapes a diagram whose label would close the script element', () => {
        const html = page('graph TD\n  A["close: </script>"] --> B');
        const scriptEnd = html.indexOf('</script>');
        assert.ok(scriptEnd > html.indexOf('mermaid.render'), 'the script must not end before the render call');
        assert.match(html, /\\u003c\/script>/);
    });

    it('escapes the diagram id as well as the source', () => {
        assert.match(buildMermaidPage('B', '</script><b>', 'graph TD'), /\\u003c\/script>/);
    });

    it('passes an ordinary diagram through unharmed', () => {
        assert.match(page(), /mermaid\.render\("mermaid-diag-1", "graph TD\\n  A --> B"\)/);
    });
});

// ── SVG post-processing ───────────────────────────────────────────────────────
//
// The rewrite that makes a browser-rendered diagram survive WeasyPrint. It is
// pure string work — no Chromium involved — and it was the least covered code in
// the tree at 55%, which is a bad place for the gap to be: librsvg silently
// renders a diagram wrong rather than failing, so a regression here ships a PDF
// with the labels missing or stacked on top of each other and nothing to notice.

describe('stripSvgEmoji', () => {
    it('removes emoji, which crash librsvg through Pango on macOS', () => {
        assert.equal(stripSvgEmoji('<text>Ship it 🚀</text>'), '<text>Ship it </text>');
    });

    it('leaves ordinary text, markup and non-ASCII letters alone', () => {
        const svg = '<text font-family="sans-serif">Größe ≥ 3 — ok</text>';
        assert.equal(stripSvgEmoji(svg), svg);
    });
});

describe('replaceForeignObjects', () => {
    const fo = (attrs: string, inner: string) => `<g class="label"><foreignObject ${attrs}>${inner}</foreignObject></g>`;

    it('replaces a foreignObject label with a <text> centred on its own box', () => {
        const out = replaceForeignObjects(fo('x="10" y="20" width="100" height="40"', '<div>Start</div>'));
        assert.ok(!out.includes('foreignObject'), 'librsvg does not support foreignObject');
        // Centre of the box: x + w/2 = 60, y + h/2 = 40.
        assert.match(out, /<text x="60" y="40" text-anchor="middle" dominant-baseline="middle"/);
        assert.match(out, /<tspan x="60" dy="0">Start<\/tspan>/);
    });

    it('defaults a missing x/y to zero rather than dropping the label', () => {
        const out = replaceForeignObjects(fo('width="80" height="20"', '<div>Node</div>'));
        assert.match(out, /<text x="40" y="10"/);
    });

    it('stacks a multi-line label around the vertical centre', () => {
        const out = replaceForeignObjects(fo('width="100" height="40"', '<div>One<br>Two<br/>Three</div>'));
        const dys = [...out.matchAll(/dy="(-?[\d.]+)"/g)].map(m => m[1]);
        // Three lines at line-height 18: start half a block up, then step down.
        assert.deepEqual(dys, ['-18', '18', '18']);
    });

    it('decodes the entities mermaid put in the label', () => {
        const out = replaceForeignObjects(fo('width="10" height="10"', '<div>a &amp;&lt;b&gt; &quot;c&quot; &#39;d&#39;</div>'));
        // Decoded, then re-escaped for the SVG text node: & < > only.
        assert.match(out, /<tspan[^>]*>a &amp;&lt;b&gt; "c" 'd'<\/tspan>/);
    });

    it('re-escapes a label that would otherwise inject markup', () => {
        const out = replaceForeignObjects(fo('width="10" height="10"', '<div>&lt;script&gt;x&lt;/script&gt;</div>'));
        assert.ok(!/<script>/.test(out), 'the label must not become an element');
        assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
    });

    it('strips emoji from a label — the same Pango crash, via the text path', () => {
        const out = replaceForeignObjects(fo('width="10" height="10"', '<div>Deploy 🚀</div>'));
        // The strip runs after the trim, so the space the emoji sat behind stays.
        // SVG collapses it, so this is cosmetic — but it is the actual behaviour.
        assert.match(out, /<tspan[^>]*>Deploy <\/tspan>/);
        assert.ok(!/🚀/u.test(out));
    });

    it('drops a label with no text at all rather than emitting an empty <text>', () => {
        assert.equal(replaceForeignObjects(fo('width="10" height="10"', '<div></div>')), '<g class="label"></g>');
        assert.equal(replaceForeignObjects(fo('width="10" height="10"', '<div>🚀</div>')), '<g class="label"></g>',
            'an emoji-only label strips to nothing');
    });

    it('rewrites every foreignObject in the document, not just the first', () => {
        const svg = fo('width="10" height="10"', '<div>A</div>') + fo('width="10" height="10"', '<div>B</div>');
        const out = replaceForeignObjects(svg);
        assert.equal((out.match(/<text /g) ?? []).length, 2);
        assert.ok(!out.includes('foreignObject'));
    });
});

describe('svgToDataUrl', () => {
    /** Decodes the data URL back to the SVG it carries. */
    const decode = (url: string): string => {
        assert.match(url, /^data:image\/svg\+xml;base64,/);
        return Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    };

    it('sets width and height from the viewBox so WeasyPrint knows the intrinsic size', () => {
        const svg = decode(svgToDataUrl('<svg viewBox="0 0 320 180" width="100%" height="100%"></svg>'));
        assert.match(svg, /width="320"/);
        assert.match(svg, /height="180"/);
    });

    it('adds a height even when mermaid omitted one', () => {
        const svg = decode(svgToDataUrl('<svg viewBox="0 0 320 180" width="100%"></svg>'));
        assert.match(svg, /height="180"/);
    });

    it("drops mermaid's max-width, which fights the explicit size", () => {
        const svg = decode(svgToDataUrl('<svg viewBox="0 0 10 10" style="max-width: 320px;" width="1"></svg>'));
        assert.ok(!svg.includes('max-width'));
    });

    it('darkens the neutral-grey node border for print', () => {
        const svg = decode(svgToDataUrl('<svg viewBox="0 0 10 10"><rect style="stroke:#999"/></svg>'));
        assert.match(svg, /stroke:#555/);
        assert.ok(!svg.includes('stroke:#999'));
    });

    it('converts foreignObject labels and strips emoji on the way through', () => {
        const svg = decode(svgToDataUrl(
            '<svg viewBox="0 0 10 10"><g class="label"><foreignObject width="20" height="10"><div>Go 🚀</div></foreignObject></g></svg>',
        ));
        assert.ok(!svg.includes('foreignObject'));
        assert.match(svg, /<tspan[^>]*>Go <\/tspan>/);
        assert.ok(!/🚀/u.test(svg));
    });

    it('leaves an SVG with no viewBox alone rather than guessing a size', () => {
        const svg = decode(svgToDataUrl('<svg width="100%"><g/></svg>'));
        assert.match(svg, /width="100%"/);
    });

    it('strips emoji by default (stripEmoji omitted)', () => {
        const svg = decode(svgToDataUrl('<svg><text>Ship it 🚀</text></svg>'));
        assert.ok(!/🚀/u.test(svg));
    });

    it('keeps emoji when the caller confirms the target WeasyPrint can render them', () => {
        const svg = decode(svgToDataUrl('<svg><text>Ship it 🚀</text></svg>', false));
        assert.match(svg, /🚀/u);
    });
});

// ── Substitution back into the document ───────────────────────────────────────

describe('applyMermaidReplacements', () => {
    const ph = (src: string) => mermaidPlaceholder(src);

    it('substitutes each diagram where its placeholder was', () => {
        const a = ph('graph TD\n A-->B');
        const b = ph('graph LR\n C-->D');
        const out = applyMermaidReplacements(`<p>one</p>${a}<p>two</p>${b}`, [
            { placeholder: a, replacement: '<img alt="Mermaid diagram 1">' },
            { placeholder: b, replacement: '<img alt="Mermaid diagram 2">' },
        ]);
        assert.equal(out, '<p>one</p><img alt="Mermaid diagram 1"><p>two</p><img alt="Mermaid diagram 2">');
    });

    it('gives two identical diagrams their own replacement, in order', () => {
        // Identical sources share a placeholder byte-for-byte, so a plain map
        // would hand both occurrences whichever replacement was written last —
        // and the alt text carries the diagram's index.
        const same = ph('graph TD\n A-->B');
        const out = applyMermaidReplacements(`${same}${same}`, [
            { placeholder: same, replacement: '<img alt="Mermaid diagram 1">' },
            { placeholder: same, replacement: '<img alt="Mermaid diagram 2">' },
        ]);
        assert.equal(out, '<img alt="Mermaid diagram 1"><img alt="Mermaid diagram 2">');
    });

    it('leaves a placeholder nothing rendered for exactly as it was', () => {
        const orphan = ph('graph TD\n X-->Y');
        assert.equal(applyMermaidReplacements(orphan, []), orphan);
    });

    it('inserts a replacement verbatim, even one full of $ patterns', () => {
        // `String.replace` expands $&, $` and friends in a *string* replacement;
        // a base64 data URI or an error block echoing the diagram can contain them.
        const p = ph('graph TD\n A-->B');
        const out = applyMermaidReplacements(p, [{ placeholder: p, replacement: '<img src="a$&b$`c">' }]);
        assert.equal(out, '<img src="a$&b$`c">');
    });

    it('never rescans what it just inserted', () => {
        // A replacement that itself looks like a placeholder must survive: the
        // per-diagram replace loop this replaced could match its own output.
        const p    = ph('graph TD\n A-->B');
        const evil = ph('graph TD\n nested');
        const out  = applyMermaidReplacements(p, [{ placeholder: p, replacement: evil }]);
        assert.equal(out, evil);
    });
});


// ── hasMermaidPlaceholders ────────────────────────────────────────────────────

describe('hasMermaidPlaceholders', () => {
    const doc = (n: number) =>
        Array.from({ length: n }, (_, i) => mermaidPlaceholder(`graph TD\n A${i}-->B`)).join('\n');

    it('finds a placeholder', () => {
        assert.equal(hasMermaidPlaceholders(doc(1)), true);
    });

    it('is false for a document with no diagram', () => {
        assert.equal(hasMermaidPlaceholders('<p>Just prose.</p>'), false);
        assert.equal(hasMermaidPlaceholders(''), false);
    });

    it('answers the same on repeated calls', () => {
        // PLACEHOLDER_RE is global, and `.test()` on a global regex advances
        // lastIndex — so without the reset this returns true, then false, then
        // true again on the same input. A predicate that alternates is a
        // genuinely nasty thing to chase down.
        const html = doc(2);
        for (let i = 0; i < 4; i++) {
            assert.equal(hasMermaidPlaceholders(html), true, `call ${i + 1}`);
        }
    });

    it('leaves the shared pattern usable for the replacement pass', () => {
        // `applyMermaidReplacements` walks the same global regex object. If the
        // predicate leaves lastIndex mid-string, the replacement pass starts
        // from there and silently skips the first diagram.
        const html = doc(2);
        hasMermaidPlaceholders(html);

        const placeholders = [mermaidPlaceholder('graph TD\n A0-->B'),
                              mermaidPlaceholder('graph TD\n A1-->B')];
        const out = applyMermaidReplacements(html, [
            { placeholder: placeholders[0], replacement: '<img id="one">' },
            { placeholder: placeholders[1], replacement: '<img id="two">' },
        ]);
        assert.match(out, /id="one"/, 'the FIRST diagram must still be replaced');
        assert.match(out, /id="two"/);
    });

    it('leaves the shared pattern usable for the render pass', () => {
        // The render pass collects its work with matchAll, which — unlike
        // replace — starts wherever the predicate left lastIndex. main() asks
        // hasMermaidPlaceholders first on every export, so this is the exact
        // sequence that dropped every document's first diagram.
        for (const n of [1, 2, 3]) {
            const html = doc(n);
            assert.equal(hasMermaidPlaceholders(html), true);
            assert.equal(findMermaidPlaceholders(html).length, n, `${n} diagram(s)`);
        }
    });
});

describe('chromiumInstalled', () => {
    it('reports a boolean without launching a browser', async () => {
        // Deliberately not asserting which — CI installs Chromium, a developer
        // machine may not, and either is a correct answer. What matters is that
        // it resolves fast and never throws: it runs inside --dry-run, whose
        // whole promise is that it starts nothing.
        const started = Date.now();
        const result  = await chromiumInstalled();
        assert.equal(typeof result, 'boolean');
        assert.ok(Date.now() - started < 5000, 'must not be launching anything');
    });
});

describe('CHROMIUM_MISSING_MESSAGE', () => {
    it('names both remediations the user can run', () => {
        // Shared by the renderer and the dry-run check so the two cannot drift.
        assert.match(CHROMIUM_MISSING_MESSAGE, /--setup/);
        assert.match(CHROMIUM_MISSING_MESSAGE, /playwright install chromium/);
    });
});


// ── Failure path (--strict) ───────────────────────────────────────────────────

describe('mermaidErrorReplacement', () => {
    // A diagram that fails to render leaves a red error box in the exported
    // document. That is a broken reference, and `--strict` exists to refuse a
    // document with one — but this path logged `  diagram 3: ERROR — …`, and
    // `logger.ts` counts a warning only when the line starts with `WARNING:` at
    // column zero. So the export wrote the error box and exited 0, while a
    // missing *image* failed the identical run with exit 6.
    //
    // Verified before the fix on a real document: exit 0, empty stderr under
    // `--quiet`, two `mermaid-error` blocks in the output.

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
        mermaidErrorReplacement(3, 'graph TD\nA[[[', 'Parse error on line 2');
        assert.equal(warningCount(), 1);
    });

    it('names the diagram and the reason', () => {
        mermaidErrorReplacement(3, 'graph TD', 'Parse error on line 2');
        const line = err.join('\n');
        assert.match(line, /WARNING:/);
        assert.match(line, /diagram 3/);
        assert.match(line, /Parse error on line 2/);
    });

    it('goes to stderr, not stdout — a piped progress trace still shows it', () => {
        mermaidErrorReplacement(1, 'graph TD', 'boom');
        assert.equal(err.length, 1);
        assert.equal(out.length, 0);
    });

    it('survives --quiet, which suppresses everything except warnings', () => {
        setQuiet(true);
        mermaidErrorReplacement(1, 'graph TD', 'boom');
        assert.equal(warningCount(), 1);
        assert.equal(err.length, 1, 'the warning is still printed');
    });

    it('still returns the error block that goes into the document', () => {
        const html = mermaidErrorReplacement(2, 'graph TD', 'boom');
        assert.match(html, /class="mermaid-error"/);
        assert.match(html, /Mermaid render error/);
    });

    it('escapes both the message and the source', () => {
        // A Mermaid parse error quotes the line it choked on, so a label
        // containing `<` used to close the block early and spill the rest of the
        // report into the document as markup.
        const html = mermaidErrorReplacement(1, 'graph TD\nA["<script>x</script>"]', 'got <b>token</b>');
        assert.ok(!html.includes('<script>'), html);
        assert.ok(!html.includes('<b>token</b>'), html);
        assert.match(html, /&lt;script&gt;/);
    });
});

// ── Optional-dependency handling ──────────────────────────────────────────────

/**
 * Playwright is an optionalDependency: a whole browser-automation library, and a
 * browser binary behind it, carried for one feature most documents never use. An
 * install that skipped it is therefore a supported state — and it used to escape
 * as a raw MODULE_NOT_FOUND stack trace under the generic exit 1, because the
 * only branch here matched Chromium's "executable doesn't exist" message.
 */
describe('isModuleNotFound', () => {
    /** The shape Node raises for an unresolvable CJS require. */
    const notFound = (spec: string): NodeJS.ErrnoException =>
        Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' });

    it('recognises the module that failed to resolve', () => {
        assert.equal(isModuleNotFound(notFound('playwright'), 'playwright'), true);
    });

    it('recognises the ESM spelling of the same code', () => {
        const err = Object.assign(new Error("Cannot find package 'playwright'"),
                                  { code: 'ERR_MODULE_NOT_FOUND' });
        assert.equal(isModuleNotFound(err, 'playwright'), true);
    });

    it('does not claim playwright is missing when a DIFFERENT module is', () => {
        // A MODULE_NOT_FOUND raised from inside playwright — a broken install
        // missing one of its own files — is a different problem, and telling the
        // user to install playwright would send them in the wrong direction.
        assert.equal(isModuleNotFound(notFound('chromium-bidi/lib/cjs/bidiMapper'), 'playwright'), false);
    });

    it('ignores an error that is not a resolution failure at all', () => {
        assert.equal(isModuleNotFound(new Error("Cannot find module 'playwright'"), 'playwright'), false);
        assert.equal(isModuleNotFound(null, 'playwright'), false);
        assert.equal(isModuleNotFound('playwright', 'playwright'), false);
    });
});

describe('PLAYWRIGHT_MISSING_MESSAGE', () => {
    it('names the remedy for a missing package, not a missing browser', () => {
        assert.match(PLAYWRIGHT_MISSING_MESSAGE, /optional dependency/i);
        assert.match(PLAYWRIGHT_MISSING_MESSAGE, /npm install playwright/);
    });

    it('is distinguishable from the missing-Chromium message', () => {
        assert.notEqual(PLAYWRIGHT_MISSING_MESSAGE, CHROMIUM_MISSING_MESSAGE);
    });
});

describe('mermaidUnavailableReason', () => {
    it('agrees with chromiumInstalled', async () => {
        // One is defined in terms of the other; this pins that they cannot drift
        // into disagreeing about whether a render can happen.
        assert.equal((await mermaidUnavailableReason()) === null, await chromiumInstalled());
    });

    it('returns either null or one of the two known reasons', async () => {
        const reason = await mermaidUnavailableReason();
        assert.ok(reason === null ||
                  reason === CHROMIUM_MISSING_MESSAGE ||
                  reason === PLAYWRIGHT_MISSING_MESSAGE,
                  `unexpected reason: ${reason}`);
    });
});
