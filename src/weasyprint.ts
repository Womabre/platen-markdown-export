import * as fs from 'fs';
import * as http from 'http';
import * as net  from 'net';
import * as os   from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { CONFIG, MIME_TYPES } from './config';
import { commitFileAtomic, resolveWriteTarget, tempSiblingPath } from './fsutil';
import { log } from './logger';
import { ExitError } from './errors';
import { assertPublicHostname, BlockedHostError, fetchRemote, guardedLookup } from './fetch';

// ── Local dev server ──────────────────────────────────────────────────────────

export interface LocalServer {
    server: http.Server;
    port: number;
    /**
     * Per-run capability token. Every request path must start with `/<token>/`
     * or it is refused — see {@link startServer}.
     */
    token: string;
    /** Absolute URL for a file in the served directory, token included. */
    urlFor(relativePath: string): string;
    /**
     * This server's address as an HTTP proxy, for {@link exportPdf}. Every
     * request WeasyPrint makes is sent here — see {@link startServer}.
     */
    proxyUrl: string;
}

export interface ServeOptions {
    /**
     * Documents served straight from memory, keyed by the name they answer to.
     *
     * The processed HTML is transient — WeasyPrint is the only reader, and it
     * reads it once, over loopback. Writing it to the document's own directory
     * meant every export dropped a file into the user's folder, showed up in
     * their file watcher and `git status`, and stayed behind if the process
     * died mid-run. Serving it from memory removes the file, the cleanup, and
     * the crash leftover together.
     */
    files?: Record<string, string>;
}

/**
 * Serves the document's directory over an ephemeral loopback port so WeasyPrint
 * can resolve the HTML's relative asset references (a `file://` input cannot).
 *
 * The directory is the user's own working folder, which may hold documents
 * unrelated to this export, so the port is gated on a random per-run **capability
 * token**: a request must be `/<token>/<path>` or it gets a 403 without touching
 * the filesystem. The token is a path prefix rather than a query parameter or
 * header precisely so that relative references inherit it — an asset at
 * `images/logo.png`, resolved against `/<token>/doc.html`, lands on
 * `/<token>/images/logo.png` with no rewriting anywhere in the pipeline.
 *
 * Traversal is still rejected below the token check: the token authorises this
 * directory, never an escape from it.
 *
 * **It is also WeasyPrint's only way out.** WeasyPrint is a second fetcher: any
 * URL the pipeline did not inline — an `<img>` whose fetch was refused, a
 * `url()` in a `<style>` block or a `style` attribute, an `@import` — it
 * requests itself, with none of `fetch.ts`'s rules. So the private-address guard
 * refused `http://169.254.169.254/` with a warning, left the tag as it was, and
 * WeasyPrint fetched it a second later and embedded the answer in the PDF.
 *
 * WeasyPrint has no fetch hook on its command line, but it honours the proxy
 * environment variables, and with those set it sends *every* request to the
 * proxy, loopback included (verified against WeasyPrint 70). So this server is
 * handed to it as that proxy ({@link buildWeasyprintEnv}) and answers three
 * kinds of request:
 *
 *   - one for this server itself: the document and its assets, token-gated as
 *     above;
 *   - any other `http://` URL: fetched through `fetchRemote`, so the scheme,
 *     redirect, size and private-address rules all apply;
 *   - `CONNECT` (how `https://` goes through a proxy): tunnelled, after the host
 *     has been judged — a literal address directly, a name by `guardedLookup`
 *     on the lookup the tunnel is dialled with.
 */
