import * as fs from 'fs';
import * as dns  from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net  from 'net';
import * as path from 'path';
import sharp from 'sharp';
import { CONFIG, MIME_TYPES, RASTER_TYPES } from './config';
import type { FetchResult } from './types';

// ── Remote fetch ──────────────────────────────────────────────────────────────

/** The only two schemes this fetcher will follow. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Whether an IP address belongs to a range the fetcher refuses to reach.
 *
 * A document decides which URLs get fetched — an `<img src>`, a `<link href>`, a
 * theme font — and the machine exporting it can reach things the document's
 * author cannot: a cloud metadata endpoint at 169.254.169.254, an intranet host,
 * a service on localhost. That is the ordinary SSRF shape, and it is worse here
 * than in most tools because the fetched bytes are *embedded in the output*: a
 * PDF is a fine place to carry away an internal page, and with the VS Code
 * extension exporting on save, opening someone else's repository is enough to
 * fire the request.
 *
 * Blocked: loopback, link-local (and so the metadata endpoint), private and
 * carrier-grade-NAT space, benchmarking, multicast and reserved ranges, plus
 * their IPv6 equivalents and IPv4-mapped forms. Exported for testing.
 */
export function isPrivateAddress(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 0) return false;

    if (family === 6) {
        const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
        // An IPv4-mapped address (::ffff:10.0.0.1) reaches the same host as the
        // v4 form, so it has to be judged as the v4 address it carries.
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
        if (mapped) return isPrivateAddress(mapped[1]);
        if (v6 === '::1' || v6 === '::') return true;           // loopback, unspecified
        if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;         // fc00::/7 unique-local
        if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;         // fe80::/10 link-local
        if (/^ff[0-9a-f]{2}:/.test(v6))    return true;         // ff00::/8 multicast
        return false;
    }

    const [a, b] = ip.split('.').map(Number);
    if (a === 0)   return true;                                 // 0.0.0.0/8 "this network"
    if (a === 10)  return true;                                 // private
    if (a === 127) return true;                                 // loopback
    if (a === 169 && b === 254) return true;                    // link-local — cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 192 && b === 0)   return true;                    // 192.0.0.0/24 IETF protocol
    if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 benchmarking
    if (a >= 224)  return true;                                 // multicast + reserved
    return false;
}

/** Thrown when a URL resolves into a range {@link isPrivateAddress} refuses. */
export class BlockedHostError extends Error {
    constructor(host: string, address: string) {
        super(
            `Refusing to fetch ${host}: it resolves to ${address}, a loopback/private/link-local address. ` +
            'Set EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1 if this document is meant to pull assets off your own network.',
        );
        this.name = 'BlockedHostError';
    }
}

/**
 * The DNS lookup the request runs on, refusing a private resolution.
 *
 * Passed to `http.get` as its `lookup` rather than checked beforehand, which
 * matters: a hostname checked and then resolved again by the agent can answer
 * differently the second time (DNS rebinding). Node connects to whatever THIS
 * function hands back, so the address that is judged is the address that is
 * dialled. Exported for testing.
 *
 * Private addresses are filtered out rather than treated as poison for the whole
 * name: a host that publishes both a public and an internal record is still
 * reachable on its public one, and a name that resolves ONLY into blocked space
 * fails with a reason instead of a connect error.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
    // Always ask for every address — Node requests one or all depending on the
    // caller, and filtering needs to see the whole answer either way.
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);

        const usable = CONFIG.allowPrivateHosts
            ? addresses
            : addresses.filter(a => !isPrivateAddress(a.address));

        if (usable.length === 0)
            return callback(
                new BlockedHostError(hostname, addresses[0]?.address ?? 'no public address') as NodeJS.ErrnoException,
                '', 0,
            );

        if (options.all) return callback(null, usable as unknown as string, 0);
        return callback(null, usable[0].address, usable[0].family);
    });
};

/**
 * Rejects a URL written as a literal private IP.
 *
 * `guardedLookup` never sees these: Node skips DNS entirely when the host is
 * already an address, so `http://169.254.169.254/` would go straight out.
 */
function assertPublicHost(url: URL): void {
    if (CONFIG.allowPrivateHosts) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedHostError(url.hostname, host);
}

/**
 * Where a redirect is allowed to send us, and with what.
 *
 * Two things a redirect must not be able to do. It must not change the scheme
 * out from under the fetcher — a `Location: file:///etc/passwd` currently dies
 * inside `http.get` with "Protocol 'file:' not supported", which is the right
 * outcome reached by accident and reported as a confusing internal error rather
 * than a refusal. And it must not carry request headers to a host the caller
 * never named: `fetchRemote`'s headers argument is public API, so a future
 * caller adding an `Authorization` for one host would silently hand it to
 * whatever that host redirected to. Nothing passes headers today; this is the
 * guard that keeps it that way when something does.
 *
 * Exported for testing.
 */
