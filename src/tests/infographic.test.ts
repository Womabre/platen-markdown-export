import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    infographicPlaceholder, INFOGRAPHIC_PLACEHOLDER_CLASS, hasInfographicPlaceholders,
    applyInfographicReplacements, infographicSvgToDataUrl, infographicErrorReplacement,
    answerIconRequest, weavefoxNotice, renderInfographicDiagrams, type IconAccounting,
} from '../infographic';
import type { FetchResult } from '../types';
import { warningCount, resetWarnings, setQuiet } from '../logger';

/** Captures console output for the duration of each test in the enclosing describe. */
function captureConsole(): { out: string[]; err: string[] } {
    const captured = { out: [] as string[], err: [] as string[] };
    let realLog: typeof console.log;
    let realError: typeof console.error;
    beforeEach(() => {
        captured.out.length = 0; captured.err.length = 0;
        realLog = console.log; realError = console.error;
        console.log   = (...a: unknown[]) => { captured.out.push(a.map(String).join(' ')); };
        console.error = (...a: unknown[]) => { captured.err.push(a.map(String).join(' ')); };
        resetWarnings();
    });
    afterEach(() => {
        console.log = realLog; console.error = realError;
        setQuiet(false);
        resetWarnings();
    });
    return captured;
}

const decodeImg = (html: string): string => {
    const m = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(html);
    assert.ok(m, `no embedded SVG in: ${html.slice(0, 200)}`);
    return Buffer.from(m[1], 'base64').toString('utf8');
};

// ── Placeholder and substitution ──────────────────────────────────────────────

describe('infographicPlaceholder', () => {
    it('is a <pre> carrying the source as base64', () => {
        const source = 'infographic list-grid-badge-card\ndata\n  title <x> & "y"';
        const ph = infographicPlaceholder(source);
        assert.ok(ph.startsWith(`<pre class="${INFOGRAPHIC_PLACEHOLDER_CLASS}"`), ph);
        const m = /data-src="([^"]+)"/.exec(ph);
        assert.ok(m);
        assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), source);
    });

    it('is identical for identical sources', () => {
        assert.equal(infographicPlaceholder('a'), infographicPlaceholder('a'));
        assert.notEqual(infographicPlaceholder('a'), infographicPlaceholder('b'));
    });
});

describe('hasInfographicPlaceholders', () => {
    it('answers the same on repeated calls', () => {
        // The pattern is global; without the lastIndex reset this alternates.
        const html = infographicPlaceholder('a') + infographicPlaceholder('b');
        for (let i = 0; i < 4; i++) assert.equal(hasInfographicPlaceholders(html), true, `call ${i + 1}`);
    });

    it('is false for a document with none', () => {
        assert.equal(hasInfographicPlaceholders('<p>prose</p>'), false);
    });
});

describe('applyInfographicReplacements', () => {
    it('gives two identical diagrams their own replacement, in order', () => {
        const same = infographicPlaceholder('a');
        const out = applyInfographicReplacements(`${same}<p>x</p>${same}`, [
            { placeholder: same, replacement: '<img alt="1">' },
            { placeholder: same, replacement: '<img alt="2">' },
        ]);
        assert.equal(out, '<img alt="1"><p>x</p><img alt="2">');
    });

    it('inserts a replacement verbatim, even one full of $ patterns', () => {
        const p = infographicPlaceholder('a');
        assert.equal(applyInfographicReplacements(p, [{ placeholder: p, replacement: 'a$&b$`c' }]), 'a$&b$`c');
    });
});

describe('infographicSvgToDataUrl', () => {
    const decode = (url: string) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');

    it('strips emoji by default', () => {
        assert.equal(decode(infographicSvgToDataUrl('<svg><text>Ship 🚀</text></svg>')), '<svg><text>Ship </text></svg>');
    });

    it('keeps emoji when the target WeasyPrint can render them', () => {
        assert.equal(decode(infographicSvgToDataUrl('<svg><text>Ship 🚀</text></svg>', false)), '<svg><text>Ship 🚀</text></svg>');
    });
});

describe('infographicErrorReplacement', () => {
    const captured = captureConsole();

    it('raises a counted warning on stderr, so --strict refuses the document', () => {
        infographicErrorReplacement(2, 'infographic x', 'boom');
        assert.equal(warningCount(), 1);
        assert.equal(captured.out.length, 0);
        assert.match(captured.err.join('\n'), /WARNING: Infographic 2 failed to render — boom/);
    });

    it('survives --quiet', () => {
        setQuiet(true);
        infographicErrorReplacement(1, 'x', 'boom');
        assert.equal(captured.err.length, 1);
    });

    it('escapes both the message and the source', () => {
        const html = infographicErrorReplacement(1, 'title <script>x</script>', 'got <b>token</b>');
        assert.ok(!html.includes('<script>') && !html.includes('<b>token'), html);
        assert.match(html, /class="infographic-error"/);
    });
});

describe('weavefoxNotice', () => {
    it('says how many requests went where, and that data may go to China', () => {
        const line = weavefoxNotice(3);
        assert.match(line, /^3 infographic icon request\(s\) went to www\.weavefox\.cn/);
        assert.match(line, /China/);
        assert.match(line, /--infographic-icons iconify/);
    });
});

