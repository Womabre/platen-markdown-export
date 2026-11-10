import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as http from 'http';
import { startServer, categorizeStderr, exportPdf, explainWeasyprintFailure, buildWeasyprintArgs,
         probeColorEmojiRendering, colorEmojiRenderingSupported, buildWeasyprintEnv } from '../weasyprint';
import { CONFIG } from '../config';
import { tempSiblingPath, commitFileAtomic, writeFileAtomic } from '../fsutil';

// ── startServer ───────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-server-test-'));
    fs.writeFileSync(path.join(tmpDir, 'page.html'), '<html><body>hello</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Use http.request with the options form so the path is sent verbatim —
// http.get with a URL string normalises away ".." and encoded characters.
function get(port: number, rawPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: rawPath }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('startServer', () => {
    it('serves an existing file with the correct MIME type', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status, body } = await get(port, `/${token}/page.html`);
            assert.equal(status, 200);
            assert.ok(body.includes('hello'));
        } finally { server.close(); }
    });

    it('serves a CSS file with text/css content-type', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${token}/style.css`);
            assert.equal(status, 200);
        } finally { server.close(); }
    });

    // A request target is `path[?query]`; the query is not part of the filename.
    // Cache-busted references (`<img src="chart.png?v=2">`) are ordinary in
    // hand-written HTML and used to 404 because the whole target was resolved
    // as a path.
    it('ignores a query string when resolving the path', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status, body } = await get(port, `/${token}/page.html?v=2`);
            assert.equal(status, 200);
            assert.ok(body.includes('hello'));
        } finally { server.close(); }
    });

    it('still enforces the token on a request carrying a query string', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, '/page.html?v=2');
            assert.equal(status, 403);
        } finally { server.close(); }
    });

    it('returns 404 for a missing file', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${token}/nonexistent.html`);
            assert.equal(status, 404);
        } finally { server.close(); }
    });

    it('returns 204 for /favicon.ico', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, '/favicon.ico');
            assert.equal(status, 204);
        } finally { server.close(); }
    });

    it('returns 403 for a path-traversal attempt', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${token}/../../../etc/passwd`);
            assert.equal(status, 403);
        } finally { server.close(); }
    });

    it('returns 400 for a URL with invalid percent-encoding', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${token}/%xy`);
            assert.equal(status, 400);
        } finally { server.close(); }
    });

    // ── Capability token ──────────────────────────────────────────────────────
    // The served directory is the user's own working folder, so knowing the
    // port must not be enough to read what is in it.

    it('refuses a request with no token', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, '/page.html');
            assert.equal(status, 403);
        } finally { server.close(); }
    });

    it('refuses a request with the wrong token', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${'0'.repeat(32)}/page.html`);
            assert.equal(status, 403);
        } finally { server.close(); }
    });

    it('refuses a bare token with no trailing slash', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status } = await get(port, `/${token}`);
            assert.equal(status, 403);
        } finally { server.close(); }
    });

    it('issues a fresh 32-hex-character token per run', async () => {
        const a = await startServer(path.join(tmpDir, 'page.html'));
        const b = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.match(a.token, /^[0-9a-f]{32}$/);
            assert.notEqual(a.token, b.token);
            // A token is a capability for its own run only.
            assert.equal((await get(a.port, `/${b.token}/page.html`)).status, 403);
        } finally { a.server.close(); b.server.close(); }
    });

    // ── In-memory documents ───────────────────────────────────────────────────
    // The processed HTML is served from memory rather than written next to the
    // user's document, so an export leaves nothing behind (and nothing to clean
    // up if it dies mid-run).

    it('serves an in-memory document without it existing on disk', async () => {
        const { server, port, token } = await startServer(
            path.join(tmpDir, 'page.html'), { files: { 'virtual.html': '<p>from memory</p>' } },
        );
        try {
            assert.ok(!fs.existsSync(path.join(tmpDir, 'virtual.html')), 'should not touch disk');
            const { status, body } = await get(port, `/${token}/virtual.html`);
            assert.equal(status, 200);
            assert.ok(body.includes('from memory'));
        } finally { server.close(); }
    });

    it('still serves real files from the directory alongside it', async () => {
        const { server, port, token } = await startServer(
            path.join(tmpDir, 'page.html'), { files: { 'virtual.html': '<p>mem</p>' } },
        );
        try {
            // This is what makes relative asset references keep working.
            assert.equal((await get(port, `/${token}/style.css`)).status, 200);
            assert.ok((await get(port, `/${token}/page.html`)).body.includes('hello'));
        } finally { server.close(); }
    });

    it('an in-memory document shadows a same-named file on disk', async () => {
        const { server, port, token } = await startServer(
            path.join(tmpDir, 'page.html'), { files: { 'page.html': '<p>shadowed</p>' } },
        );
        try {
            assert.ok((await get(port, `/${token}/page.html`)).body.includes('shadowed'));
        } finally { server.close(); }
    });

    it('serves in-memory documents as UTF-8 HTML', async () => {
        const { server, port, token } = await startServer(
            path.join(tmpDir, 'page.html'), { files: { 'v.html': '<p>Café — naïve</p>' } },
        );
        try {
            const { body } = await get(port, `/${token}/v.html`);
            assert.ok(body.includes('Café — naïve'), body);
        } finally { server.close(); }
    });

    it('still requires the token for an in-memory document', async () => {
        const { server, port } = await startServer(
            path.join(tmpDir, 'page.html'), { files: { 'v.html': '<p>x</p>' } },
        );
        try {
            assert.equal((await get(port, '/v.html')).status, 403);
        } finally { server.close(); }
    });

    it('404s an in-memory name that was not registered', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'), { files: {} });
        try {
            assert.equal((await get(port, `/${token}/ghost.html`)).status, 404);
        } finally { server.close(); }
    });

    it('urlFor() builds a loopback URL carrying the token', async () => {
        const { server, port, token, urlFor } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.equal(urlFor('page.html'), `http://127.0.0.1:${port}/${token}/page.html`);
            // Percent-encoded so a filename with spaces survives the round trip.
            assert.equal(urlFor('sample doc.html'), `http://127.0.0.1:${port}/${token}/sample%20doc.html`);
        } finally { server.close(); }
    });

    it('serves the URL that urlFor() hands to WeasyPrint', async () => {
        const { server, port, urlFor } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const url = new URL(urlFor('page.html'));
            const { status, body } = await get(port, url.pathname);
            assert.equal(status, 200);
            assert.ok(body.includes('hello'));
        } finally { server.close(); }
    });
});

