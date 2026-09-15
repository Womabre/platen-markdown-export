import * as fs   from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { fetchAsBase64, fetchAsBuffer, normalizeRaster } from './fetch';
import { mapPool } from './concurrency';
import { CONFIG } from './config';
import { getActiveTheme, resolveLogoPath } from './theme';
import { contentBoxMm } from './css';
import { readCache, writeCache } from './cache';
import { TWEMOJI_BASE } from './html';
import { log } from './logger';
import { attrOf, setAttr, tagPattern } from './attributes';
import type { Override, PageOrientation } from './types';

// ── Image size cap ────────────────────────────────────────────────────────────
//
// Inline body images are capped at the page's own content area, rendered at 150
// DPI — enough for crisp print quality without embedding full 12–24 MP photos in
// the PDF.
//
// The area comes from the document's `Page Size`, `Margins` and `Orientation`
// rather than from two constants. Those constants were A4 portrait at the
// default 2 cm margin, applied to every document: on A3, in landscape, or with
// narrow margins, an image was resized to fit a page smaller than the one it
// was going on and printed soft, with nothing in the log to say so.
const BODY_IMG_DPI = 150;
const MM_TO_PX     = BODY_IMG_DPI / 25.4;

/** The page geometry keys that decide how much room a body image has. */
export interface PageGeometry {
    pageSize: string | null;
    margins: string | null;
    orientation: PageOrientation;
}

interface ImageCapPx { maxWidth: number; maxHeight: number }

/**
 * The body-image cap in pixels for a document's page.
 *
 * With no geometry — an HTML input, or a caller that has none — this is A4
 * portrait at 2 cm: 1004 × 1299 px, exactly the previous hardcoded pair.
 */
export function bodyImageCap(geometry?: PageGeometry): ImageCapPx {
    const box = contentBoxMm(
        geometry?.pageSize ?? null,
        geometry?.margins ?? null,
        geometry?.orientation ?? 'portrait',
    );
    return {
        maxWidth:  Math.round(box.widthMm  * MM_TO_PX),
        maxHeight: Math.round(box.heightMm * MM_TO_PX),
    };
}

/**
 * Fetches a body image once and converts it to a data URL: oversized rasters
 * are resized down to the body cap, formats WeasyPrint can't embed
 * (WebP/AVIF/BMP) are converted, everything else is inlined as-is.
 */
async function bodyImageToDataUrl(resolvedSrc: string, cap: ImageCapPx): Promise<string> {
    const { buffer, mimeType } = await fetchAsBuffer(resolvedSrc);

    try {
        const meta = await sharp(buffer).metadata();

        // Vectors scale losslessly — rasterizing them here would only hurt.
        if (meta.format !== 'svg' && mimeType !== 'image/svg+xml') {
            const w = meta.width  ?? 0;
            const h = meta.height ?? 0;

            // Only resize if the image exceeds the cap in either dimension
            if (w > cap.maxWidth || h > cap.maxHeight) {
                log(`  Resizing oversized image ${w}×${h}px → fits ${cap.maxWidth}×${cap.maxHeight}px`);

                // PNG for alpha-bearing images (JPEG would flatten transparency to black).
                const pipeline = sharp(buffer)
                    .resize(cap.maxWidth, cap.maxHeight, { fit: 'inside', withoutEnlargement: true });
                const resized = meta.hasAlpha
                    ? await pipeline.png().toBuffer()
                    : await pipeline.jpeg({ quality: CONFIG.imageJpegQuality }).toBuffer();

                return `data:image/${meta.hasAlpha ? 'png' : 'jpeg'};base64,${resized.toString('base64')}`;
            }
        }
    } catch { /* fall through to normal inlining of the already-fetched buffer */ }

    const converted = await normalizeRaster(buffer, mimeType);
    return `data:${converted.mimeType};base64,${converted.buffer.toString('base64')}`;
}

/**
 * Whether a fetched asset can be cached on disk forever.
 *
 * Only the emoji, and only because they are pinned to a Twemoji release: the URL
 * carries the version, so the bytes behind it never change and a bump changes
 * the key. Nothing else qualifies — a document's own remote image, or a logo
 * behind a URL the user controls, is expected to change under us, and serving a
 * stale one from a cache would be a bug you could not clear.
 *
 * Emoji are the case worth caching: `wrapEmoji` emits an <img> per occurrence,
 * so a document with three of them fetched three files from a CDN on every
 * export — and with the extension exporting on save, that was every ⌘S. Cached,
 * the same document exports on a train.
 */