// ── Network broker (injected fetcher — no network) ────────────────────────────

describe('answerIconRequest', () => {
    const fresh = (): IconAccounting => ({ weavefox: 0, unresolved: new Set() });
    const body = (a: { body: Uint8Array }) => JSON.parse(Buffer.from(a.body).toString('utf8'));
    const serving = (content: string, mimeType = 'image/svg+xml') => {
        const calls: string[] = [];
        const fetcher = async (url: string): Promise<FetchResult> => {
            calls.push(url);
            return { buffer: Buffer.from(content), mimeType };
        };
        return { calls, fetcher };
    };
    const failing = async (): Promise<FetchResult> => { throw new Error('unreachable'); };

    it('iconify: answers the search with the fetched icon', async () => {
        const { calls, fetcher } = serving('<svg id="home"/>');
        const url = 'https://api.iconify.design/test/answers.svg';
        const a = await answerIconRequest({ kind: 'iconify', query: 'test/answers', url }, fresh(), fetcher);
        assert.deepEqual(calls, [url]);
        assert.deepEqual(body(a), { success: true, data: ['<svg id="home"/>'] });
    });

    it('iconify: fetches an icon once per process', async () => {
        const { calls, fetcher } = serving('<svg/>');
        const d = { kind: 'iconify' as const, query: 'test/once', url: 'https://api.iconify.design/test/once.svg' };
        await answerIconRequest(d, fresh(), fetcher);
        await answerIconRequest(d, fresh(), fetcher);
        assert.equal(calls.length, 1);
    });

    it('iconify: a response that is not an SVG is "not found", and reported', async () => {
        const { fetcher } = serving('<!doctype html><p>404</p>', 'text/html');
        const acc = fresh();
        const a = await answerIconRequest({ kind: 'iconify', query: 'test/html', url: 'https://api.iconify.design/test/html.svg' }, acc, fetcher);
        assert.equal(body(a).success, false);
        assert.deepEqual([...acc.unresolved], ['test/html']);
    });

    it('iconify: an unreachable Iconify is "not found", and reported', async () => {
        const acc = fresh();
        const a = await answerIconRequest({ kind: 'iconify', query: 'test/down', url: 'https://api.iconify.design/test/down.svg' }, acc, failing);
        assert.equal(body(a).success, false);
        assert.ok(acc.unresolved.has('test/down'));
    });

    it('no-result: answers without fetching, and records the query', async () => {
        const { calls, fetcher } = serving('<svg/>');
        const acc = fresh();
        const a = await answerIconRequest({ kind: 'no-result', query: ' Some label ' }, acc, fetcher);
        assert.equal(calls.length, 0);
        assert.equal(body(a).success, false);
        assert.deepEqual([...acc.unresolved], ['Some label']);
    });

    it('no-result: an empty query is not worth reporting', async () => {
        const acc = fresh();
        await answerIconRequest({ kind: 'no-result', query: '  ' }, acc, failing);
        assert.equal(acc.unresolved.size, 0);
    });

    it('weavefox: passes the response through, and counts the request', async () => {
        const { calls, fetcher } = serving('{"success":true,"data":["<svg/>"]}', 'application/json');
        const acc = fresh();
        const url = 'https://www.weavefox.cn/api/v1/infographic/icon?text=home';
        const a = await answerIconRequest({ kind: 'weavefox', query: 'home', url }, acc, fetcher);
        assert.deepEqual(calls, [url]);
        assert.equal(a.status, 200);
        assert.equal(a.contentType, 'application/json');
        assert.equal(acc.weavefox, 1);
    });

    it('weavefox: a failed request is still counted — the data was sent', async () => {
        const acc = fresh();
        const a = await answerIconRequest({ kind: 'weavefox', query: 'x', url: 'https://www.weavefox.cn/api/v1/infographic/icon?text=x' }, acc, failing);
        assert.equal(a.status, 502);
        assert.equal(acc.weavefox, 1);
    });

    it('remote: fetched through the given fetcher, and not counted as WeaveFox', async () => {
        const { calls, fetcher } = serving('<svg/>');
        const acc = fresh();
        const a = await answerIconRequest({ kind: 'remote', url: 'https://example.com/a.svg' }, acc, fetcher);
        assert.deepEqual(calls, ['https://example.com/a.svg']);
        assert.equal(a.status, 200);
        assert.equal(acc.weavefox, 0);
    });

    it('blocked: refused without a request', async () => {
        const { calls, fetcher } = serving('<svg/>');
        const a = await answerIconRequest({ kind: 'blocked', url: 'file:///etc/passwd' }, fresh(), fetcher);
        assert.equal(a.status, 403);
        assert.equal(calls.length, 0);
    });
});

// ── End-to-end (real library, in its worker; icons off, so no network) ───────