// ── categorizeStderr ──────────────────────────────────────────────────────────

// ── The server as WeasyPrint's proxy ──────────────────────────────────────────
//
// WeasyPrint fetches whatever the pipeline did not inline, and it is pointed at
// this server as its HTTP proxy so those fetches meet the same guard. These
// drive the proxy the way a proxy client does: an absolute-form request target
// for http, CONNECT for https.

describe('startServer as a proxy', () => {
    let origin: http.Server;
    let originPort: number;
    let originHits: string[];
    const saved = CONFIG.allowPrivateHosts;

    before(async () => {
        originHits = [];
        origin = http.createServer((req, res) => {
            originHits.push(req.url ?? '');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('internal');
        });
        await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
        originPort = (origin.address() as { port: number }).port;
    });

    after(() => { CONFIG.allowPrivateHosts = saved; origin.close(); });

    /** A CONNECT through the proxy; resolves with the status and the tunnel. */
    function connect(port: number, target: string): Promise<{ status: number; socket: import('net').Socket }> {
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: target });
            req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
            req.on('error', reject);
            req.end();
        });
    }

    it('serves its own document through the proxy form, token and all', async () => {
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const { status, body } = await get(port, `http://127.0.0.1:${port}/${token}/page.html`);
            assert.equal(status, 200);
            assert.ok(body.includes('hello'));
        } finally { server.close(); }
    });

    it('still demands the token in the proxy form', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.equal((await get(port, `http://127.0.0.1:${port}/page.html`)).status, 403);
        } finally { server.close(); }
    });

    // The defect: the pipeline refused this URL, left the tag in place, and
    // WeasyPrint fetched it itself. Through the proxy it is refused again, and
    // the internal server never hears about it.
    it('refuses to relay a request for a loopback host', async () => {
        CONFIG.allowPrivateHosts = false;
        originHits.length = 0;
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.equal((await get(port, `http://127.0.0.1:${originPort}/secret`)).status, 403);
            assert.equal((await get(port, `http://localhost:${originPort}/secret`)).status, 403);
            assert.equal((await get(port, `http://[::ffff:127.0.0.1]:${originPort}/secret`)).status, 403);
            assert.deepEqual(originHits, []);
        } finally { server.close(); }
    });

    it('does not treat another spelling of its own address as itself', async () => {
        CONFIG.allowPrivateHosts = false;
        const { server, port, token } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.equal((await get(port, `http://localhost:${port}/${token}/page.html`)).status, 403);
        } finally { server.close(); }
    });

    it('refuses a non-http scheme in the proxy form', async () => {
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            assert.equal((await get(port, 'ftp://example.com/x')).status, 403);
        } finally { server.close(); }
    });

    it('refuses a CONNECT to a loopback host, by address and by name', async () => {
        CONFIG.allowPrivateHosts = false;
        originHits.length = 0;
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            for (const target of [`127.0.0.1:${originPort}`, `localhost:${originPort}`, `[::1]:${originPort}`]) {
                const { status, socket } = await connect(port, target);
                socket.destroy();
                assert.equal(status, 403, target);
            }
            assert.deepEqual(originHits, []);
        } finally { server.close(); }
    });

    it('relays and tunnels once private hosts are allowed', async () => {
        CONFIG.allowPrivateHosts = true;
        originHits.length = 0;
        const { server, port } = await startServer(path.join(tmpDir, 'page.html'));
        try {
            const relayed = await get(port, `http://127.0.0.1:${originPort}/relayed`);
            assert.equal(relayed.status, 200);
            assert.equal(relayed.body, 'internal');

            const { status, socket } = await connect(port, `127.0.0.1:${originPort}`);
            assert.equal(status, 200);
            const reply = await new Promise<string>(resolve => {
                let data = '';
                socket.on('data', (c: Buffer) => { data += c.toString(); });
                socket.on('end', () => resolve(data));
                socket.write('GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
            });
            assert.ok(reply.startsWith('HTTP/1.1 200') && reply.includes('internal'), reply);
            assert.deepEqual(originHits, ['/relayed', '/tunnelled']);
        } finally { server.close(); CONFIG.allowPrivateHosts = false; }
    });
});

