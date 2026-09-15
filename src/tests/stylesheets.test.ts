import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as http from 'http';
import * as net  from 'net';
import * as os   from 'os';
import * as path from 'path';
import {
    detectIconFonts,
    iconCacheDir,
    buildIconStyles,
    inlineRemoteStylesheets,
    findRemoteStylesheetLinks,
    buildIconStylesheet,
    clearCssImportCache,
} from '../stylesheets';
import { CONFIG } from '../config';

// These suites drive the fetcher against a loopback server, which the
// private-address guard refuses by default — see `isPrivateAddress`. Opting in
// here is the same switch a document that legitimately pulls assets off your own
// network uses (EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1). The guard's own behaviour is
// asserted in fetch.test.ts.
CONFIG.allowPrivateHosts = true;


/**
 * stylesheets.ts is the module that reaches the network, writes a 0700 disk
 * cache and leans hardest on regex — and until now the only parts under test
 * were the two purely-local functions css.test.ts happens to import. Everything
 * here is hermetic: the detection and cache-path logic are pure, and the
 * fetching paths run against a loopback server, the same way fetch.test.ts does.
 * Nothing in this file touches a CDN or the real cache directory.
 */

// ── Loopback CSS server ───────────────────────────────────────────────────────

const TINY_WOFF2 = Buffer.from('d09GMgABAAAAAAAQAAoAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64');

let server: http.Server;
let port:   number;
/** Request counter per path, so deduplication can be asserted rather than assumed. */
let hits:   Map<string, number>;
/** Concurrent font requests, so the fan-out bound can be asserted rather than assumed. */
let inFlight = 0;
let peakInFlight = 0;

function url(p: string): string { return `http://127.0.0.1:${port}${p}`; }

before(async () => {
    hits = new Map();
    await new Promise<void>(resolve => {
        server = http.createServer((req, res) => {
            const p = (req.url ?? '/').split('?')[0];
            hits.set(p, (hits.get(p) ?? 0) + 1);

            if (p === '/plain.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('body { color: red; }');
            } else if (p === '/with-font.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                // The same font referenced twice — one fetch must serve both.
                res.end(
                    '@font-face { font-family: X; src: url(font.woff2) format("woff2"); }\n' +
                    '@font-face { font-family: Y; src: url(font.woff2) format("woff2"); }',
                );
            } else if (p === '/font.woff2') {
                res.writeHead(200, { 'Content-Type': 'font/woff2' });
                res.end(TINY_WOFF2);
            } else if (p.startsWith('/slow-font-')) {
                // Held open briefly so overlapping requests are observable.
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                setTimeout(() => {
                    inFlight--;
                    res.writeHead(200, { 'Content-Type': 'font/woff2' });
                    res.end(TINY_WOFF2);
                }, 25);
            } else if (p === '/many-fonts.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end(
                    Array.from({ length: 16 }, (_, i) =>
                        `@font-face { font-family: F${i}; src: url(slow-font-${i}.woff2) format("woff2"); }`,
                    ).join('\n'),
                );
            } else if (p === '/with-fill.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('.icon { fill: #ff0000; stroke: none; }\n.ok { fill: currentColor; }');
            } else if (p === '/missing-font.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('@font-face { src: url(nope.woff2) format("woff2"); }');
            } else if (p === '/broken-import.css') {
                // Resolves itself, but the sheet it pulls in 404s — the shape of
                // a CDN blip mid-export.
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('@import url("gone.css");\n.ok { color: red; }');
            } else if (p === '/whole-font.css') {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                res.end('@font-face { font-family: W; src: url(font.woff2) format("woff2"); }');
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as net.AddressInfo).port;
            resolve();
        });
    });
});

after(() => { server.close(); });

beforeEach(() => { hits.clear(); clearCssImportCache(); inFlight = 0; peakInFlight = 0; });

// ── detectIconFonts ───────────────────────────────────────────────────────────

