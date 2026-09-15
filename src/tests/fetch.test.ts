import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net  from 'net';
import sharp from 'sharp';
import { fetchRemote, fetchRemoteText, fetchAsBase64, fetchAsBuffer, normalizeRaster, resolveRedirect,
         isPrivateAddress, BlockedHostError } from '../fetch';
import { CONFIG } from '../config';

// These suites drive the fetcher against a loopback server, which the
// private-address guard refuses by default — see `isPrivateAddress`. Opting in
// here is the same switch a document that legitimately pulls assets off your own
// network uses (EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1). The guard's own behaviour is
// asserted in the "private-address guard" suite below, which turns it back on.
CONFIG.allowPrivateHosts = true;


// ── Minimal 1×1 PNG bytes ─────────────────────────────────────────────────────
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

// ── Test HTTP server ──────────────────────────────────────────────────────────

function startTestServer(
    handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as net.AddressInfo).port });
        });
    });
}

let server: http.Server;
let port:   number;
let tmpDir: string;

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-fetch-test-'));

    ({ server, port } = await startTestServer((req, res) => {
        if (req.url === '/hello.txt') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('hello world');
        } else if (req.url === '/binary') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(Buffer.from([0x01, 0x02, 0x03]));
        } else if (req.url === '/image.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(TINY_PNG);
        } else if (req.url === '/redirect') {
            res.writeHead(301, { Location: `http://127.0.0.1:${port}/hello.txt` });
            res.end();
        } else if (req.url === '/loop') {
            res.writeHead(301, { Location: `http://127.0.0.1:${port}/loop` });
            res.end();
        } else {
            res.writeHead(404);
            res.end();
        }
    }));
});

after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── fetchRemote ───────────────────────────────────────────────────────────────

describe('fetchRemote', () => {
    it('returns buffer and mimeType for a 200 response', async () => {
        const { buffer, mimeType } = await fetchRemote(`http://127.0.0.1:${port}/hello.txt`);
        assert.equal(buffer.toString('utf8'), 'hello world');
        assert.equal(mimeType, 'text/plain');
    });

    it('rejects with an HTTP 404 error', async () => {
        await assert.rejects(
            () => fetchRemote(`http://127.0.0.1:${port}/not-found`),
            /HTTP 404/,
        );
    });

    it('follows a 301 redirect', async () => {
        const { buffer } = await fetchRemote(`http://127.0.0.1:${port}/redirect`);
        assert.equal(buffer.toString('utf8'), 'hello world');
    });

    it('follows a 303 redirect', async () => {
        const { server: s, port: p } = await startTestServer((req, res) => {
            if (req.url === '/start') {
                res.writeHead(303, { Location: `http://127.0.0.1:${p}/end` });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('done');
            }
        });
        try {
            const { buffer } = await fetchRemote(`http://127.0.0.1:${p}/start`);
            assert.equal(buffer.toString('utf8'), 'done');
        } finally { s.close(); }
    });

    it('follows a 307 redirect', async () => {
        const { server: s, port: p } = await startTestServer((req, res) => {
            if (req.url === '/start') {
                res.writeHead(307, { Location: `http://127.0.0.1:${p}/end` });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('done');
            }
        });
        try {
            const { buffer } = await fetchRemote(`http://127.0.0.1:${p}/start`);
            assert.equal(buffer.toString('utf8'), 'done');
        } finally { s.close(); }
    });

    it('follows a 308 redirect', async () => {
        const { server: s, port: p } = await startTestServer((req, res) => {
            if (req.url === '/start') {
                res.writeHead(308, { Location: `http://127.0.0.1:${p}/end` });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('done');
            }
        });
        try {
            const { buffer } = await fetchRemote(`http://127.0.0.1:${p}/start`);
            assert.equal(buffer.toString('utf8'), 'done');
        } finally { s.close(); }
    });

    it('rejects when the redirect limit is exceeded', async () => {
        await assert.rejects(
            () => fetchRemote(`http://127.0.0.1:${port}/loop`, 0),
            /Too many redirects/,
        );
    });

    it('passes custom request headers to the server', async () => {
        let receivedHeader = '';
        const { server: s, port: p } = await startTestServer((req, res) => {
            receivedHeader = req.headers['x-test'] as string ?? '';
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        });
        try {
            await fetchRemote(`http://127.0.0.1:${p}/`, 5, { 'x-test': 'sentinel' });
            assert.equal(receivedHeader, 'sentinel');
        } finally {
            s.close();
        }
    });
});

// ── fetchRemoteText ───────────────────────────────────────────────────────────

describe('fetchRemoteText', () => {
    it('returns the response body as a UTF-8 string', async () => {
        const text = await fetchRemoteText(`http://127.0.0.1:${port}/hello.txt`);
        assert.equal(text, 'hello world');
    });
});

// ── fetchAsBase64 ─────────────────────────────────────────────────────────────