export function startServer(htmlFile: string, options: ServeOptions = {}): Promise<LocalServer> {
    const baseDir = path.dirname(htmlFile);
    const token   = randomBytes(16).toString('hex');
    const prefix  = `/${token}/`;
    const virtual = new Map(Object.entries(options.files ?? {}));

    return new Promise((resolve, reject) => {
        /** Serves `/<token>/<path>` from memory or the document's directory. */
        const serveLocal = (target: string, res: http.ServerResponse): void => {
            if (target === '/favicon.ico') { res.writeHead(204); res.end(); return; }

            // A request target is `path[?query][#fragment]`, and the query is not
            // part of the filename. Cache-busted asset references are ordinary in
            // hand-written HTML (`<img src="chart.png?v=2">`), and treating the
            // whole target as a path turned every one of them into a 404.
            const rawUrl = target.split(/[?#]/, 1)[0];
            if (!rawUrl.startsWith(prefix)) {
                res.writeHead(403); res.end(); return;
            }

            let decoded: string;
            try {
                decoded = decodeURIComponent(rawUrl.slice(prefix.length - 1));
            } catch {
                res.writeHead(400); res.end(); return;
            }
            const filePath = path.join(baseDir, decoded);
            const rel = path.relative(baseDir, filePath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                res.writeHead(403); res.end(); return;
            }

            // In-memory documents shadow the directory; assets still come from
            // disk, so relative references inside them resolve as normal.
            const inMemory = virtual.get(decoded.replace(/^\/+/, ''));
            if (inMemory !== undefined) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(inMemory);
                return;
            }
            fs.readFile(filePath, (err, content) => {
                if (err) {
                    if (!path.basename(filePath).startsWith('KaTeX_'))
                        log(`Server 404: ${filePath}`);
                    res.writeHead(404); res.end(); return;
                }
                const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': type });
                res.end(content);
            });
        };

        /** Why a proxied request was not served, for the log. */
        const refusal = (what: string, err: unknown): string => {
            const reason = err instanceof Error ? err.message : String(err);
            // A refusal is a WARNING (it reaches --strict); an ordinary failed
            // fetch is WeasyPrint's to report, as it always was.
            return `${err instanceof BlockedHostError ? 'WARNING: Blocked' : 'Could not serve'} ` +
                   `a request WeasyPrint made for ${what}: ${reason}`;
        };

        /** A proxied `http://` request for somewhere else, fetched under the guard. */
        const relay = (url: URL, req: http.IncomingMessage, res: http.ServerResponse): void => {
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
            fetchRemote(url.toString()).then(
                ({ buffer, mimeType }) => {
                    res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': buffer.length });
                    res.end(req.method === 'HEAD' ? undefined : buffer);
                },
                (err: unknown) => {
                    log(refusal(url.toString(), err));
                    res.writeHead(err instanceof BlockedHostError ? 403 : 502); res.end();
                },
            );
        };

        const server = http.createServer((req, res) => {
            const target = req.url ?? '/';
            // Origin-form (`/path`): a direct request. Absolute-form
            // (`http://host/path`): this server being used as a proxy.
            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) { serveLocal(target, res); return; }

            let url: URL;
            try { url = new URL(target); }
            catch { res.writeHead(400); res.end(); return; }
            if (url.protocol !== 'http:') { res.writeHead(403); res.end(); return; }

            // Only this exact origin is "us". `localhost:<port>` and every other
            // spelling of loopback go through the guard like any other host.
            const address = server.address();
            const ownPort = address && typeof address === 'object' ? address.port : -1;
            if (url.hostname === '127.0.0.1' && Number(url.port) === ownPort) {
                serveLocal(url.pathname + url.search, res);
                return;
            }
            relay(url, req, res);
        });

        // `https://` through a proxy is a CONNECT to `host:port`, then TLS the
        // proxy cannot see into. What it can do — and all the guard needs — is
        // choose whether to dial, and which address.
        server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
            const refuse = (status: string, err: unknown): void => {
                log(refusal(`https://${req.url ?? ''}`, err));
                client.end(`HTTP/1.1 ${status}\r\n\r\n`);
            };

            let host: string, port: number;
            try {
                const parsed = new URL(`http://${req.url ?? ''}`);
                host = parsed.hostname.replace(/^\[|\]$/g, '');
                port = Number(parsed.port) || 443;
                assertPublicHostname(host);
            } catch (err: unknown) { refuse('403 Forbidden', err); return; }

            let established = false;
            const upstream = net.connect({ host, port, lookup: guardedLookup, timeout: CONFIG.fetchTimeoutMs });
            upstream.once('connect', () => {
                established = true;
                upstream.setTimeout(0);
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                upstream.pipe(client);
                client.pipe(upstream);
            });
            upstream.once('timeout', () => upstream.destroy(new Error(`Connection timed out: ${host}:${port}`)));
            upstream.on('error', (err: Error) => {
                if (established) client.destroy();
                else refuse(err instanceof BlockedHostError ? '403 Forbidden' : '502 Bad Gateway', err);
            });
            client.on('error', () => upstream.destroy());
            client.on('close', () => upstream.destroy());
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            log(`Local server started on port ${port}`);
            resolve({
                server,
                port,
                token,
                urlFor: (relativePath: string) =>
                    `http://127.0.0.1:${port}${prefix}${encodeURIComponent(relativePath)}`,
                proxyUrl: `http://127.0.0.1:${port}`,
            });
        });

        server.on('error', reject);
    });
}