describe('buildWeasyprintEnv', () => {
    it('returns the environment untouched when there is no proxy', () => {
        const base = { PATH: '/bin', HTTP_PROXY: 'http://corp:8080' };
        assert.equal(buildWeasyprintEnv(base, null), base);
    });

    it('points both schemes at the proxy', () => {
        const env = buildWeasyprintEnv({ PATH: '/bin' }, 'http://127.0.0.1:5');
        assert.equal(env.http_proxy, 'http://127.0.0.1:5');
        assert.equal(env.https_proxy, 'http://127.0.0.1:5');
        assert.equal(env.PATH, '/bin');
    });

    // A surviving NO_PROXY names hosts WeasyPrint may reach without the proxy.
    it('removes every other proxy variable, in either case', () => {
        const env = buildWeasyprintEnv({
            HTTP_PROXY: 'http://corp:8080', HTTPS_PROXY: 'http://corp:8080', ALL_PROXY: 'socks://corp',
            NO_PROXY: '*', no_proxy: 'localhost,127.0.0.1', Https_Proxy: 'x', KEEP: '1',
        }, 'http://127.0.0.1:5');
        assert.deepEqual(Object.keys(env).sort(), ['KEEP', 'http_proxy', 'https_proxy']);
    });

    it('does not mutate the environment it was given', () => {
        const base = { NO_PROXY: '*' };
        buildWeasyprintEnv(base, 'http://127.0.0.1:5');
        assert.deepEqual(base, { NO_PROXY: '*' });
    });
});