describe('fetchAsBase64', () => {
    it('returns a data URI for a remote URL', async () => {
        const result = await fetchAsBase64(`http://127.0.0.1:${port}/hello.txt`);
        assert.ok(result.startsWith('data:'), 'should start with data:');
        assert.ok(result.includes(';base64,'), 'should contain base64 marker');
    });

    it('returns a data URI for a local file', async () => {
        const file = path.join(tmpDir, 'local.txt');
        fs.writeFileSync(file, 'local content');
        const result = await fetchAsBase64(file);
        assert.ok(result.startsWith('data:'));
        assert.ok(result.includes(';base64,'));
    });

    it('decodes to the original content for a local PNG', async () => {
        const file = path.join(tmpDir, 'asset.png');
        fs.writeFileSync(file, TINY_PNG);
        const result = await fetchAsBase64(file);
        assert.ok(result.startsWith('data:image/png;base64,'));
        const decoded = Buffer.from(result.split(',')[1], 'base64');
        assert.deepEqual(decoded, TINY_PNG);
    });

    it('throws for a non-existent source', async () => {
        await assert.rejects(
            () => fetchAsBase64(path.join(tmpDir, 'nope.bin')),
            /Source not found/,
        );
    });
});

// ── fetchAsBuffer ─────────────────────────────────────────────────────────────

describe('fetchAsBuffer', () => {
    it('returns buffer and mimeType for a remote URL', async () => {
        const { buffer, mimeType } = await fetchAsBuffer(`http://127.0.0.1:${port}/binary`);
        assert.deepEqual(buffer, Buffer.from([0x01, 0x02, 0x03]));
        assert.equal(mimeType, 'application/octet-stream');
    });

    it('returns buffer and mimeType for a local PNG file', async () => {
        const file = path.join(tmpDir, 'img.png');
        fs.writeFileSync(file, TINY_PNG);
        const { buffer, mimeType } = await fetchAsBuffer(file);
        assert.deepEqual(buffer, TINY_PNG);
        assert.equal(mimeType, 'image/png');
    });

    it('throws for a missing local path', async () => {
        await assert.rejects(
            () => fetchAsBuffer(path.join(tmpDir, 'missing.png')),
            /Source not found/,
        );
    });
});

// ── normalizeRaster ───────────────────────────────────────────────────────────

describe('normalizeRaster', () => {
    it('passes a non-raster MIME type through unchanged', async () => {
        const buf = Buffer.from('not-an-image');
        const result = await normalizeRaster(buf, 'image/png');
        assert.equal(result.buffer, buf);
        assert.equal(result.mimeType, 'image/png');
    });

    it('passes JPEG through unchanged without re-encoding', async () => {
        const buf = Buffer.from([0xff, 0xd8, 0xff]);
        const result = await normalizeRaster(buf, 'image/jpeg');
        assert.equal(result.buffer, buf);
        assert.equal(result.mimeType, 'image/jpeg');
    });

    it('converts an opaque WEBP buffer to JPEG', async () => {
        const webpBuf = await sharp({
            create: { width: 2, height: 2, channels: 3, background: { r: 100, g: 150, b: 200 } },
        }).webp().toBuffer();

        const { buffer, mimeType } = await normalizeRaster(webpBuf, 'image/webp');
        assert.equal(mimeType, 'image/jpeg');
        // JPEG files begin with the SOI marker FF D8
        assert.equal(buffer[0], 0xff);
        assert.equal(buffer[1], 0xd8);
    });

    it('converts a transparent WEBP buffer to PNG, preserving alpha', async () => {
        const webpBuf = await sharp({
            create: { width: 2, height: 2, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.5 } },
        }).webp().toBuffer();

        const { buffer, mimeType } = await normalizeRaster(webpBuf, 'image/webp');
        assert.equal(mimeType, 'image/png');
        const meta = await sharp(buffer).metadata();
        assert.equal(meta.format, 'png');
        assert.equal(meta.hasAlpha, true);
    });
});

// ── Redirect safety ───────────────────────────────────────────────────────────
//
// A redirect is the one place a fetch changes destination without the caller
// naming the new one, so it must not be able to change the scheme, and it must
// not carry request headers to a host the caller never chose.

describe('resolveRedirect', () => {
    const AUTH = { Authorization: 'Bearer secret', 'User-Agent': 'tme' };

    it('resolves a relative Location against the current URL', () => {
        assert.equal(
            resolveRedirect('/b.css', 'https://cdn.example.com/a.css', {}).url,
            'https://cdn.example.com/b.css',
        );
    });

    it('keeps headers on a same-origin redirect', () => {
        assert.deepEqual(
            resolveRedirect('/b.css', 'https://cdn.example.com/a.css', AUTH).headers,
            AUTH,
        );
    });

    it('drops headers when the redirect crosses origins', () => {
        assert.deepEqual(
            resolveRedirect('https://evil.example/b.css', 'https://cdn.example.com/a.css', AUTH).headers,
            {},
        );
    });

    it('treats a port or scheme change as a different origin', () => {
        assert.deepEqual(resolveRedirect('https://cdn.example.com:8443/b', 'https://cdn.example.com/a', AUTH).headers, {});
        assert.deepEqual(resolveRedirect('http://cdn.example.com/b', 'https://cdn.example.com/a', AUTH).headers, {});
    });

    it('allows http and https', () => {
        assert.doesNotThrow(() => resolveRedirect('http://example.com/x', 'https://example.com/a', {}));
        assert.doesNotThrow(() => resolveRedirect('https://example.com/x', 'http://example.com/a', {}));
    });

    it('refuses to follow a redirect to file:', () => {
        assert.throws(
            () => resolveRedirect('file:///etc/passwd', 'https://example.com/a', {}),
            /unsupported scheme: file:/,
        );
    });

    it('refuses other schemes a redirect might name', () => {
        for (const loc of ['data:text/plain,x', 'ftp://example.com/x', 'javascript:alert(1)']) {
            assert.throws(() => resolveRedirect(loc, 'https://example.com/a', {}), /unsupported scheme/);
        }
    });
});