describe('renderInfographicDiagrams', () => {
    const captured = captureConsole();
    const none = { iconProvider: 'none' as const };
    const grid = 'infographic list-grid-badge-card\ndata\n  lists\n    - label Alpha\n      desc First item\n    - label Beta\n      desc Second item';

    it('returns a document with no infographic unchanged', async () => {
        const html = '<p>Just prose.</p>';
        assert.equal(await renderInfographicDiagrams(html, none), html);
        assert.equal(captured.out.length, 0, 'not even a progress line — no worker was started');
    });

    it('renders a diagram to an embedded SVG figure', async () => {
        const out = await renderInfographicDiagrams(`<p>before</p>${infographicPlaceholder(grid)}<p>after</p>`, none);
        assert.ok(!out.includes(INFOGRAPHIC_PLACEHOLDER_CLASS), 'placeholder must be gone');
        assert.match(out, /^<p>before<\/p><div class="diagram-figure infographic-figure"><img src="data:image\/svg\+xml;base64,[^"]+" alt="Infographic 1"><\/div><p>after<\/p>$/);
        assert.equal(warningCount(), 0);
    });

    it('produces an SVG WeasyPrint can draw: native text, no foreignObject, no remote font', async () => {
        const svg = decodeImg(await renderInfographicDiagrams(infographicPlaceholder(grid), none));
        assert.ok(!svg.includes('foreignObject'), 'no foreignObject');
        assert.ok(!svg.includes('<?'), 'no processing instructions');
        assert.match(svg, /<text [^>]*><tspan [^>]*>Alpha<\/tspan><\/text>/);
        assert.match(svg, /<tspan [^>]*>First item<\/tspan>/);
    });

    it('leaves the main thread\'s globals alone — the library\'s DOM shim stays in its worker', async () => {
        await renderInfographicDiagrams(infographicPlaceholder(grid), none);
        const g = globalThis as Record<string, unknown>;
        assert.equal(typeof g.window, 'undefined');
        assert.equal(typeof g.document, 'undefined');
        assert.equal(typeof g.DOMParser, 'undefined');
    });

    it('names an unknown template and suggests the one probably meant', async () => {
        const out = await renderInfographicDiagrams(infographicPlaceholder(grid.replace('badge-card', 'badge-crad')), none);
        assert.match(out, /class="infographic-error"/);
        assert.match(out, /unknown template &quot;list-grid-badge-crad&quot; — did you mean &quot;list-grid-badge-card&quot;\?/);
        assert.equal(warningCount(), 1);
    });

    it('refuses invalid syntax at once rather than waiting out the library\'s timeout', async () => {
        const started = Date.now();
        const out = await renderInfographicDiagrams(infographicPlaceholder('this is not an infographic'), none);
        assert.match(out, /invalid infographic syntax/);
        assert.ok(Date.now() - started < 8_000, 'well inside the library\'s own 10 s timeout');
    });

    it('one broken diagram does not stop the next from rendering', async () => {
        const html = infographicPlaceholder('garbage') + infographicPlaceholder(grid);
        const out = await renderInfographicDiagrams(html, none);
        assert.match(out, /class="infographic-error"/);
        assert.match(out, /alt="Infographic 2"/);
        assert.equal(warningCount(), 1);
    });

    it('replaces a worker that outlives its timeout, and reports the diagram', async () => {
        const out = await renderInfographicDiagrams(infographicPlaceholder(grid), { ...none, timeoutMs: 1 });
        assert.match(out, /class="infographic-error"/);
        assert.match(out, /timed out/);
        assert.equal(warningCount(), 1);
    });

    it('carries the hand-drawn theme\'s font into the SVG, quoted and embedded', async () => {
        // The library asks for 851tegakizatsu and expects it from Ant Group's
        // CDN, which these renderers never reach — so it is bundled and embedded
        // here instead, or the sketched shapes arrive with every word in Arial.
        const svg = decodeImg(await renderInfographicDiagrams(infographicPlaceholder(`${grid}\ntheme hand-drawn`), none));
        assert.match(svg, /@font-face\{font-family:"851tegakizatsu";src:url\(data:font\/woff2;base64,/);
        assert.match(svg, /font-family="'851tegakizatsu', Arial/);
        assert.ok(!/font-family="851tegakizatsu"/.test(svg), 'unquoted, the declaration is invalid CSS');
    });

    it('leaves a diagram with no theme font in Arial, carrying no font at all', async () => {
        const svg = decodeImg(await renderInfographicDiagrams(infographicPlaceholder(grid), none));
        assert.ok(!svg.includes('@font-face'), 'nothing to embed');
        assert.match(svg, /font-family="Arial, Helvetica/);
    });

    it('with icons off, says which icons were left out — without a counted warning', async () => {
        const withIcon = grid.replace('      desc First item', '      icon mdi/home\n      desc First item');
        const out = await renderInfographicDiagrams(infographicPlaceholder(withIcon), none);
        assert.match(out, /alt="Infographic 1"/, 'the diagram still renders');
        assert.equal(warningCount(), 0, '--strict must not refuse a choice the user made');
        assert.match(captured.out.join('\n'), /icons are off \(--infographic-icons none\); left out: "mdi\/home"/);
        assert.ok(!captured.err.join('\n').includes('NOTICE'), 'nothing went to WeaveFox');
    });
});