describe('detectIconFonts', () => {
    it('reports nothing for a document with no icons', () => {
        const usage = detectIconFonts('<p class="lead">no icons here</p>');
        assert.equal(usage.needsFa, false);
        assert.deepEqual(usage.phosphorWeights, []);
    });

    it('detects Font Awesome from an fa- class', () => {
        assert.equal(detectIconFonts('<i class="fa-solid fa-check"></i>').needsFa, true);
    });

    it('does not mistake a non-icon class beginning with "fa" for Font Awesome', () => {
        assert.equal(detectIconFonts('<div class="fancy failure">x</div>').needsFa, false);
    });

    it('only looks inside class attributes, never at prose', () => {
        // A document that merely writes the class name in its own text — this
        // tool's README does exactly that — must not pull down a 300 KB font.
        assert.equal(detectIconFonts('<p>Write fa-solid to get an icon.</p>').needsFa, false);
        assert.deepEqual(detectIconFonts('<p>The ph-bold weight is heavier.</p>').phosphorWeights, []);
    });

    // markdown renders `class="…"`, so double quotes were the only form this
    // ever met — but `html: true` is on and a document may hand-write either of
    // the other two. Both were invisible to the detector, so the font was never
    // fetched and the glyph rendered as an empty space, with nothing in the log.
    it('reads a class attribute in all three HTML spellings', () => {
        for (const tag of ['<i class="ph ph-database"></i>',
                           "<i class='ph ph-database'></i>",
                           '<i class=ph></i>']) {
            assert.deepEqual(detectIconFonts(tag).phosphorWeights, ['regular'], tag);
        }
        for (const tag of ['<i class="fa-solid fa-star"></i>',
                           "<i class='fa-solid fa-star'></i>",
                           '<i class=fa-solid></i>']) {
            assert.equal(detectIconFonts(tag).needsFa, true, tag);
        }
    });

    it('does not count an attribute that merely ends in "class"', () => {
        // The leading \s in CLASS_ATTR_RE. Without it this matches the tail of
        // `data-class=`, which is not a class attribute and styles nothing.
        assert.equal(detectIconFonts('<p data-class="fa-solid">x</p>').needsFa, false);
        assert.deepEqual(detectIconFonts('<p data-class="ph">x</p>').phosphorWeights, []);
    });

    it('detects the Phosphor regular weight from the standalone "ph" class', () => {
        assert.deepEqual(
            detectIconFonts('<i class="ph ph-database"></i>').phosphorWeights,
            ['regular'],
        );
    });

    it('does not read an icon name as the regular weight', () => {
        // "ph-database" alone carries no base class, so nothing should match:
        // this is the guard that keeps `\bph\b(?!-)` from firing on `ph-*`.
        assert.deepEqual(detectIconFonts('<i class="ph-database"></i>').phosphorWeights, []);
    });

    it('detects each Phosphor weight from its base class', () => {
        for (const weight of ['bold', 'fill', 'duotone', 'light', 'thin']) {
            assert.deepEqual(
                detectIconFonts(`<i class="ph-${weight} ph-shield-${weight}"></i>`).phosphorWeights,
                [weight],
                `weight ${weight}`,
            );
        }
    });

    it('collects every distinct weight used in one document', () => {
        const html = '<i class="ph ph-a"></i><i class="ph-bold ph-b-bold"></i><i class="ph-duotone ph-c-duotone"></i>';
        assert.deepEqual(detectIconFonts(html).phosphorWeights, ['regular', 'bold', 'duotone']);
    });

    it('detects both families at once', () => {
        const usage = detectIconFonts('<i class="fa-solid fa-check"></i><i class="ph-fill ph-x-fill"></i>');
        assert.equal(usage.needsFa, true);
        assert.deepEqual(usage.phosphorWeights, ['fill']);
    });
});

// ── buildIconStyles ───────────────────────────────────────────────────────────

describe('buildIconStyles', () => {
    it('returns nothing, and touches no network, for an icon-free document', async () => {
        assert.equal(await buildIconStyles('<p>plain</p>'), '');
    });

    it('returns nothing for an empty document', async () => {
        assert.equal(await buildIconStyles(''), '');
    });
});