describe('categorizeStderr', () => {
    it('puts non-WARNING lines into errors', () => {
        const { errors, warnings, suppressedCount } = categorizeStderr(
            'ERROR: Failed to load stylesheet at http://x : HTTP 404\n',
        );
        assert.ok(errors.includes('ERROR:'));
        assert.equal(warnings, '');
        assert.equal(suppressedCount, 0);
    });

    it('suppresses "Unknown property" warnings (case-insensitive match)', () => {
        const { errors, warnings } = categorizeStderr(
            'WARNING: Unknown property "gap" at 1:1.\n',
        );
        // "unknown property" is in the ignore list with /i flag
        assert.equal(warnings, '');
        assert.equal(errors, '');
    });

    it('suppresses known-harmless @keyframes warnings', () => {
        const { warnings, suppressedCount } = categorizeStderr(
            'WARNING: Unknown rule <AtRule @keyframes spin { … }> at 3:12\n',
        );
        assert.equal(warnings, '');
        assert.ok(suppressedCount >= 1);
    });

    it('suppresses prefers-reduced-motion warnings', () => {
        const stderr = [
            "WARNING: Expected a media type, got '(prefers-reduced-motion:reduce)'",
            "WARNING: Invalid media type ' (prefers-reduced-motion:reduce)' the whole @media rule was ignored at 6:4209.",
        ].join('\n');
        const { warnings, suppressedCount } = categorizeStderr(stderr);
        assert.equal(warnings, '');
        assert.equal(suppressedCount, 2);
    });

    it('suppresses :host/:root selector warnings', () => {
        const { warnings, suppressedCount } = categorizeStderr(
            "WARNING: Invalid or unsupported selector, ':host,:root'\n",
        );
        assert.equal(warnings, '');
        assert.ok(suppressedCount >= 1);
    });

    it('surfaces an unrecognised WARNING', () => {
        const { warnings } = categorizeStderr(
            'WARNING: Something we have never seen before at 99:1.\n',
        );
        assert.ok(warnings.includes('Something we have never seen before'));
    });

    it('counts suppressed warnings correctly for mixed stderr', () => {
        const stderr = [
            'ERROR: Fatal problem',
            'WARNING: Unknown rule <AtRule @keyframes pulse { … }> at 2:1',  // suppressed
            'WARNING: Unknown property "gap" at 3:1',                         // suppressed (case-insensitive)
            'WARNING: Something unexpected at 4:1',                            // visible
        ].join('\n');
        const { errors, warnings, suppressedCount } = categorizeStderr(stderr);
        assert.ok(errors.includes('Fatal problem'));
        assert.ok(warnings.includes('Something unexpected'));
        assert.equal(suppressedCount, 2);
    });

    it('returns empty strings and zero count for empty stderr', () => {
        const { errors, warnings, suppressedCount } = categorizeStderr('');
        assert.equal(errors, '');
        assert.equal(warnings, '');
        assert.equal(suppressedCount, 0);
    });

    it('handles stderr with only blank lines', () => {
        const { suppressedCount } = categorizeStderr('\n  \n\n');
        assert.equal(suppressedCount, 0);
    });
});

// ── buildWeasyprintArgs ───────────────────────────────────────────────────────

describe('buildWeasyprintArgs', () => {
    it('omits --pdf-variant entirely when null, producing an ordinary PDF', () => {
        const args = buildWeasyprintArgs('http://x/doc', '/tmp/out.pdf', 300, null);
        assert.deepEqual(args, ['--optimize-images', '--dpi', '300', 'http://x/doc', '/tmp/out.pdf']);
        assert.ok(!args.includes('--pdf-variant'));
    });

    it('inserts --pdf-variant before the url and output path when set', () => {
        const args = buildWeasyprintArgs('http://x/doc', '/tmp/out.pdf', 300, 'pdf/a-2b');
        assert.deepEqual(args, ['--optimize-images', '--dpi', '300', '--pdf-variant', 'pdf/a-2b', 'http://x/doc', '/tmp/out.pdf']);
    });

    it('carries the dpi value through as a string', () => {
        const args = buildWeasyprintArgs('http://x/doc', '/tmp/out.pdf', 150, null);
        assert.ok(args.includes('150'));
    });
});

// ── probeColorEmojiRendering / colorEmojiRenderingSupported ───────────────────
//
// Same reasoning as `exportPdf failure handling` below: no real WeasyPrint
// here. `process.execPath` rejecting [htmlFile, pdfFile] as its own argv is a
// real child-process failure on every platform CI runs, with nothing
// installed — enough to test the probe's failure path, its cleanup, and the
// process-lifetime cache, without asserting what a *working* WeasyPrint would
// answer (environment-dependent, and exactly what verify:pdf is for).