export function resolveRedirect(
    location: string,
    from: string,
    headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
    const target = new URL(location, from);
    if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
        throw new Error(`Refusing to follow a redirect to an unsupported scheme: ${target.protocol}//… (from ${from})`);
    }
    const sameOrigin = target.origin === new URL(from).origin;
    return { url: target.toString(), headers: sameOrigin ? headers : {} };
}

export function fetchRemote(url: string, maxRedirects = 5, headers: Record<string, string> = {}): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
            return reject(new Error(`Unsupported URL scheme: ${parsed.protocol}//… (${url})`));
        }
        // Two checks, because they catch different things: the literal-IP case
        // never reaches DNS, and the hostname case must be judged on the address
        // actually dialled. A redirect recurses through here, so it gets both.
        try { assertPublicHost(parsed); }
        catch (err: unknown) { return reject(err instanceof Error ? err : new Error(String(err))); }

        const lib = parsed.protocol === 'https:' ? https : http;

        const req = lib.get(url, { timeout: CONFIG.fetchTimeoutMs, headers, lookup: guardedLookup }, res => {
            if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (!res.headers.location) {
                    res.resume();
                    return reject(new Error(`Redirect with no Location header (HTTP ${res.statusCode}) for ${url}`));
                }
                if (maxRedirects === 0) return reject(new Error(`Too many redirects for ${url}`));
                res.resume();
                let next: { url: string; headers: Record<string, string> };
                try {
                    next = resolveRedirect(res.headers.location, url, headers);
                } catch (err: unknown) {
                    return reject(err instanceof Error ? err : new Error(String(err)));
                }
                return resolve(fetchRemote(next.url, maxRedirects - 1, next.headers));
            }
            if (res.statusCode && res.statusCode >= 400) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            let sizeExceeded = false;
            res.on('data', (chunk: Buffer) => {
                if (sizeExceeded) return;
                totalBytes += chunk.length;
                if (totalBytes > CONFIG.maxResponseBytes) {
                    sizeExceeded = true;
                    req.destroy();
                    reject(new Error(`Response too large (limit: ${CONFIG.maxResponseBytes / 1024 / 1024} MB) for ${url}`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (sizeExceeded) return;
                resolve({
                    buffer:   Buffer.concat(chunks),
                    mimeType: res.headers['content-type']?.split(';')[0].trim() ?? 'application/octet-stream',
                });
            });
            res.on('error', reject);
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)); });
        req.on('error', reject);
    });
}

export function fetchRemoteText(url: string): Promise<string> {
    return fetchRemote(url).then(({ buffer }) => buffer.toString('utf8'));
}

// ── Raster conversion ─────────────────────────────────────────────────────────

/**
 * Converts raster formats WeasyPrint can't embed (WebP/AVIF/BMP) to JPEG, or
 * to PNG when the image has an alpha channel — JPEG has no transparency and
 * sharp would otherwise flatten it onto a black background.
 */
export async function normalizeRaster(buffer: Buffer, mimeType: string): Promise<FetchResult> {
    if (!RASTER_TYPES.has(mimeType)) return { buffer, mimeType };
    if ((await sharp(buffer).metadata()).hasAlpha) {
        const converted = await sharp(buffer).png().toBuffer();
        return { buffer: converted, mimeType: 'image/png' };
    }
    const converted = await sharp(buffer).jpeg({ quality: 100 }).toBuffer();
    return { buffer: converted, mimeType: 'image/jpeg' };
}

// ── Unified base64 fetcher ────────────────────────────────────────────────────

async function fetchRemoteBinaryAsBase64(url: string): Promise<string> {
    const { buffer, mimeType } = await fetchRemote(url);
    const converted = await normalizeRaster(buffer, mimeType);
    return `data:${converted.mimeType};base64,${converted.buffer.toString('base64')}`;
}

async function fetchLocalImageAsBase64(imagePath: string): Promise<string> {
    const mimeType = MIME_TYPES[path.extname(imagePath).toLowerCase()] ?? 'image/png';
    const converted = await normalizeRaster(fs.readFileSync(imagePath), mimeType);
    return `data:${converted.mimeType};base64,${converted.buffer.toString('base64')}`;
}

export async function fetchAsBase64(source: string): Promise<string> {
    if (source.startsWith('http://') || source.startsWith('https://'))
        return fetchRemoteBinaryAsBase64(source);
    if (fs.existsSync(source))
        return fetchLocalImageAsBase64(source);
    throw new Error(`Source not found: ${source}`);
}

/** Returns the raw buffer and MIME type without base64 conversion. */
export async function fetchAsBuffer(source: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (source.startsWith('http://') || source.startsWith('https://'))
        return fetchRemote(source);
    if (fs.existsSync(source)) {
        const mimeType = MIME_TYPES[path.extname(source).toLowerCase()] ?? 'application/octet-stream';
        return { buffer: fs.readFileSync(source), mimeType };
    }
    throw new Error(`Source not found: ${source}`);
}