describe('fetchRemote scheme guard', () => {
    it('rejects a non-http(s) URL up front with a clear message', async () => {
        await assert.rejects(() => fetchRemote('file:///etc/passwd'), /Unsupported URL scheme: file:/);
    });
});

// ── Private-address guard ─────────────────────────────────────────────────────
//
// A document decides which URLs get fetched, and the exporting machine can reach
// things the document's author cannot — a cloud metadata endpoint, an intranet
// host, a service on localhost. The fetched bytes end up embedded in the output,
// so this is exfiltration as well as probing. Everything above opted into
// loopback to talk to its own test server; this suite turns the guard back on.

describe('isPrivateAddress', () => {
    const blocked = [
        ['loopback',              '127.0.0.1'],
        ['loopback, not .0.1',    '127.9.9.9'],
        ['link-local / metadata', '169.254.169.254'],
        ['private 10/8',          '10.1.2.3'],
        ['private 172.16/12',     '172.20.0.1'],
        ['private 192.168/16',    '192.168.1.1'],
        ['this network',          '0.0.0.0'],
        ['IETF protocol block',   '192.0.0.8'],
        ['carrier-grade NAT',     '100.64.0.1'],
        ['benchmarking',          '198.18.0.1'],
        ['multicast',             '224.0.0.1'],
        ['reserved',              '255.255.255.255'],
        ['IPv6 loopback',         '::1'],
        ['IPv6 unspecified',      '::'],
        ['IPv6 unique-local',     'fd00::1'],
        ['IPv6 link-local',       'fe80::1'],
        ['IPv6 multicast',        'ff02::1'],
        ['IPv4-mapped loopback',  '::ffff:127.0.0.1'],
        ['IPv4-mapped private',   '::ffff:10.0.0.1'],
    ] as const;

    for (const [what, ip] of blocked) {
        it(`blocks ${what} (${ip})`, () => {
            assert.equal(isPrivateAddress(ip), true);
        });
    }

    const allowed = ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700::1111'];
    for (const ip of allowed) {
        it(`allows the public address ${ip}`, () => {
            assert.equal(isPrivateAddress(ip), false);
        });
    }

    it('says nothing about a hostname — that is the resolver\'s job', () => {
        assert.equal(isPrivateAddress('example.com'), false);
    });
});

describe('fetchRemote with the guard on', () => {
    before(() => { CONFIG.allowPrivateHosts = false; });
    after(()  => { CONFIG.allowPrivateHosts = true; });

    it('refuses a literal loopback URL before opening a socket', async () => {
        await assert.rejects(
            () => fetchRemote('http://127.0.0.1:9/whatever'),
            (err: unknown) => err instanceof BlockedHostError,
        );
    });

    it('refuses the cloud metadata endpoint', async () => {
        await assert.rejects(
            () => fetchRemote('http://169.254.169.254/latest/meta-data/'),
            (err: unknown) => err instanceof BlockedHostError && /169\.254\.169\.254/.test(err.message),
        );
    });

    it('refuses a bracketed IPv6 loopback', async () => {
        await assert.rejects(
            () => fetchRemote('http://[::1]:9/x'),
            (err: unknown) => err instanceof BlockedHostError,
        );
    });

    it('names the escape hatch in the error, so the fix is obvious', async () => {
        await assert.rejects(
            () => fetchRemote('http://10.0.0.1/x'),
            (err: unknown) => err instanceof Error && err.message.includes('EXPORT_PDF_ALLOW_PRIVATE_HOSTS'),
        );
    });

    it('lets the opt-out through', async () => {
        // Proof the switch is what stands between the two behaviours: the same
        // URL that was refused above now gets as far as a real connection.
        CONFIG.allowPrivateHosts = true;
        try {
            await assert.rejects(
                () => fetchRemote('http://127.0.0.1:9/whatever'),
                (err: unknown) => err instanceof Error && !(err instanceof BlockedHostError),
            );
        } finally {
            CONFIG.allowPrivateHosts = false;
        }
    });
});

// A redirect is followed by recursing through `fetchRemote` itself, so every hop
// gets the same two checks the first one did. It is not tested end-to-end here
// for a boring reason: reaching a test server at all means reaching loopback,
// which is the very thing the guard refuses — the two cannot both hold in one
// process. `resolveRedirect` (above) covers the hop's other rules.