describe('probeColorEmojiRendering', () => {
    it('returns false, not a thrown error, when the binary fails', async () => {
        const result = await probeColorEmojiRendering(process.execPath);
        assert.equal(result, false);
    });

    it('leaves no temp directory behind either way', async () => {
        const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('pme-emoji-probe-'));
        await probeColorEmojiRendering(process.execPath);
        const after = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('pme-emoji-probe-'));
        assert.equal(after.length, before.length);
    });
});

describe('colorEmojiRenderingSupported', () => {
    it('caches by weasyprintPath: a second call returns the same Promise, not a second probe', () => {
        // A fake, unique path per test run so this test cannot share the cache
        // with a previous one (the cache is process-lifetime, keyed by path).
        const fakePath = `${process.execPath}#emoji-cache-test-${Date.now()}`;
        const first  = colorEmojiRenderingSupported(fakePath);
        const second = colorEmojiRenderingSupported(fakePath);
        assert.equal(first, second, 'same Promise instance — the second call must not re-probe');
    });

    it('resolves to a boolean', async () => {
        const fakePath = `${process.execPath}#emoji-boolean-test-${Date.now()}`;
        const result = await colorEmojiRenderingSupported(fakePath);
        assert.equal(typeof result, 'boolean');
    });
});

// ── exportPdf failure handling ────────────────────────────────────────────────
//
// The suite never runs WeasyPrint. It does not have to: what matters here is
// what happens to the OUTPUT file when the binary exits non-zero, and any
// non-zero exit will do. `process.execPath` is node itself, which rejects
// `--optimize-images` and exits 9 — a real failing child process, on every
// platform CI runs, with nothing installed.

