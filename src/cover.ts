import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { getActiveTheme, resolveStyle, resolveLogoPath, resolveColorValue } from './theme';
import { fetchRemote, fetchAsBase64 } from './fetch';
import { escHtml } from './frontmatter';
import { loadCssTemplate } from './css';
import { loadHtmlTemplate } from './html';
import { log } from './logger';
import { ExitError } from './errors';
import type {
    FrontmatterData,
    CoverPage,
    DocumentInfoEntry,
    RevisionEntry,
    StyleFrontmatter,
    CoverLogoSpec,
    Override,
} from './types';

// resolveStyleMainColor / buildStyleOverrideCss live in theme.ts; re-export so
// existing importers (index.ts) keep a single import site for cover/style helpers.
export { resolveStyleMainColor, buildStyleOverrideCss } from './theme';

// ── Document colour validation ────────────────────────────────────────────────

/** Every frontmatter key whose value is a colour, and the label to report it by. */
function documentColorKeys(
    fm: Pick<FrontmatterData, 'coverTitleColor' | 'coverLogo'>,
): Array<[string, string]> {
    return ([
        ['Cover Title Color',    fm.coverTitleColor],
        ['Cover Logo Background', fm.coverLogo?.background],
    ] as Array<[string, string | null | undefined]>)
        .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

/**
 * Checks every colour key against the one grammar they share, up front.
 *
 * Two things were wrong before this existed. `Cover Logo`'s `Background` was
 * the only colour key that never went through `resolveColorValue`: it was
 * trimmed of a trailing semicolon and dropped straight into a `style` attribute,
 * so it accepted no palette names, injected whatever it was given as CSS
 * declarations, and answered a typo by rendering nothing rather than saying so.
 *
 * And `Cover Title Color`, which *did* validate, validated from inside
 * `buildCoverPage` — an async function whose rejection is only observed once the
 * cover is awaited, which is after the markdown render, Mermaid, draw.io and
 * image inlining. A one-character typo cost a full export before it was
 * reported. This runs with the theme active but before any of that, so a bad
 * colour fails like a bad `--output` path does: immediately, exit 2.
 */
export function validateDocumentColors(
    fm: Pick<FrontmatterData, 'coverTitleColor' | 'coverLogo'>,
): void {
    for (const [label, value] of documentColorKeys(fm)) {
        try {
            resolveColorValue(value);
        } catch (err: unknown) {
            // resolveColorValue names the grammar; only the key is missing.
            throw new ExitError(`${label}: ${err instanceof Error ? err.message : String(err)}`, 2);
        }
    }
}

// ── Cover background image fetch ──────────────────────────────────────────────

/**
 * Reads a cover or banner source, wherever it lives.
 *
 * One function because the cover and the banner had a byte-identical copy each,
 * differing only in the word they logged — which is how two of them ended up
 * resolving paths and reporting sizes the same way by coincidence rather than by
 * construction.
 */
async function loadImageBuffer(source: string, what: string): Promise<Buffer> {
    const buffer = (source.startsWith('http://') || source.startsWith('https://'))
        ? (await fetchRemote(source)).buffer
        : fs.readFileSync(path.isAbsolute(source) ? source : path.resolve(source));
    log(`  ${what} input:  ${(buffer.length / 1024).toFixed(0)} KB`);
    return buffer;
}

// Cap on the cover photo's long edge (px): large enough for print, small enough
// that an oversized source doesn't bloat the output.
const COVER_MAX_PX = 2400;

/**
 * Fetches the cover photo and returns it as a single resized (never cropped)
 * data URL. Every cover layout frames the same image with CSS — full-bleed
 * themes layer their shapes over `background-size: cover`, box layouts paint it
 * in a positioned element with `cover` (panels/medallions) or `contain` (framed
 * photos) — so one image serves them all. The horizontal focal point is applied
 * at render time via the `--cover-photo-pos-x` custom property, not by cropping.
 */
async function fetchCoverImage(source: string): Promise<string> {
    const buffer = await loadImageBuffer(source, 'Cover image');
    const image = sharp(buffer);
    const { width, height } = await image.metadata();
    if (!width || !height) throw new Error('Could not read image dimensions');

    const scale   = Math.min(1, COVER_MAX_PX / Math.max(width, height));
    const { data } = await image
        .resize(Math.round(width * scale), Math.round(height * scale), { fit: 'fill' })
        .flatten({ background: '#ffffff' }) // JPEG has no alpha; default flatten is black
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
    log(`  Cover image output: ${(data.length / 1024).toFixed(0)} KB`);
    return `data:image/jpeg;base64,${data.toString('base64')}`;
}

// ── Banner background image fetch + crop ──────────────────────────────────────

const BANNER_W = 1920;
const BANNER_H =  600;

/**
 * Resizes and center-crops a source image to banner dimensions (1920×600 px).
 * Unlike the PDF cover photo, the crop is always horizontally and vertically
 * centred — the PDF-cover position parameter is intentionally not used here
 * because the banner is landscape and CSS background-position handles fine
 * positioning within the browser.
 */
async function fetchBannerImageAsBase64(source: string): Promise<string> {
    const buffer = await loadImageBuffer(source, 'Banner image');
    const image = sharp(buffer);
    const { width, height } = await image.metadata();
    if (!width || !height) throw new Error('Could not read banner image dimensions');

    const scale   = Math.max(BANNER_W / width, BANNER_H / height);
    const scaledW = Math.round(width  * scale);
    const scaledH = Math.round(height * scale);
    const left    = Math.round((scaledW - BANNER_W) / 2);
    const top     = Math.round((scaledH - BANNER_H) / 2);

    const { data } = await image
        .resize(scaledW, scaledH, { fit: 'fill' })
        .extract({ left, top, width: BANNER_W, height: BANNER_H })
        .flatten({ background: '#ffffff' }) // JPEG has no alpha; default flatten is black
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });

    log(`  Banner image output: ${(data.length / 1024).toFixed(0)} KB`);
    return `data:image/jpeg;base64,${data.toString('base64')}`;
}