function isImmutableRemoteAsset(src: string): boolean {
    return src.startsWith(TWEMOJI_BASE);
}

const EMOJI_CACHE_NS = 'emoji';

/** `bodyImageToDataUrl` with the disk cache in front, for assets that can take one. */
async function cachedDataUrl(resolvedSrc: string, cap: ImageCapPx): Promise<string> {
    if (!isImmutableRemoteAsset(resolvedSrc)) return bodyImageToDataUrl(resolvedSrc, cap);

    const hit = readCache(EMOJI_CACHE_NS, resolvedSrc);
    if (hit) return hit;

    const dataUrl = await bodyImageToDataUrl(resolvedSrc, cap);
    writeCache(EMOJI_CACHE_NS, resolvedSrc, dataUrl);
    return dataUrl;
}

// ── Image inlining ────────────────────────────────────────────────────────────

/**
 * The `<img>` tags this module rewrites.
 *
 * Matches the element and then asks {@link attrOf} for its `src`, rather than
 * walking the tag looking for `src` on the way past. Both halves of that used to
 * be wrong here. The pattern knew only the double-quoted spelling markdown
 * emits, so a hand-written `<img src='logo.png'>` was never inlined; and neither
 * it nor the rewrite pattern required whitespace before `src`, so `data-src`
 * matched as though it were `src` — a `<img data-src="lazy.png">` was reported as
 * a missing image (exit 6 under `--strict`), and on a tag carrying both, the data
 * URI was written into `data-src` while the real `src` kept pointing at a local
 * file the exported HTML could no longer reach. Both rules now live in
 * `attributes.ts` and are shared with drawio.ts and stylesheets.ts.
 */
const IMG_TAG_RE = tagPattern('img');

/**
 * Warns for every local `<img>` whose file is not there, without fetching anything.
 *
 * The cheap half of `inlineImages`, for `--dry-run`. A dry run used to stop
 * before the document was rendered at all, so the two problems people actually
 * hit — an `[!include]` that does not resolve and an image that is not there —
 * were exactly the two it could not see. Paired with `--strict` it now refuses
 * them without rendering a diagram or writing a byte.
 *
 * Remote sources are skipped deliberately: reaching the network is the thing a
 * dry run is not supposed to do.
 *
 * @returns how many were missing.
 */
export function checkLocalImages(htmlContent: string, htmlFile: string): number {
    const baseDir = path.dirname(htmlFile);
    let missing = 0;

    for (const [tag] of htmlContent.matchAll(IMG_TAG_RE)) {
        const src = attrOf(tag, 'src') ?? '';
        if (!src || src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) continue;
        if (src.includes('${') || src.includes("'+")) continue;

        let resolved: string;
        try { resolved = path.resolve(baseDir, decodeURIComponent(src)); }
        catch { resolved = path.resolve(baseDir, src); }

        if (!fs.existsSync(resolved)) {
            log(`WARNING: Image not found: ${resolved}`);
            missing++;
        }
    }
    return missing;
}