describe('exportPdf failure handling', () => {
    let outDir: string;

    before(() => {
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-pdf-test-'));
    });

    after(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    it('leaves an existing PDF intact when WeasyPrint fails', async () => {
        // The regression this file exists for. A failed export used to unlink
        // the output path — which, because WeasyPrint never opens that file when
        // it fails, meant deleting the PREVIOUS good export.
        const pdfFile = path.join(outDir, 'keeps-previous.pdf');
        writeFileAtomic(pdfFile, '%PDF-1.7 previous good export');

        await assert.rejects(
            () => exportPdf(process.execPath, 'http://127.0.0.1:1/unreachable', pdfFile),
            (err: unknown) => err instanceof Error && (err as { exitCode?: number }).exitCode === 4,
        );

        assert.equal(fs.existsSync(pdfFile), true, 'previous export must survive a failed run');
        assert.equal(fs.readFileSync(pdfFile, 'utf8'), '%PDF-1.7 previous good export');
    });

    it('does not create an output file when WeasyPrint fails and there was none', async () => {
        const pdfFile = path.join(outDir, 'never-existed.pdf');

        await assert.rejects(() => exportPdf(process.execPath, 'http://127.0.0.1:1/x', pdfFile));

        assert.equal(fs.existsSync(pdfFile), false);
    });

    it('leaves no temp file behind after a failed run', async () => {
        const pdfFile = path.join(outDir, 'no-litter.pdf');

        await assert.rejects(() => exportPdf(process.execPath, 'http://127.0.0.1:1/x', pdfFile));

        assert.equal(fs.existsSync(tempSiblingPath(pdfFile)), false);
        assert.deepEqual(fs.readdirSync(outDir).filter(f => f.includes('no-litter')), []);
    });
});

// ── Atomic file landing ───────────────────────────────────────────────────────
//
// exportPdf hands WeasyPrint a temp path and lands it with commitFileAtomic, so
// the success half of that contract is tested here directly rather than by
// running the binary. (The real end-to-end render is `npm run verify:pdf`.)

describe('tempSiblingPath / commitFileAtomic', () => {
    let outDir: string;

    before(() => {
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-atomic-test-'));
    });

    after(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    it('puts the temp file beside its destination, hidden, pid-tagged', () => {
        const dest = path.join(outDir, 'doc.pdf');
        const tmp  = tempSiblingPath(dest);

        assert.equal(path.dirname(tmp), outDir, 'must share a filesystem with the destination');
        assert.match(path.basename(tmp), /^\.doc\.pdf\.\d+\.tmp$/);
    });

    it('replaces the destination with the temp file', () => {
        const dest = path.join(outDir, 'replaced.pdf');
        writeFileAtomic(dest, 'old');

        const tmp = tempSiblingPath(dest);
        fs.writeFileSync(tmp, 'new');
        commitFileAtomic(tmp, dest);

        assert.equal(fs.readFileSync(dest, 'utf8'), 'new');
        assert.equal(fs.existsSync(tmp), false, 'rename consumes the temp file');
    });

    it('lands a file that did not exist yet', () => {
        const dest = path.join(outDir, 'fresh.pdf');
        const tmp  = tempSiblingPath(dest);
        fs.writeFileSync(tmp, 'fresh');

        commitFileAtomic(tmp, dest);

        assert.equal(fs.readFileSync(dest, 'utf8'), 'fresh');
    });

    it('keeps the destination\'s own permissions rather than the temp file\'s', function () {
        if (process.platform === 'win32') return; // no usable POSIX mode
        const dest = path.join(outDir, 'perms.pdf');
        writeFileAtomic(dest, 'old');
        fs.chmodSync(dest, 0o640);

        const tmp = tempSiblingPath(dest);
        fs.writeFileSync(tmp, 'new');
        fs.chmodSync(tmp, 0o600);
        commitFileAtomic(tmp, dest);

        assert.equal(fs.statSync(dest).mode & 0o777, 0o640);
    });
});

// ── explainWeasyprintFailure ──────────────────────────────────────────────────
//
// WeasyPrint is Python, so a failure arrives as ~60 lines of interpreter frames
// with the reason on the last one. execFile puts the whole thing in
// error.message, which used to be pasted straight into the thrown error.

describe('explainWeasyprintFailure', () => {
    const TRACEBACK = [
        'Traceback (most recent call last):',
        '  File "/opt/homebrew/.../urllib/request.py", line 1320, in do_open',
        '    h.request(req.get_method(), req.selector, req.data, headers,',
        'ConnectionRefusedError: [Errno 61] Connection refused',
        '',
        'During handling of the above exception, another exception occurred:',
        '',
        'Traceback (most recent call last):',
        '  File "/opt/homebrew/.../weasyprint/urls.py", line 467, in fetch',
        '    resource = url_fetcher(url)',
        'weasyprint.urls.URLFetchingError: URLError: <urlopen error [Errno 61] Connection refused>',
    ].join('\n');

    it('returns the final exception line of a chained traceback', () => {
        assert.equal(
            explainWeasyprintFailure(TRACEBACK, 'Command failed: weasyprint ...'),
            'weasyprint.urls.URLFetchingError: URLError: <urlopen error [Errno 61] Connection refused>',
        );
    });

    it('does not return an indented frame line', () => {
        assert.ok(!explainWeasyprintFailure(TRACEBACK, 'x').startsWith(' '));
        assert.ok(!explainWeasyprintFailure(TRACEBACK, 'x').includes('File "'));
    });

    it('skips the "During handling" and "Traceback" scaffolding', () => {
        const reason = explainWeasyprintFailure(TRACEBACK, 'x');
        assert.ok(!/^Traceback/.test(reason));
        assert.ok(!/^During handling/.test(reason));
    });

    it('is one line, where the traceback was many', () => {
        assert.equal(explainWeasyprintFailure(TRACEBACK, 'x').split('\n').length, 1);
        assert.ok(TRACEBACK.split('\n').length > 5);
    });

    it('falls back to the first line of the fallback when stderr says nothing', () => {
        assert.equal(
            explainWeasyprintFailure('', 'Command failed: weasyprint --dpi 300\nmore noise\nand more'),
            'Command failed: weasyprint --dpi 300',
        );
    });

    it('falls back when stderr is only indented frames', () => {
        assert.equal(explainWeasyprintFailure('   at frame\n   at frame', 'Command failed: x'), 'Command failed: x');
    });

    it('handles a single-line stderr with no traceback at all', () => {
        assert.equal(explainWeasyprintFailure('weasyprint: error: unrecognized arguments', 'x'),
                     'weasyprint: error: unrecognized arguments');
    });
});