// ── Cover page HTML builder ───────────────────────────────────────────────────

/**
 * Resolves a user-supplied asset path relative to the document's base directory.
 * URLs and already-absolute paths are returned unchanged.
 * Built-in named-style assets (string `style`) are already resolved to absolute
 * paths by the theme loader.
 */
/**
 * Records a local file this export read, for `--watch`.
 *
 * The cover was the one part of the pipeline that read files and told nobody:
 * a hero photo, a cover logo, a footer mark. `--watch` therefore re-exported
 * when you edited a body image but not when you edited the cover photo, which
 * is the image people iterate on most. Remote sources are skipped — a file
 * watcher can do nothing with a URL.
 */
function noteDependency(source: string, deps?: Set<string>): void {
    if (!deps || !source) return;
    if (source.startsWith('http://') || source.startsWith('https://')) return;
    deps.add(path.resolve(source));
}

function resolveDocumentAsset(p: string, baseDir: string): string {
    if (!p || p.startsWith('http://') || p.startsWith('https://') || path.isAbsolute(p))
        return p;
    // Try document-directory-relative first (e.g. ./assets/img.png next to the .md file),
    // then fall back to CWD-relative (project-root-relative paths like Covers/Logo.png).
    const docRelative = path.resolve(baseDir, p);
    if (fs.existsSync(docRelative)) return docRelative;
    const cwdRelative = path.resolve(process.cwd(), p);
    if (fs.existsSync(cwdRelative)) return cwdRelative;
    return docRelative; // return doc-relative so the error message points at the right place
}

/**
 * Splits a document title into a primary line and a subtitle on the first
 * spaced em/en-dash (`A — B`) or colon (`A: B`). Used by cover layouts that
 * render a two-tier headline. Returns the whole title as `main` (empty
 * `subtitle`) when no separator is present.
 */
function splitTitle(title: string): { main: string; subtitle: string } {
    const m = title.match(/^(.*\S)\s+[—–]\s+(\S.*)$/) ?? title.match(/^(.*\S):\s+(\S.*)$/);
    if (m) return { main: m[1].trim(), subtitle: m[2].trim() };
    return { main: title, subtitle: '' };
}