// ── PDF export ────────────────────────────────────────────────────────────────

// Suppressed WeasyPrint WARNING: lines (CSS/font issues that don't affect output).
const IGNORED_WEASYPRINT_WARNINGS: RegExp[] = [
    /invalid value/i,
    /descriptor not supported/i,
    /unknown property/i,
    /-webkit-|-moz-/,
    /Font-face '(?:Futura|futura-pt|futura-pt-condensed|futura-pt-bold|Urbanist)'/,
    // CSS features unsupported by WeasyPrint but harmless (from Font Awesome / icon fonts):
    /Unknown rule.*@keyframes/,
    /Expected a media type, got '\(prefers-reduced-motion/,
    /Invalid media type.*prefers-reduced-motion/,
    /Expected a media type, got '\(prefers-color-scheme/,
    /Invalid media type.*prefers-color-scheme/,
    /Invalid or unsupported selector.*:host.*:root/,
    // Form-control pseudo-elements / RTL selectors (e.g. from github-markdown-css)
    // that markdown output never contains:
    /Invalid or unsupported selector.*::placeholder/,
    /Invalid or unsupported selector.*:dir\(/,
    // Icon font CSS parse quirks — ligature/feature-settings rules WeasyPrint can't parse:
    /Stop token reached before \{\} block for a qualified rule/,
    /EOF reached before \{\} block for a qualified rule/,
];

// Suppressed non-WARNING stderr lines (GLib/Pango/Fontconfig messages that don't affect output).
const IGNORED_STDERR_LINES: RegExp[] = [
    // Pango emoji font fallback — fires when a document contains emoji and
    // Pango queries the "emoji" generic family, which resolves to Apple Color
    // Emoji (SBIX format, unloadable by Homebrew FreeType — see mermaid.ts):
    /Pango-WARNING.*couldn't load font.*emoji/i,
    /Pango-WARNING.*modified variant\/weight\/stretch as fallback/i,
    /Pango-ERROR.*Could not load fallback font/i,
    // Fontconfig ambiguous keyword warnings — harmless, caused by system font config:
    /Fontconfig error:.*ambiguous constant name/i,
    /Fontconfig warning:.*invalid constant used/i,
];

/**
 * The one line worth showing when WeasyPrint dies.
 *
 * WeasyPrint is Python, so a failure arrives as a traceback — around sixty
 * lines of interpreter frames ending in the actual reason. Node's `execFile`
 * then puts that whole thing into `error.message`, which used to be pasted
 * straight into the thrown error, so the last thing a user saw was a wall of
 * `File "/opt/homebrew/Cellar/python@3.14/..."` with the one useful sentence
 * buried in the middle of it.
 *
 * A Python traceback ends with `ExceptionType: message` at column zero, after
 * a run of indented frame lines, so the last unindented line is the reason —
 * and with chained exceptions ("During handling of the above exception…") the
 * last one is the one that actually stopped the run. The full traceback is
 * still logged; this only decides what the *error* says.
 *
 * Falls back to the first line of `fallback` (execFile's own "Command failed:"),
 * for a failure that produced no usable stderr at all.
 */
export function explainWeasyprintFailure(stderr: string, fallback: string): string {
    const candidates = stderr
        .split('\n')
        .map(l => l.trimEnd())
        .filter(l =>
            l.trim() !== '' &&
            !/^\s/.test(l) &&                                  // frame lines are indented
            !/^Traceback \(/.test(l) &&
            !/^(?:During handling|The above exception)/.test(l));

    return candidates.at(-1) ?? fallback.split('\n')[0].trim();
}

export interface StderrCategories {
    errors: string;
    warnings: string;
    suppressedCount: number;
}

/**
 * Splits WeasyPrint stderr into errors, visible warnings, and suppressed-warning count.
 * Exported for testing; used internally by exportPdf.
 */
export function categorizeStderr(stderr: string): StderrCategories {
    const lines = stderr.split('\n').filter(l => l.trim());

    const isIgnoredError   = (l: string) => IGNORED_STDERR_LINES.some(p => p.test(l));
    const isIgnoredWarning = (l: string) => IGNORED_WEASYPRINT_WARNINGS.some(p => p.test(l));

    const errors = lines
        .filter(l => !l.startsWith('WARNING:') && !isIgnoredError(l))
        .join('\n');

    const warnings = lines
        .filter(l => l.startsWith('WARNING:') && !isIgnoredWarning(l))
        .join('\n');

    const suppressedCount =
        lines.length -
        errors.split('\n').filter(Boolean).length -
        warnings.split('\n').filter(Boolean).length;

    return { errors, warnings, suppressedCount };
}

/**
 * Renders `url` to `pdfFile` with WeasyPrint.
 *
 * WeasyPrint writes to a sibling temp file that is renamed into place only once
 * it has exited cleanly, so a failed run leaves any previous export untouched.
 *
 * That indirection is the whole point. This used to hand WeasyPrint the real
 * output path and, on failure, unlink it "to clean up a half-written PDF". But
 * WeasyPrint does not touch the output when it fails — it dies while fetching or
 * laying out, before it opens the file — so there was never a half-written PDF
 * to clean up. The unlink deleted the PREVIOUS, perfectly good export instead.
 * With the VS Code extension exporting on every save, one transient failure (a
 * typo in the frontmatter, a momentarily missing image) was enough to destroy
 * the last good PDF, and the next successful save was the only way to get one
 * back. Same reasoning as `writeFileAtomic`, which already guards the source
 * document; the output deserved it too.
 */
/**
 * Whether this WeasyPrint binary can rasterize a colour-emoji glyph (e.g.
 * Apple Color Emoji's SBIX format on macOS) without dying.
 *
 * Historically this always failed on macOS: Homebrew's FreeType build could
 * not load the SBIX colour table, and WeasyPrint died with "Could not load
 * fallback font, bailing out" — which is why `stripSvgEmoji` exists and every
 * diagram strips emoji before it ever reaches WeasyPrint (see mermaid.ts).
 * Whether a given install still hits that is a property of the *FreeType
 * build behind this exact binary*, not of the WeasyPrint version number — two
 * machines on the same WeasyPrint release can disagree. So this probes the
 * real binary rather than gating on a version, and is the only way to answer
 * the question correctly for the machine actually running the export.
 *
 * Cached per `weasyprintPath` for the life of the process: launching
 * WeasyPrint costs real time, and every diagram in an export (and, under
 * `--watch`, every re-export) shares the same binary.
 */
const _colorEmojiSupport = new Map<string, Promise<boolean>>();

export function colorEmojiRenderingSupported(weasyprintPath: string): Promise<boolean> {
    let cached = _colorEmojiSupport.get(weasyprintPath);
    if (!cached) {
        cached = probeColorEmojiRendering(weasyprintPath);
        _colorEmojiSupport.set(weasyprintPath, cached);
    }
    return cached;
}

/** Exported for testing: the probe logic without the process-lifetime cache. */
export async function probeColorEmojiRendering(weasyprintPath: string): Promise<boolean> {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-emoji-probe-'));
    try {
        const htmlFile = path.join(probeDir, 'probe.html');
        const pdfFile  = path.join(probeDir, 'probe.pdf');
        // A bare SVG <text>, the same shape a rendered diagram embeds — no
        // network, no fonts to fetch, nothing else that could fail and be
        // mistaken for a colour-font problem.
        fs.writeFileSync(
            htmlFile,
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
            '<body><svg width="20" height="20"><text x="0" y="15" font-size="14">🚀</text></svg></body></html>',
            'utf8',
        );
        await new Promise<void>((resolve, reject) => {
            execFile(weasyprintPath, [htmlFile, pdfFile], { timeout: 10_000 }, (error) => {
                if (error) reject(error); else resolve();
            });
        });
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
    }
}

/**
 * Builds the WeasyPrint argv, exported so the mapping from options to flags is
 * testable without a child process. `--pdf-variant` is omitted entirely when
 * null (an ordinary PDF) rather than passed as some "none" sentinel WeasyPrint
 * would have to also understand.
 */
export function buildWeasyprintArgs(
    url: string,
    tmpPdf: string,
    dpi: number,
    pdfVariant: string | null,
): string[] {
    const args = ['--optimize-images', '--dpi', String(dpi)];
    if (pdfVariant) args.push('--pdf-variant', pdfVariant);
    args.push(url, tmpPdf);
    return args;
}

/**
 * The environment WeasyPrint runs in: the caller's, with the proxy variables
 * replaced by `proxyUrl` so that every request it makes goes through
 * {@link startServer}'s guard.
 *
 * Every spelling is removed first, not just overwritten. The variables are
 * case-sensitive on POSIX and both cases are read, and a surviving `NO_PROXY`
 * would name hosts WeasyPrint may reach *without* the proxy — which is the
 * hole this closes. A machine-level proxy is dropped on purpose as well: the
 * pipeline's own fetcher never used one, so this is not a route that worked.
 *
 * With no `proxyUrl` the environment is returned as it was. Exported for testing.
 */
export function buildWeasyprintEnv(base: NodeJS.ProcessEnv, proxyUrl: string | null): NodeJS.ProcessEnv {
    if (!proxyUrl) return base;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(base)) {
        if (!/^(?:https?|all|ftp|no)_proxy$/i.test(key)) env[key] = value;
    }
    env.http_proxy  = proxyUrl;
    env.https_proxy = proxyUrl;
    return env;
}

export function exportPdf(
    weasyprintPath: string,
    url: string,
    pdfFile: string,
    dpi: number = CONFIG.weasyprintDpi,
    pdfVariant: string | null = CONFIG.pdfVariant,
    proxyUrl: string | null = null,
): Promise<void> {
    log('Launching WeasyPrint...');

    // The temp name keeps the shared `.tmp` suffix rather than `.pdf`: WeasyPrint
    // has emitted PDF and nothing else since it dropped PNG output in v53, so it
    // never infers a format from the output filename (there is no `--format`
    // flag to override either). Verified against the binary, not assumed.
    //
    // An output path that is a symlink is written through, like the source
    // document is — see `resolveWriteTarget`.
    pdfFile = resolveWriteTarget(pdfFile);
    const tmpPdf = tempSiblingPath(pdfFile);
    const discardTemp = (): void => {
        try { fs.rmSync(tmpPdf, { force: true }); } catch { /* best-effort */ }
    };

    return new Promise((resolve, reject) => {
        execFile(
            weasyprintPath,
            buildWeasyprintArgs(url, tmpPdf, dpi, pdfVariant),
            { maxBuffer: 50 * 1024 * 1024, env: buildWeasyprintEnv(process.env, proxyUrl) },
            (error, stdout, stderr) => {
                if (stdout) log(`stdout: ${stdout}`);

                if (stderr) {
                    const { errors, warnings, suppressedCount } = categorizeStderr(stderr);
                    if (errors)          log(`stderr: ${errors}`);
                    if (warnings)        log(`stderr (warnings): ${warnings}`);
                    if (suppressedCount > 0) log(`stderr: ${suppressedCount} known-harmless warnings suppressed`);
                }

                if (error) {
                    discardTemp();
                    // The traceback above is the diagnosis; this is the reason.
                    return reject(new ExitError(
                        `WeasyPrint failed: ${explainWeasyprintFailure(stderr, error.message)}`, 4));
                }

                // A clean exit that produced nothing is still a failure, and must
                // not rename a missing file over a good one.
                if (!fs.existsSync(tmpPdf)) {
                    return reject(new ExitError('WeasyPrint exited successfully but produced no PDF', 4));
                }

                try {
                    commitFileAtomic(tmpPdf, pdfFile);
                } catch (err: unknown) {
                    discardTemp();
                    return reject(new ExitError(
                        `Could not write ${pdfFile}: ${err instanceof Error ? err.message : String(err)}`, 4));
                }
                resolve();
            },
        );
    });
}
