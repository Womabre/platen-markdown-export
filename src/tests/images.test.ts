import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net  from 'net';
import { inlineImages, injectLogoElements, bodyImageCap , checkLocalImages } from '../images';
import { getActiveTheme } from '../theme';
import { CONFIG } from '../config';

// These suites drive the fetcher against a loopback server, which the
// private-address guard refuses by default — see `isPrivateAddress`. Opting in
// here is the same switch a document that legitimately pulls assets off your own
// network uses (EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1). The guard's own behaviour is
// asserted in fetch.test.ts.
CONFIG.allowPrivateHosts = true;


// Minimal 1×1 transparent PNG — fast to read/write in tests.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

/** Loopback PNG server that reports every hit, so a test can assert fetch counts. */
function startCountingServer(onRequest: () => void): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const server = http.createServer((_req, res) => {
            onRequest();
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(TINY_PNG);
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as net.AddressInfo).port });
        });
    });
}

let tmpDir:       string;
let originalLogo: string;

before(() => {
    tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-images-test-'));
    originalLogo = getActiveTheme().logo;
});

after(() => {
    getActiveTheme().logo = originalLogo;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── inlineImages ──────────────────────────────────────────────────────────────

describe('inlineImages', () => {
    it('returns unchanged HTML when there are no <img> tags', async () => {
        const html = '<html><body><p>no images here</p></body></html>';
        assert.equal(await inlineImages(html, path.join(tmpDir, 'doc.html')), html);
    });

    it('skips images whose src is already a data URI', async () => {
        const dataUri = 'data:image/png;base64,abc123';
        const html    = `<img src="${dataUri}">`;
        const result  = await inlineImages(html, path.join(tmpDir, 'doc.html'));
        assert.ok(result.includes(dataUri), 'data URI should remain unchanged');
    });

    it('inlines a local image as a base64 data URI', async () => {
        const imgFile = path.join(tmpDir, 'photo.png');
        fs.writeFileSync(imgFile, TINY_PNG);
        const html   = `<html><body><img src="photo.png"></body></html>`;
        const result = await inlineImages(html, path.join(tmpDir, 'doc.html'));
        assert.ok(result.includes('data:image/png;base64,'), 'should contain inlined base64 PNG');
        assert.ok(!result.includes('src="photo.png"'), 'original file path should be replaced');
    });

    it('leaves src unchanged and does not throw when the image file is missing', async () => {
        const html   = `<img src="ghost.png">`;
        const result = await inlineImages(html, path.join(tmpDir, 'doc.html'));
        assert.ok(result.includes('src="ghost.png"'), 'missing image src should remain as-is');
    });

    it('inlines multiple images in parallel', async () => {
        const a = path.join(tmpDir, 'a.png');
        const b = path.join(tmpDir, 'b.png');
        fs.writeFileSync(a, TINY_PNG);
        fs.writeFileSync(b, TINY_PNG);
        const html = `<img src="a.png"><img src="b.png">`;
        const result = await inlineImages(html, path.join(tmpDir, 'doc.html'));
        assert.ok(!result.includes('src="a.png"'));
        assert.ok(!result.includes('src="b.png"'));
        const matches = result.match(/data:image\/png;base64,/g) ?? [];
        assert.equal(matches.length, 2);
    });

    // The motivating case is emoji: wrapEmoji() emits one remote Twemoji <img>
    // per occurrence, so a document with forty ✅ used to make forty identical
    // HTTPS requests. The counting server is the only way to assert the fetch
    // count rather than just the rendered output.
    it('fetches a repeated remote source exactly once', async () => {
        let requests = 0;
        const { server, port } = await startCountingServer(() => { requests++; });
        try {
            const url  = `http://127.0.0.1:${port}/check.png`;
            const html = Array.from({ length: 5 }, (_, i) =>
                `<p>line ${i} <img class="emoji" alt="x" src="${url}"></p>`).join('\n');

            const result = await inlineImages(html, path.join(tmpDir, 'doc.html'));

            assert.equal(requests, 1, 'five references to one URL must cost one request');
            assert.equal(result.match(/data:image\/png;base64,/g)?.length, 5,
                'every occurrence is still replaced with the data URI');
            assert.ok(!result.includes(url), 'no remote src survives');
        } finally {
            server.close();
        }
    });

    it('fetches distinct remote sources separately', async () => {
        let requests = 0;
        const { server, port } = await startCountingServer(() => { requests++; });
        try {
            const html = `<img src="http://127.0.0.1:${port}/one.png">`
                       + `<img src="http://127.0.0.1:${port}/two.png">`;
            await inlineImages(html, path.join(tmpDir, 'doc.html'));
            assert.equal(requests, 2, 'two different URLs are two fetches');
        } finally {
            server.close();
        }
    });
});

// ── injectLogoElements ────────────────────────────────────────────────────────

describe('injectLogoElements', () => {
    it('injects header and footer logo divs inside <body>', async () => {
        const logoFile = path.join(tmpDir, 'logo.svg');
        fs.writeFileSync(logoFile, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        getActiveTheme().logo = logoFile;

        const html   = '<html><body><p>content</p></body></html>';
        const result = await injectLogoElements(html);

        assert.ok(result.includes('id="logo-header"'), 'logo-header div should be present');
        assert.ok(result.includes('id="logo-footer"'), 'logo-footer div should be present');
        assert.ok(result.includes('data:'), 'logo should be inlined as a data URI');
        // Divs must appear after the opening <body> tag so WeasyPrint can render them
        assert.ok(result.indexOf('<body') < result.indexOf('logo-header'), 'logo divs follow opening <body>');
    });

    it('returns unchanged HTML and does not throw when the logo file is missing', async () => {
        getActiveTheme().logo = path.join(tmpDir, 'nonexistent-logo.png');
        const html   = '<html><body><p>text</p></body></html>';
        const result = await injectLogoElements(html);
        assert.equal(result, html);
    });
});

// ── Body-image cap ────────────────────────────────────────────────────────────

describe('bodyImageCap', () => {
    it('defaults to the A4 portrait pair the constants used to hardcode', () => {
        assert.deepEqual(bodyImageCap(), { maxWidth: 1004, maxHeight: 1299 });
    });

    it('allows a wider image on a wider page', () => {
        const a4 = bodyImageCap({ pageSize: 'A4', margins: null, orientation: 'portrait' });
        const a3 = bodyImageCap({ pageSize: 'A3', margins: null, orientation: 'portrait' });
        assert.ok(a3.maxWidth > a4.maxWidth,
            'an A3 document used to downsample its images to fit an A4 page');
    });

    it('follows the orientation, not just the paper name', () => {
        const portrait  = bodyImageCap({ pageSize: 'A4', margins: null, orientation: 'portrait' });
        const landscape = bodyImageCap({ pageSize: 'A4', margins: null, orientation: 'landscape' });
        assert.ok(landscape.maxWidth  > portrait.maxWidth);
        assert.ok(landscape.maxHeight < portrait.maxHeight);
    });

    it('follows the document\'s margins', () => {
        const wide   = bodyImageCap({ pageSize: 'A4', margins: '5mm',  orientation: 'portrait' });
        const narrow = bodyImageCap({ pageSize: 'A4', margins: '40mm', orientation: 'portrait' });
        assert.ok(wide.maxWidth > narrow.maxWidth);
    });
});

// ── Attribute quoting ─────────────────────────────────────────────────────────
//
// `html: true` is on, so a document may hand-write an <img> in any of HTML's
// three attribute spellings. Markdown always renders double quotes, which is why
// only that form was ever matched — and the other two failed silently: not
// inlined, no warning, just a missing image in a PDF that cannot reach the file.

describe('inlineImages attribute quoting', () => {
    const inline = async (html: string): Promise<string> => {
        const imgFile = path.join(tmpDir, 'quoted.png');
        fs.writeFileSync(imgFile, TINY_PNG);
        return inlineImages(html, path.join(tmpDir, 'doc.html'));
    };

    it('inlines a single-quoted src', async () => {
        const out = await inline(`<img src='quoted.png'>`);
        assert.match(out, /src="data:image\/png;base64,/);
        assert.ok(!out.includes("'quoted.png'"), 'the original reference is gone');
    });

    it('inlines an unquoted src', async () => {
        const out = await inline('<img src=quoted.png>');
        assert.match(out, /src="data:image\/png;base64,/);
    });

    it('keeps the tag\'s other attributes when it rewrites the src', async () => {
        const out = await inline(`<img class="figure" src='quoted.png' alt="a photo">`);
        assert.match(out, /class="figure"/);
        assert.match(out, /alt="a photo"/);
        assert.match(out, /src="data:image\/png;base64,/);
    });

    it('still skips a single-quoted data URI', async () => {
        const html = `<img src='data:image/png;base64,abc123'>`;
        assert.equal(await inline(html), html);
    });

    it('leaves a src it cannot resolve alone, whatever the quoting', async () => {
        const html = `<img src='nope-not-here.png'>`;
        assert.equal(await inline(html), html);
    });
});

// ── The draw.io hand-off ──────────────────────────────────────────────────────
//
// `inlineImages` must leave .drawio references alone in every spelling it now
// matches: they are rendered later, per output mode, by `renderDrawioDiagrams`.
// Before both patterns understood quoting, a single-quoted .drawio reference was
// invisible to BOTH passes — never inlined, never rendered, and the tag reached
// the PDF pointing at a file it cannot open.

describe('inlineImages leaves draw.io references to the draw.io pass', () => {
    const untouched = async (html: string): Promise<void> => {
        assert.equal(await inlineImages(html, path.join(tmpDir, 'doc.html')), html);
    };

    it('skips a double-quoted .drawio src', () => untouched('<img src="arch.drawio">'));
    it('skips a single-quoted .drawio src', () => untouched("<img src='arch.drawio'>"));
    it('skips an unquoted .drawio src', () => untouched('<img src=arch.drawio>'));
    it('skips the .xml form', () => untouched("<img src='arch.drawio.xml'>"));
    it('skips a page fragment', () => untouched("<img src='arch.drawio#page=2'>"));
});


// ── checkLocalImages ──────────────────────────────────────────────────────────

describe('checkLocalImages', () => {
    // The cheap half of inlineImages, for --dry-run: find the missing ones
    // without fetching anything, since reaching the network is precisely what a
    // dry run must not do.
    const docIn = (dir: string) => path.join(dir, 'doc.html');

    const withTmp = <T>(fn: (dir: string) => T): T => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-imgcheck-'));
        try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
    };

    it('counts a missing local image', () => withTmp(dir => {
        assert.equal(checkLocalImages('<img src="gone.png">', docIn(dir)), 1);
    }));

    it('counts nothing when the file is there', () => withTmp(dir => {
        fs.writeFileSync(path.join(dir, 'there.png'), 'x');
        assert.equal(checkLocalImages('<img src="there.png">', docIn(dir)), 0);
    }));

    it('resolves against the document, not the working directory', () => withTmp(dir => {
        fs.mkdirSync(path.join(dir, 'assets'));
        fs.writeFileSync(path.join(dir, 'assets', 'a.png'), 'x');
        assert.equal(checkLocalImages('<img src="assets/a.png">', docIn(dir)), 0);
    }));

    it('ignores remote and data sources — a dry run does not touch the network', () => withTmp(dir => {
        const html = '<img src="https://example.invalid/a.png"><img src="data:image/png;base64,AAA">';
        assert.equal(checkLocalImages(html, docIn(dir)), 0);
    }));

    it('reads all three quoting forms, like the inliner it mirrors', () => withTmp(dir => {
        assert.equal(checkLocalImages(`<img src="a.png"><img src='b.png'><img src=c.png>`, docIn(dir)), 3);
    }));

    it('handles a percent-encoded name', () => withTmp(dir => {
        fs.writeFileSync(path.join(dir, 'a b.png'), 'x');
        assert.equal(checkLocalImages('<img src="a%20b.png">', docIn(dir)), 0);
    }));
});