// ── iconCacheDir ──────────────────────────────────────────────────────────────

describe('iconCacheDir', () => {
    it('uses ~/Library/Caches on macOS', () => {
        assert.equal(
            iconCacheDir('darwin', {}, '/Users/x'),
            path.join('/Users/x', 'Library', 'Caches', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('uses %LOCALAPPDATA% on Windows', () => {
        assert.equal(
            iconCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'),
            path.join('C:\\Users\\x\\AppData\\Local', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('falls back to the conventional AppData path when LOCALAPPDATA is unset', () => {
        assert.equal(
            iconCacheDir('win32', {}, 'C:\\Users\\x'),
            path.join('C:\\Users\\x', 'AppData', 'Local', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('honours XDG_CACHE_HOME on Linux', () => {
        assert.equal(
            iconCacheDir('linux', { XDG_CACHE_HOME: '/cache' }, '/home/x'),
            path.join('/cache', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('falls back to ~/.cache on Linux', () => {
        assert.equal(
            iconCacheDir('linux', {}, '/home/x'),
            path.join('/home/x', '.cache', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('ignores an empty XDG_CACHE_HOME rather than resolving to a bare path', () => {
        assert.equal(
            iconCacheDir('linux', { XDG_CACHE_HOME: '' }, '/home/x'),
            path.join('/home/x', '.cache', 'platen-markdown-export', 'icon-cache'),
        );
    });

    it('never lands in the shared tmpdir while a home directory exists', () => {
        // The whole point of the directory: the cache filename is the sha256 of
        // a URL this source hardcodes, so a world-writable location would let
        // another local account plant CSS that gets inlined into someone's PDFs.
        for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
            const dir = iconCacheDir(platform, {}, platform === 'win32' ? 'C:\\Users\\x' : '/home/x');
            assert.ok(!dir.startsWith(os.tmpdir()), `${platform} cache dir must not be under tmpdir`);
        }
    });

    it('falls back to a private tmpdir subdirectory when there is no home', () => {
        const dir = iconCacheDir('linux', {}, '');
        assert.ok(dir.startsWith(os.tmpdir()));
        // Private *subdirectory*, not the shared root itself.
        assert.notEqual(path.dirname(path.dirname(dir)), path.dirname(os.tmpdir()));
        assert.match(dir, /platen-markdown-export-/);
    });
});

// ── inlineRemoteStylesheets ───────────────────────────────────────────────────

// Recognition is asserted separately from fetching, because it is invisible in
// the output: an unrecognised <link> and one whose fetch failed both leave the
// document untouched. That is exactly how two ordinary spellings went unnoticed.
describe('findRemoteStylesheetLinks', () => {
    const hrefs = (html: string) => findRemoteStylesheetLinks(html).map(([, href]) => href);
    const CSS   = 'https://cdn.example/a.css';

    it('recognises a stylesheet link whatever the attribute order or quoting', () => {
        for (const tag of [`<link rel="stylesheet" href="${CSS}">`,
                           `<link href="${CSS}" rel="stylesheet">`,   // the spec has no attribute order
                           `<link rel=stylesheet href="${CSS}">`,
                           `<link rel='stylesheet' href='${CSS}'>`,
                           `<LINK REL="STYLESHEET" HREF="${CSS}">`]) {
            assert.deepEqual(hrefs(tag), [CSS], tag);
        }
    });

    it('accepts `stylesheet` as one token of a rel list', () => {
        assert.deepEqual(hrefs(`<link rel="preload stylesheet" href="${CSS}">`), [CSS]);
    });

    it('skips an alternate stylesheet', () => {
        // The one a browser does NOT apply by default; inlining it would paint
        // the wrong styles rather than none.
        assert.deepEqual(hrefs(`<link rel="alternate stylesheet" href="${CSS}">`), []);
    });

    it('skips a non-stylesheet rel and a non-remote href', () => {
        assert.deepEqual(hrefs(`<link rel="icon" href="https://cdn.example/f.png">`), []);
        assert.deepEqual(hrefs('<link rel="stylesheet" href="theme.css">'), []);
    });
});

describe('inlineRemoteStylesheets', () => {
    it('inlines a link whose href precedes its rel', async () => {
        // The order-dependent pattern this replaced matched nothing here, so the
        // <link> survived into the output and WeasyPrint was left to fetch it.
        const html = `<head><link href="${url('/plain.css')}" rel="stylesheet"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.ok(!out.includes('<link'), 'the <link> should be gone');
        assert.match(out, /<style>body \{ color: red; \}<\/style>/);
    });

    it('leaves a document with no remote stylesheet untouched', async () => {
        const html = '<head><link rel="stylesheet" href="theme.css"></head>';
        assert.equal(await inlineRemoteStylesheets(html), html);
    });

    it('replaces a remote <link> with an inline <style>', async () => {
        const html = `<head><link rel="stylesheet" href="${url('/plain.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.ok(!out.includes('<link'), 'the <link> should be gone');
        assert.match(out, /<style>body \{ color: red; \}<\/style>/);
    });

    it('base64-embeds font references so the output is self-contained', async () => {
        const html = `<head><link rel="stylesheet" href="${url('/with-font.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.match(out, /url\('data:font\/woff2;base64,/);
        assert.ok(!out.includes('url(font.woff2)'), 'no relative font reference should survive');
    });

    it('fetches a repeated font reference once and replaces every occurrence', async () => {
        const html = `<head><link rel="stylesheet" href="${url('/with-font.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.equal(hits.get('/font.woff2'), 1, 'the same url() must not be fetched twice');
        assert.equal((out.match(/data:font\/woff2;base64,/g) ?? []).length, 2);
    });

    it('strips fill: declarations WeasyPrint chokes on, but keeps currentColor', async () => {
        const html = `<head><link rel="stylesheet" href="${url('/with-fill.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.ok(!out.includes('fill: #ff0000'), 'literal fill should be stripped');
        assert.match(out, /fill\s*:\s*currentColor/);
    });

    it('keeps an unreachable font as an absolute URL rather than dropping the rule', async () => {
        const html = `<head><link rel="stylesheet" href="${url('/missing-font.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.match(out, /url\('http:\/\/127\.0\.0\.1:\d+\/nope\.woff2'\)/);
    });

    it('leaves the <link> in place when the stylesheet itself cannot be fetched', async () => {
        // A failed inline must not silently delete the reference: WeasyPrint can
        // still fetch it, and the export carries on with a warning.
        const html = `<head><link rel="stylesheet" href="${url('/gone.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.equal(out, html);
    });

    it('inlines several remote stylesheets in one document', async () => {
        const html =
            `<head><link rel="stylesheet" href="${url('/plain.css')}">` +
            `<link rel="stylesheet" href="${url('/with-fill.css')}"></head>`;
        const out = await inlineRemoteStylesheets(html);

        assert.ok(!out.includes('<link'), 'both links should be replaced');
        assert.equal((out.match(/<style>/g) ?? []).length, 2);
    });
});

// ── Bounded fan-out ───────────────────────────────────────────────────────────

describe('font inlining is bounded', () => {
    it('never exceeds CONFIG.concurrency simultaneous font fetches', async () => {
        // Every other renderer that fans out over document matches goes through
        // mapPool; these two were the exceptions. Each in-flight fetch holds a
        // whole response in memory before it is base64-encoded, and one icon-font
        // stylesheet can reference dozens of files.
        const html = `<head><link rel="stylesheet" href="${url('/many-fonts.css')}"></head>`;
        const out  = await inlineRemoteStylesheets(html);

        assert.equal((out.match(/data:font\/woff2;base64,/g) ?? []).length, 16, 'all 16 must still be inlined');
        assert.ok(peakInFlight > 1, `expected real parallelism, saw peak ${peakInFlight}`);
        assert.ok(
            peakInFlight <= CONFIG.concurrency,
            `peak in-flight ${peakInFlight} exceeded the ${CONFIG.concurrency} limit`,
        );
    });
});

// ── Degraded results must never be cached ─────────────────────────────────────

/**
 * The disk cache is permanent, has no expiry, and is trusted on the next read.
 *
 * Every failure path in the inliner *removes* what it could not fetch and
 * returns normally, which read as success to a caller that only looked at the
 * string — and that caller wrote the string to the cache. One transient blip
 * therefore produced a silently wrong export forever: later runs logged
 * "(disk cache)", made no request at all, and raised no warning, so not even
 * `--strict` could see it. The only remedy was knowing `--clear-cache` existed.
 *
 * These tests pin the rule that fixes it: only a COMPLETE inline earns an entry.
 */
describe('icon-font disk cache', () => {
    /** Redirects the cache under a scratch home for one call. */
    async function withScratchCache<T>(fn: (dir: string) => Promise<T>): Promise<T> {
        const home  = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-cache-'));
        const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CACHE_HOME, LAD: process.env.LOCALAPPDATA };
        process.env.HOME = home;
        process.env.XDG_CACHE_HOME = path.join(home, '.cache');
        process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
        try {
            return await fn(iconCacheDir());
        } finally {
            for (const [k, v] of [['HOME', saved.HOME], ['XDG_CACHE_HOME', saved.XDG], ['LOCALAPPDATA', saved.LAD]] as const) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
            fs.rmSync(home, { recursive: true, force: true });
        }
    }

    const entries = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

    it('caches a stylesheet whose every reference resolved', async () => {
        await withScratchCache(async dir => {
            const out = await buildIconStylesheet('Whole', url('/whole-font.css'));
            assert.match(out, /data:font\/woff2;base64,/, 'the font must be inlined');
            assert.equal(entries(dir).length, 1, 'a complete inline earns a cache entry');
        });
    });

    it('does NOT cache a stylesheet whose @import could not be fetched', async () => {
        await withScratchCache(async dir => {
            await buildIconStylesheet('Broken', url('/broken-import.css'));
            assert.deepEqual(entries(dir), [], 'a degraded inline must not be persisted');
        });
    });

    it('does NOT cache a stylesheet whose font could not be inlined', async () => {
        await withScratchCache(async dir => {
            const out = await buildIconStylesheet('MissingFont', url('/missing-font.css'));
            // The declaration survives pointing at the network — right for this
            // export, wrong to remember.
            assert.match(out, /url\('http/);
            assert.deepEqual(entries(dir), [], 'a degraded inline must not be persisted');
        });
    });

    it('retries on the next run instead of replaying a poisoned entry', async () => {
        await withScratchCache(async () => {
            const before = hits.get('/broken-import.css') ?? 0;
            await buildIconStylesheet('Broken', url('/broken-import.css'));
            clearCssImportCache();
            await buildIconStylesheet('Broken', url('/broken-import.css'));
            assert.equal((hits.get('/broken-import.css') ?? 0) - before, 2,
                         'the second export must reach the network again, not serve a cached failure');
        });
    });

    it('serves a complete entry from disk without touching the network', async () => {
        await withScratchCache(async () => {
            await buildIconStylesheet('Whole', url('/whole-font.css'));
            const after = hits.get('/whole-font.css') ?? 0;
            await buildIconStylesheet('Whole', url('/whole-font.css'));
            assert.equal(hits.get('/whole-font.css') ?? 0, after,
                         'a good entry must still short-circuit the fetch');
        });
    });
});

// ── Rejected imports are evicted, not remembered ──────────────────────────────

describe('CSS import cache', () => {
    it('does not replay a rejected import within the same process', async () => {
        // `--watch` re-enters main() in one process. A rejected promise left in
        // the map is replayed instantly on every later export, so the failure
        // outlived the condition that caused it and nothing retried.
        const before = hits.get('/gone.css') ?? 0;
        await buildIconStylesheet('Broken', url('/broken-import.css'));
        await buildIconStylesheet('Broken2', url('/broken-import.css'));
        assert.ok((hits.get('/gone.css') ?? 0) - before >= 2,
                  'the failed import must be attempted again, not served from a cached rejection');
    });
});