export async function buildCoverPage({ title, documentInfo = [], revisions, revisionsVisible = 0, coverLogo, style, baseDir = '',
                                       coverSlogan = null, coverAddress = null, coverFooterLogo = null,
                                       coverTitleColor = null, deps }: {
    title: string;
    documentInfo?: DocumentInfoEntry[];
    revisions?: RevisionEntry[] | null;
    revisionsVisible?: number;
    coverLogo?: CoverLogoSpec | null;
    style: string | StyleFrontmatter | null;
    baseDir?: string;
    /** Recolour the cover title, its rule, and the subtitle. */
    coverTitleColor?: string | null;
    /** Replace the theme slogan, or `false` to drop the line. */
    coverSlogan?: Override;
    /** Replace the theme address, or `false` to drop the block. */
    coverAddress?: Override;
    /** Replace the bottom-right brand mark, or `false` to drop it. */
    coverFooterLogo?: Override;
    /** Accumulator for the local files this cover reads; see `noteDependency`. */
    deps?: Set<string>;
}): Promise<CoverPage | null> {
    if (!style) return null;

    const theme = getActiveTheme();
    const { imageSource, position, gradient } = resolveStyle(style);
    const titleColor = coverTitleColor ? resolveColorValue(coverTitleColor) : null;

    // For custom (object) styles the image path comes from the document frontmatter
    // and must be resolved relative to the document's directory.
    // Named (string) styles reference theme assets, already absolute.
    const resolvedImageSource = (imageSource && typeof style !== 'string' && baseDir)
        ? resolveDocumentAsset(imageSource, baseDir)
        : imageSource;

    // The cover assets are independent — fetch them in parallel.
    // Each failure degrades to null with a warning; the cover still renders.
    // Both logo variants are fetched: the white {{LOGO_IMG}} for dark/photo
    // covers and the dark {{LOGO_DARK_IMG}} for light-background layouts.
    const [coverImage, logoBase64, logoDarkBase64, coverLogoBase64] = await Promise.all([
        (async (): Promise<string | null> => {
            if (!resolvedImageSource) return null;
            try {
                log(`Fetching cover background: ${resolvedImageSource}`);
                noteDependency(resolvedImageSource, deps);
                const dataUrl = await fetchCoverImage(resolvedImageSource);
                log('Cover background loaded');
                return dataUrl;
            } catch (err: unknown) {
                log(`WARNING: Failed to load cover background: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        })(),
        (async (): Promise<string | null> => {
            // `Cover Footer Logo: false` removes the mark, so there is nothing to fetch.
            if (coverFooterLogo === false) return null;
            try {
                log('Fetching cover logo...');
                const source = coverFooterLogo ? resolveLogoPath(coverFooterLogo) : theme.logoWhite;
                noteDependency(source, deps);
                const b64 = await fetchAsBase64(source);
                log('Cover logo loaded');
                return b64;
            } catch (err: unknown) {
                log(`WARNING: Failed to load cover logo: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        })(),
        (async (): Promise<string | null> => {
            // Light-background layouts (markedapp-byword, witex) render this
            // variant instead of {{LOGO_IMG}}, so `Cover Footer Logo` has to
            // reach it too — otherwise the override silently does nothing on
            // exactly those themes.
            if (coverFooterLogo === false) return null;
            try {
                const source = coverFooterLogo ? resolveLogoPath(coverFooterLogo) : theme.logo;
                noteDependency(source, deps);
                const b64 = await fetchAsBase64(source);
                log('Cover logo (dark) loaded');
                return b64;
            } catch (err: unknown) {
                log(`WARNING: Failed to load dark cover logo: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        })(),
        (async (): Promise<string | null> => {
            if (!coverLogo) return null;
            try {
                const logoPath = baseDir
                    ? resolveDocumentAsset(coverLogo.path, baseDir)
                    : coverLogo.path;
                log(`Fetching cover logo: ${logoPath}`);
                noteDependency(logoPath, deps);
                const b64 = await fetchAsBase64(logoPath);
                log('Cover logo loaded');
                return b64;
            } catch (err: unknown) {
                log(`WARNING: Failed to load cover logo: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        })(),
    ]);

    const infoRows = documentInfo
        .filter(({ value }) => value.trim() !== '')
        .map(({ label, value }) =>
            `<span class="cover-info-label">${escHtml(label)}</span>` +
            `<span class="cover-info-value">${escHtml(value)}</span>`,
        ).join('\n');

    const coverCss = buildCoverCss(coverImage ?? null, gradient, position, titleColor);

    const revisionTableHtml = buildRevisionTable(revisions, revisionsVisible) ?? '';

    // Always emit the .cover-logo-wrapper so a theme's positioning CSS applies
    // whether or not a background is set. The Cover Logo `Background` frontmatter
    // is the ONLY source of the wrapper's colour — supplied inline here; absent →
    // no inline style → the wrapper renders transparent (themes never set one).
    const coverLogoHtml = coverLogoBase64
        ? `<div class="cover-logo-wrapper"${coverLogo?.background
              ? ` style="background-color:${escHtml(resolveColorValue(coverLogo.background))}"`
              : ''}><img src="${coverLogoBase64}" alt="Cover logo"></div>`
        : '';

    // Split the title on a separating em/en-dash or colon into a primary line and
    // a subtitle, so richer cover layouts can render a two-tier headline. Layouts
    // that don't use {{COVER_SUBTITLE}} keep the full title via {{COVER_TITLE}}.
    const { main: titleMain, subtitle: titleSubtitle } = splitTitle(title);

    noteDependency(theme.coverHtmlFile, deps);
    const html = loadHtmlTemplate(theme.coverHtmlFile, {
        COVER_TITLE:       escHtml(title),
        COVER_TITLE_MAIN:  escHtml(titleMain),
        COVER_SUBTITLE:    escHtml(titleSubtitle),
        COVER_THEME_NAME:  escHtml(theme.name),
        COVER_INFO_ROWS:   infoRows ? `<div class="cover-info-table">${infoRows}</div>` : '',
        // `false` empties the slot; a string replaces the theme's value. The
        // surrounding element stays in the DOM either way — the cover layouts
        // use flex spacing, and `:empty` rules already collapse a blank slot.
        COVER_ADDRESS:     coverAddress === false ? ''
                         : (coverAddress ?? theme.address.join('\n'))
                               .split('\n').map(escHtml).join('<br>'),
        COVER_SLOGAN:      coverSlogan === false ? '' : escHtml(coverSlogan ?? theme.slogan),
        LOGO_IMG:    logoBase64 ? `<img src="${logoBase64}" alt="${escHtml(theme.name)}">` : '',
        LOGO_DARK_IMG: logoDarkBase64 ? `<img src="${logoDarkBase64}" alt="${escHtml(theme.name)}">` : '',
        REVISION_TABLE:    revisionTableHtml,
        COVER_LOGO_IMG: coverLogoHtml,
    });

    return { css: coverCss, html };
}

// ── Cover CSS ─────────────────────────────────────────────────────────────────

function buildCoverCss(
    bgDataUrl: string | null,
    gradient: string | null,
    position: number,
    titleColor?: string | null,
): string {
    const photo   = bgDataUrl ? `url('${bgDataUrl}')` : 'none';
    // Element-based covers can choose a direction for the standard colour wash.
    // Keep the literal gradient for @page, where custom properties cannot resolve.
    const overlay = gradient?.replace(
        /^linear-gradient\(150deg,/,
        'linear-gradient(var(--cover-overlay-angle, 150deg),',
    ) ?? 'none';
    const posX    = `${Math.round(position * 100)}%`;

    // Full-bleed composition: the brand gradient over the photo, filling the page.
    // The horizontal focal point is baked as a literal percentage — WeasyPrint's
    // `@page` context can't resolve CSS custom properties, so `--cover-photo-pos-x`
    // (below) is for element rules only.
    let pageBg: string;
    if (bgDataUrl || gradient) {
        const layers = [gradient, bgDataUrl ? `url('${bgDataUrl}')` : null].filter(Boolean).join(', ');
        pageBg = `background-image: ${layers}; background-size: cover; background-position: ${posX} center;`;
    } else {
        pageBg = 'background-color: #1a2b4a;';
    }

    // The photo is exposed once as a custom property. Full-bleed themes layer
    // their geometric shapes over it, e.g.:
    //   background-image: <shapes…>, var(--cover-overlay), var(--cover-photo);
    // box layouts paint it in a positioned element (medallion/panel/framed photo).
    // `--cover-photo-pos-x` carries the horizontal focal point for cover-fit
    // element rules (the @page path bakes it into `pageBg` literally, above).
    const coverVars = `--cover-photo: ${photo}; --cover-overlay: ${overlay}; --cover-photo-pos-x: ${posX};`;

    // A theme paints the photo full-bleed on the page only if its cover.css opts
    // in with a `{{PAGE_BG}}` slot. Box layouts omit it and paint the photo in
    // their own element, so a full-bleed copy here would just sit wastefully
    // behind the box — skip it.
    //
    // Full-bleed themes ALSO need an element-level copy, but only when the
    // theme/style sets an opaque `background`: that makes the content `@page`
    // rule paint a page-box colour which WeasyPrint renders over the named
    // page's background-image, and the element copy (which sits above the page
    // box) is what keeps the photo visible.
    //
    // Without such a background the copy is pure waste — the same image and
    // gradient get composited onto the cover twice, which shows up as duplicate
    // layers in a PDF editor. Verified on a theme that sets no background:
    // dropping it takes page 1 from four tiling patterns to two and renders
    // pixel-for-pixel identically.
    //
    // Style-level backgrounds are covered too: main() runs applyStyleOverrides()
    // — which folds a named style's `background` onto the theme singleton —
    // before the cover is built, so `background` here is the resolved value.
    //
    // `body { margin: 0 }` removes the UA default 8px body margin so the cover
    // reaches the page edges (else an opaque body colour bleeds along top/left).
    const theme        = getActiveTheme();
    const coverCssFile = theme.coverCssFile;
    const coverCssSource = fs.readFileSync(coverCssFile, 'utf8');
    const fullBleed    = coverCssSource.includes('{{PAGE_BG}}');
    const needsElementCopy = fullBleed && Boolean(theme.background);
    // WeasyPrint versions in the wild differ in how reliably they retain an
    // image referenced through a custom property when another custom property
    // changes. Platen deliberately uses those properties for its cover layers,
    // so also emit the resolved image and gradient literally on the element.
    // The normal variables remain for themes that compose additional layers.
    const platenLayeredCover = coverCssSource.includes(
        'background-image: var(--cover-overlay), var(--cover-photo)',
    );
    const overlayAngle = /--cover-overlay-angle:\s*([^;]+);/.exec(coverCssSource)?.[1]?.trim();
    const literalGradient = overlayAngle && gradient
        ? gradient.replace(/^linear-gradient\([^,]+,/, `linear-gradient(${overlayAngle},`)
        : gradient;
    const literalElementBg = platenLayeredCover && (bgDataUrl || gradient)
        ? ` background-image: ${literalGradient ?? 'none'}, ${photo}; background-size: cover; background-position: ${posX} center;`
        : '';
    const coverPageDecl = needsElementCopy
        ? `${coverVars} ${pageBg}${literalElementBg}`
        : `${coverVars}${literalElementBg}`;

    // Themes draw the title's rule very differently — a bottom border, a full
    // box, a left bar, a `::after` strip — and each renders through its own
    // layout class (`.cover-l4`, `.cover-mx`, …) whose rules outrank a bare
    // `.cover-title` selector. So rather than fight specificity with override
    // rules, every theme reads `--cover-title-color` with its own value as the
    // fallback; setting it here on `.cover-page` reaches all of them by
    // inheritance, and leaving it unset changes nothing.
    const titleVar = titleColor ? ` --cover-title-color: ${titleColor};` : '';

    return loadCssTemplate(coverCssFile, { PAGE_BG: pageBg }) +
        `\n<style>body { margin: 0; } .cover-page { ${coverPageDecl}${titleVar} }</style>`;
}

// ── HTML export banner ────────────────────────────────────────────────────────

export const HTML_BANNER_CSS = `
/* banner — hero layout: cover logo top-left, brand logo top-right, title+meta+revisions bottom */
.html-banner {
    width:100%; min-height:480px; padding:2rem 2.5rem; box-sizing:border-box;
    color:#fff; background-size:cover; background-position:center;
    position:relative; display:flex; align-items:stretch;
}
.html-banner-inner {
    display:flex; flex-direction:column; justify-content:space-between;
    flex:1; max-width:960px; margin:0 auto;
    position:relative; z-index:1;
}
/* top row: cover logo left, brand logo right */
.html-banner-logos {
    display:flex; align-items:center; justify-content:space-between;
}
.html-banner-cover-logo {
    padding:0.45rem 0.8rem; border-radius:5px; display:flex; align-items:center;
}
.html-banner-cover-logo img { height:52px; width:auto; }
.html-banner-brand-logo { height:32px; width:auto; opacity:0.9; }
/* bottom group: title, meta, then revision table */
.html-banner-bottom { display:flex; flex-direction:column; gap:1.25rem; }
.html-banner-title {
    margin:0; padding:0; border:none;
    font-family:var(--font-heading, sans-serif);
    font-size:2.6rem; font-weight:700; color:var(--cover-title-color, #fff); line-height:1.15;
    text-shadow:0 1px 6px rgba(0,0,0,0.4);
}
.html-banner-subtitle {
    margin:0.35rem 0 0; padding:0;
    font-family:var(--font-heading, sans-serif);
    font-size:1.15rem; font-weight:400; color:var(--cover-title-color, rgba(255,255,255,0.85)); line-height:1.3;
    text-shadow:0 1px 6px rgba(0,0,0,0.4);
}
.html-banner-subtitle:empty { display:none; }
.html-banner-meta { margin-top:1.1rem; display:flex; flex-wrap:wrap; gap:0.75rem 2.25rem; }
.html-banner-meta-item { display:flex; flex-direction:column; gap:0.15rem; }
.html-banner-meta-label {
    font-size:0.65rem; text-transform:uppercase;
    letter-spacing:0.08em; opacity:0.7; font-weight:600;
}
.html-banner-meta-value { font-size:0.9rem; }
/* revision table — identical to PDF cover styling.
   Explicit nth-child and thead overrides defeat the theme stylesheet's bleed-in:
     table tr:nth-child(2n)  { background-color: #f6f8fa }
     table thead tr          { background-color: <brand colour> }
     table thead tr th       { border-color: <brand colour> }    */
.html-banner-revisions {
    border-top:0.15em solid rgba(255,255,255,0.2); padding-top:1rem;
}
.html-banner-revisions table {
    width:100%; border-collapse:collapse;
    font-size:9pt; color:rgba(255,255,255,0.9); background-color:transparent;
}
.html-banner-revisions tr,
.html-banner-revisions tr:nth-child(2n),
.html-banner-revisions thead tr,
.html-banner-revisions thead tr:nth-child(2n) { background-color:transparent; }
.html-banner-revisions th,
.html-banner-revisions td {
    padding:6px 12px; text-align:left;
    border:none; border-bottom:0.1em solid rgba(255,255,255,0.2);
    color:rgba(255,255,255,0.9); background-color:transparent;
}
.html-banner-revisions thead th {
    font-size:8pt; font-weight:600; letter-spacing:0.05em;
    color:rgba(255,255,255,0.55);
    border-bottom:0.15em solid rgba(255,255,255,0.35);
    border-color:rgba(255,255,255,0.35);
    padding-bottom:8px;
}
.html-banner-revisions tbody tr:last-child td { border-bottom:none; }
.html-banner-revisions .rev-center { text-align:center; width:2em; }
.html-banner-revisions .rev-remarks { overflow-wrap: normal; word-break: normal; hyphens: none; }
/* body layout */
body.html-export { margin:0; padding:0; }
body.html-export .github-markdown-body { max-width:960px; margin:0 auto; padding:2rem 2.5rem; }
`.trim();

export async function buildHtmlBanner({
    title,
    documentInfo = [],
    revisions,
    revisionsVisible = 0,
    style,
    coverLogo,
    baseDir = '',
    coverTitleColor,
    deps,
}: {
    title: string;
    documentInfo?: DocumentInfoEntry[];
    revisions?: RevisionEntry[] | null;
    revisionsVisible?: number;
    style: string | StyleFrontmatter | null;
    coverLogo?: CoverLogoSpec | null;
    baseDir?: string;
    /** Recolour the banner title and subtitle, mirroring the PDF cover. */
    coverTitleColor?: string | null;
    /** Accumulator for the local files this banner reads; see `noteDependency`. */
    deps?: Set<string>;
}): Promise<string> {
    const theme = getActiveTheme();
    const resolved  = style ? resolveStyle(style) : null;
    const gradient  = resolved?.gradient ?? null;
    const imageSource = resolved?.imageSource ?? null;

    // Background image and logos are independent — fetch them in parallel.
    // Failures are silent: gradient/colour fallback, banner renders without logos.
    const [bgImageBase64, brandLogoBase64, coverLogoBase64] = await Promise.all([
        (async (): Promise<string | null> => {
            if (!imageSource) return null;
            try {
                const resolvedSrc = (typeof style !== 'string' && baseDir)
                    ? resolveDocumentAsset(imageSource, baseDir)
                    : imageSource;
                log(`Fetching banner background: ${resolvedSrc}`);
                noteDependency(resolvedSrc, deps);
                const b64 = await fetchBannerImageAsBase64(resolvedSrc);
                log('Banner background loaded');
                return b64;
            } catch (err: unknown) {
                log(`WARNING: Failed to load banner background: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        })(),
        (noteDependency(theme.logoWhite, deps), fetchAsBase64(theme.logoWhite).catch(() => null)),
        (async (): Promise<string | null> => {
            if (!coverLogo?.path) return null;
            try {
                const src = resolveDocumentAsset(coverLogo.path, baseDir);
                noteDependency(src, deps);
                return await fetchAsBase64(src);
            } catch { return null; }
        })(),
    ]);

    // Build inline background style: gradient over image, or gradient only, or solid fallback
    let bgStyle: string;
    if (bgImageBase64 && gradient) {
        bgStyle = `background-image:${gradient},url('${bgImageBase64}');background-size:cover;background-position:center`;
    } else if (bgImageBase64) {
        bgStyle = `background-image:url('${bgImageBase64}');background-size:cover;background-position:center`;
    } else if (gradient) {
        bgStyle = `background-image:${gradient}`;
    } else {
        bgStyle = 'background-color:#1a2b4a';
    }

    const metaHtml = documentInfo
        .filter(({ value }) => value.trim())
        .map(({ label, value }) => `
        <div class="html-banner-meta-item">
            <span class="html-banner-meta-label">${escHtml(label)}</span>
            <span class="html-banner-meta-value">${escHtml(value)}</span>
        </div>`.trim())
        .join('\n        ');

    const coverLogoHtml = coverLogoBase64
        ? `<div class="html-banner-cover-logo"${coverLogo?.background
              ? ` style="background:${escHtml(resolveColorValue(coverLogo.background))}"`
              : ''}><img src="${coverLogoBase64}" alt="Cover logo"></div>`
        : '';

    const brandLogoHtml = brandLogoBase64
        ? `<img class="html-banner-brand-logo" src="${brandLogoBase64}" alt="${escHtml(theme.name)}">`
        : '';

    const revisionTableHtml = buildRevisionTable(revisions, revisionsVisible);
    const revisionSection   = revisionTableHtml
        ? `\n    <div class="html-banner-revisions">${revisionTableHtml}</div>`
        : '';

    // Split the title on a separating em/en-dash or colon into a primary line
    // and a subtitle, mirroring the PDF cover (see splitTitle). The subtitle
    // element always renders, empty when there's no separator; `:empty` in
    // HTML_BANNER_CSS collapses it so the layout matches the pre-subtitle look.
    const { main: titleMain, subtitle: titleSubtitle } = splitTitle(title);

    // Same custom property the PDF cover sets, so the two surfaces stay in step.
    // The banner draws no rule under its title, so only the two text colours
    // respond. resolveColorValue has already rejected anything that isn't a
    // literal or a known palette name, so this is safe to interpolate.
    const titleColorVar = coverTitleColor
        ? `;--cover-title-color:${resolveColorValue(coverTitleColor)}`
        : '';

    return `
<div class="html-banner" style="${bgStyle}${titleColorVar}">
    <div class="html-banner-inner">
        <div class="html-banner-logos">
            ${coverLogoHtml || '<span></span>'}
            ${brandLogoHtml}
        </div>
        <div class="html-banner-bottom">
            <div>
                <h1 class="html-banner-title">${escHtml(titleMain)}</h1>
                <p class="html-banner-subtitle">${escHtml(titleSubtitle)}</p>
                ${metaHtml ? `<div class="html-banner-meta">\n                ${metaHtml}\n            </div>` : ''}
            </div>${revisionSection}
        </div>
    </div>
</div>`.trimStart();
}

// ── Revision table ────────────────────────────────────────────────────────────

export function buildRevisionTable(
    revisions: RevisionEntry[] | null | undefined,
    limit = 3,
): string | null {
    if (!revisions?.length || limit <= 0) return null;

    const rows = revisions.slice(-limit).map(r => `
        <tr>
            <td class="rev-center">${escHtml(r.revision)}</td>
            <td>${escHtml(r.date)}</td>
            <td>${escHtml(r.author)}</td>
            <td class="rev-remarks">${escHtml(r.remarks)}</td>
        </tr>`).join('');

    return loadHtmlTemplate(getActiveTheme().revisionHtmlFile, { REVISION_ROWS: rows });
}