export async function inlineImages(
    htmlContent: string,
    htmlFile: string,
    geometry?: PageGeometry,
    deps?: Set<string>,
): Promise<string> {
    const baseDir = path.dirname(htmlFile);
    const cap     = bodyImageCap(geometry);
    const matches = [...htmlContent.matchAll(IMG_TAG_RE)];

    // One fetch/decode per unique source, not per occurrence.
    //
    // The same image is routinely referenced many times in one document — a logo
    // repeated per section, and above all emoji, which `wrapEmoji` turns into a
    // remote Twemoji <img> for EVERY occurrence. Without this, forty ✅ meant
    // forty HTTPS round-trips for the same file (and forty full-resolution
    // decodes for a repeated photo). Promises are cached, not results, so tasks
    // that start while a fetch is still in flight join it instead of racing it.
    const inFlight = new Map<string, Promise<string>>();
    const dataUrlFor = (resolvedSrc: string): Promise<string> => {
        let pending = inFlight.get(resolvedSrc);
        if (!pending) {
            log(`Inlining image: ${resolvedSrc}`);
            pending = cachedDataUrl(resolvedSrc, cap);
            inFlight.set(resolvedSrc, pending);
        }
        return pending;
    };

    // Bounded: every task holds a full-resolution decode in memory while sharp
    // works on it, so a photo-heavy document must not start them all at once.
    const replacements = await mapPool(matches, CONFIG.concurrency, async match => {
            const tag = match[0];
            // Whichever of the three quoting forms the tag used, and never the
            // value of a `data-src`/`data-foo-src` that merely ends in "src".
            const src = attrOf(tag, 'src') ?? '';
            if (!src || src.startsWith('data:') || src.includes('${') || src.includes("'+"))
                return null;
            // draw.io sources are rendered separately, per output mode (PNG for
            // PDF, dual SVG for HTML), after this shared image-inlining step.
            if (/\.drawio(?:\.xml)?(?:#page=\d+)?$/i.test(src))
                return null;

            try {
                const remote = src.startsWith('http://') || src.startsWith('https://');
                const resolvedSrc = remote ? src : path.resolve(baseDir, decodeURIComponent(src));
                // A local image is a file this export depends on; a remote one is
                // not something a file watcher can do anything about.
                if (!remote) deps?.add(resolvedSrc);

                const dataUrl = await dataUrlFor(resolvedSrc);

                // Rewritten through `setAttr` rather than by rebuilding the
                // literal `src="…"` text: the tag may have used single quotes or
                // none, and the replacement is normalised to double quotes.
                return {
                    original: tag,
                    source: resolvedSrc,
                    replacement: setAttr(tag, 'src', dataUrl),
                };
            } catch (err: unknown) {
                log(`WARNING: Failed to inline image ${src}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
    });

    // One pass over the document, not one per match.
    //
    // This was a `replaceAll` per replacement — each one a full scan building a
    // whole new string, so a document with 40 emoji and 100 photos did 140
    // scans of a document those same data URIs had just made enormous. Emoji
    // make it worse than it sounds: `wrapEmoji` emits an <img> for EVERY
    // occurrence, so the tags are mostly duplicates and most of those scans
    // found nothing left to do. Looking each tag up in a map while walking the
    // document once is the same result in one scan.
    const byTag = new Map<string, string>();
    for (const r of replacements) {
        if (r) byTag.set(r.original, r.replacement);
    }
    htmlContent = htmlContent.replace(IMG_TAG_RE, tag => byTag.get(tag) ?? tag);

    // Replaces the old per-occurrence "Inlined: <src>" line, which now says
    // nothing useful — the interesting number is how many tags one fetch served.
    // Counted over the tags that actually succeeded, so a source that failed
    // (already reported above as a WARNING) can't inflate the source count past
    // the tag count and read like an arithmetic error.
    const done = replacements.filter(r => r !== null);
    if (done.length)
        log(`Inlined ${done.length} image tag(s) from ${new Set(done.map(r => r.source)).size} unique source(s)`);

    return htmlContent;
}

// ── Logo injection ────────────────────────────────────────────────────────────

export async function injectLogoElements(
    htmlContent: string,
    footerLogo: Override = null,
    deps?: Set<string>,
): Promise<string> {
    // These are files the export reads, so --watch should re-run when one
    // changes — a theme's own mark included, since a theme under development is
    // exactly when you are editing it.
    const note = (src: string): void => {
        if (deps && src && !/^https?:\/\//.test(src)) deps.add(path.resolve(src));
    };
    try {
        log('Fetching logo for page margins...');
        const theme = getActiveTheme();
        note(theme.logo);
        const logoBase64 = await fetchAsBase64(theme.logo);
        const alt = theme.name.replace(/"/g, '&quot;');

        // The bottom-centre mark is overridable on its own: `Footer Logo: false`
        // drops it, a name or path swaps it. The top-left header mark keeps
        // following the theme (and the document-wide `Logo` key).
        let footerImg = `<img src="${logoBase64}" alt="${alt}">`;
        if (footerLogo === false) {
            footerImg = '';
            log('Footer logo removed (Footer Logo: false)');
        } else if (footerLogo) {
            const source = resolveLogoPath(footerLogo);
            note(source);
            footerImg = `<img src="${await fetchAsBase64(source)}" alt="${alt}">`;
            log(`Footer logo overridden: ${footerLogo}`);
        }

        const elements =
            `<div id="logo-header"><img src="${logoBase64}" alt="${alt}"></div>` +
            `\n<div id="logo-footer">${footerImg}</div>`;
        htmlContent = htmlContent.replace(/(<body[^>]*>)/, body => `${body}\n${elements}`);
        log('Logo elements injected');
    } catch (err: unknown) {
        log(`WARNING: Failed to inject logo elements: ${err instanceof Error ? err.message : String(err)}`);
    }
    return htmlContent;
}
