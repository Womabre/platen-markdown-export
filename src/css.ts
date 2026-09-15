/**
 * CSS *generated* from the active theme: page geometry, palette variables,
 * typography, the highlight.js and dark-mode blocks.
 *
 * Its counterpart is stylesheets.ts, which ingests CSS written elsewhere (icon
 * fonts, remote and local stylesheets) and flattens it into the document. The
 * two used to be one 955-line file; they share no state, and separating them is
 * the difference between "what does this theme look like" and "how do we get
 * someone else's stylesheet into a self-contained page".
 */

import * as fs from 'fs';
import * as path from 'path';
import { getActiveTheme } from './theme';
import { contrastRatio, isDarkColor } from './color';
import { PAPER_SIZES } from './frontmatter';
import { fetchRemote } from './fetch';
import { log } from './logger';
import { literal } from './strings';
import type { ColorPalette, FontConfig, PageCssTokens, PaperDimensions, PageOrientation } from './types';

// ── Highlight.js theme ────────────────────────────────────────────────────────

/**
 * Inlines the highlight.js GitHub theme so WeasyPrint sees syntax colours.
 * Overrides `overflow-x: auto` (useless in print) with `overflow-x: visible`
 * so long lines don't silently disappear in the PDF.
 */
export function buildHljsStyleBlock(): string {
    // On a dark page the light GitHub highlight theme (white card, dark tokens)
    // is unreadable, so switch to github-dark when the active theme/style
    // background is dark. Blank/light backgrounds keep the light theme unchanged
    // (so themes without a background — are unaffected).
    const bg = getActiveTheme().background;
    const variant = bg && isDarkColor(bg) ? 'github-dark.min.css' : 'github.min.css';
    try {
        const cssPath = require.resolve(`highlight.js/styles/${variant}`, { paths: [__dirname] });
        const css = fs.readFileSync(cssPath, 'utf8')
            .replace('overflow-x:auto', 'overflow-x:visible');
        return `<style>\n${css}\n</style>`;
    } catch (err: unknown) {
        log(`WARNING: Could not inline highlight.js CSS: ${(err as Error).message}`);
        return '';
    }
}

// ── HTML export body CSS ──────────────────────────────────────────────────────

/**
 * Base CSS applied only to the HTML export pipeline.
 * The theme stylesheet is print-optimised at 9pt throughout; these overrides
 * rebase everything to 12pt for comfortable screen reading.
 * All hardcoded 9pt values from the theme are reset to 1em so they
 * scale naturally from the new base.
 */
export const HTML_BODY_CSS = `
/* ── HTML export: rebase from 9pt → 12pt ───────────── */
body,
.markdown-body,
.github-markdown-body,
.github-markdown-content {
    font-size: 12pt;
    line-height: 1.6;
}
/* TOC: all hardcoded 9pt levels → 1em (= 12pt) */
nav.toc a::before,
nav.toc > ul > li > a,
nav.toc > ul > li > ul > li > a,
nav.toc > ul > li > ul > li > ul > li > a,
nav.toc > ul > li > ul > li > ul > li > ul > li > a,
nav.toc > ul > li > ul > li > ul > li > ul > li > ul > li > a,
nav.toc > ul > li > ul > li > ul > li > ul > li > ul > li > ul > li > a {
    font-size: 1em;
}`;

// ── HTML export dark mode ──────────────────────────────────────────────────────
//
// The theme stylesheet is tuned for print on white paper. When the exported HTML
// is viewed in a browser whose OS is in dark mode, those light surfaces (white
// page, pale code/table/alert backgrounds, dark brand-colour headings) become
// glaring or low-contrast. This block restyles them inside a
// `prefers-color-scheme: dark` media query, so it only takes effect on screen
// in dark mode and never touches the PDF pipeline.

/**
 * Lightens a hex colour by mixing it halfway toward white. A print-tuned brand
 * colour (e.g. a deep green like #009146) is too dark to read as heading text
 * on a dark background; this pulls it up into a legible, still-on-brand tint.
 * Falls back to a soft neutral tint for unparseable input.
 */
function lightenForDarkBg(hex: string): string {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return '#9aa5b1';
    const h    = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    const num  = parseInt(h, 16);
    const mix  = (c: number) => Math.round(c + (255 - c) * 0.5);
    const r    = mix((num >> 16) & 255);
    const g    = mix((num >> 8) & 255);
    const b    = mix(num & 255);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Inlines the highlight.js GitHub *Dark* theme for use inside the dark-mode block. */
function readHljsDarkCss(): string {
    try {
        const cssPath = require.resolve('highlight.js/styles/github-dark.min.css', { paths: [__dirname] });
        return fs.readFileSync(cssPath, 'utf8').replace('overflow-x:auto', 'overflow-x:visible');
    } catch (err: unknown) {
        log(`WARNING: Could not inline highlight.js dark CSS: ${(err as Error).message}`);
        return '';
    }
}

/**
 * Builds the `prefers-color-scheme: dark` override block for the HTML export.
 * `themeMainColor` is the document's resolved primary colour (or null) — used to
 * keep headings on-brand while lightening them for the dark surface. Must be
 * injected *after* the theme-override styles so its heading rule (which carries
 * `!important` to match the theme override) wins in dark mode.
 */
export function buildHtmlDarkModeCss(themeMainColor: string | null): string {
    const heading  = lightenForDarkBg(themeMainColor ?? '#334155');
    const hljsDark = readHljsDarkCss();
    return `<style>
@media (prefers-color-scheme: dark) {
  /* ── Page surface & body text ─────────────────────────── */
  html { background: #1a1a1a; }
  body,
  .markdown-body,
  .github-markdown-body,
  .github-markdown-content { background: #1a1a1a; color: #c9c9c9; }

  /* ── Headings (brand tint, lightened for dark bg) ─────── */
  .github-markdown-body h1,
  .github-markdown-body h2,
  .github-markdown-body h3,
  .github-markdown-body h4,
  .github-markdown-body h5,
  .github-markdown-body h6 { color: ${heading} !important; }

  /* ── Links (TOC & heading anchors keep inherit) ───────── */
  .github-markdown-body a { color: #6ea8fe; }
  nav.toc a,
  .github-markdown-body h1 a,
  .github-markdown-body h2 a,
  .github-markdown-body h3 a,
  .github-markdown-body h4 a,
  .github-markdown-body h5 a,
  .github-markdown-body h6 a { color: inherit; }

  /* ── Tables ───────────────────────────────────────────── */
  table th,
  table td { border-color: #4a4a4a; }
  table tr:nth-child(2n) { background-color: #242424; }

  /* ── Inline code ──────────────────────────────────────── */
  :not(pre) > code { background: #2d2d2d; color: #e6e6e6; }

  /* ── Code blocks: highlight.js GitHub Dark ────────────── */
  ${hljsDark}

  /* ── Blockquotes & rules ──────────────────────────────── */
  blockquote { border-left-color: #4a4a4a; color: #a8a8a8; }
  hr { background-color: #4a4a4a; border-color: #4a4a4a; }

  /* ── Diagrams (Mermaid, Graphviz, infographic) ─────────────
        The diagram is an isolated SVG data-URL <img>, so host CSS
        can't restyle its internals — only a filter applies. A smart
        invert flips luminance (black strokes/text → light, white bg →
        dark) while hue-rotate(180deg) keeps coloured nodes on-hue.
        invert(0.9) (not 1) lands white on the page bg (#1a1a1a) and
        black on the body text tone (#e6e6e6) instead of harsh #000/#fff.
        Targets the shared .diagram-figure class every renderer emits. */
  .diagram-figure > img { filter: invert(0.9) hue-rotate(180deg); }

  /* ── GitHub alerts ────────────────────────────────────── */
  .markdown-alert-note      { background: rgba(56,139,253,0.10); border-color: #388bfd; }
  .markdown-alert-note .markdown-alert-title,
  .markdown-alert-note .markdown-alert-title svg path { color: #6cb6ff; fill: #6cb6ff; }

  .markdown-alert-tip       { background: rgba(63,185,80,0.10); border-color: #3fb950; }
  .markdown-alert-tip .markdown-alert-title,
  .markdown-alert-tip .markdown-alert-title svg path { color: #56d364; fill: #56d364; }

  .markdown-alert-important { background: rgba(163,113,247,0.10); border-color: #a371f7; }
  .markdown-alert-important .markdown-alert-title,
  .markdown-alert-important .markdown-alert-title svg path { color: #c297ff; fill: #c297ff; }

  .markdown-alert-warning   { background: rgba(210,153,34,0.10); border-color: #d29922; }
  .markdown-alert-warning .markdown-alert-title,
  .markdown-alert-warning .markdown-alert-title svg path { color: #e3b341; fill: #e3b341; }

  .markdown-alert-caution   { background: rgba(248,81,73,0.10); border-color: #f85149; }
  .markdown-alert-caution .markdown-alert-title,
  .markdown-alert-caution .markdown-alert-title svg path { color: #ff7b72; fill: #ff7b72; }

  /* ── Admonitions (brighten heading text + icon; the flat
        rgba fills already read fine over the dark surface) ─ */
  .admonition-note     > .admonition-heading,
  .admonition-note     > .admonition-heading svg path { color: #82b1ff; fill: #82b1ff; }
  .admonition-abstract > .admonition-heading,
  .admonition-abstract > .admonition-heading svg path { color: #4fc3f7; fill: #4fc3f7; }
  .admonition-info     > .admonition-heading,
  .admonition-info     > .admonition-heading svg path { color: #4dd0e1; fill: #4dd0e1; }
  .admonition-tip      > .admonition-heading,
  .admonition-tip      > .admonition-heading svg path { color: #4db6ac; fill: #4db6ac; }
  .admonition-success  > .admonition-heading,
  .admonition-success  > .admonition-heading svg path { color: #66bb6a; fill: #66bb6a; }
  .admonition-question > .admonition-heading,
  .admonition-question > .admonition-heading svg path { color: #9ccc65; fill: #9ccc65; }
  .admonition-warning  > .admonition-heading,
  .admonition-warning  > .admonition-heading svg path { color: #ffb74d; fill: #ffb74d; }
  .admonition-failure  > .admonition-heading,
  .admonition-failure  > .admonition-heading svg path { color: #ff8a80; fill: #ff8a80; }
  .admonition-danger   > .admonition-heading,
  .admonition-danger   > .admonition-heading svg path { color: #ff5252; fill: #ff5252; }
  .admonition-bug      > .admonition-heading,
  .admonition-bug      > .admonition-heading svg path { color: #ff5c8a; fill: #ff5c8a; }
  .admonition-example  > .admonition-heading,
  .admonition-example  > .admonition-heading svg path { color: #b39ddb; fill: #b39ddb; }
  .admonition-quote    > .admonition-heading,
  .admonition-quote    > .admonition-heading svg path { color: #bdbdbd; fill: #bdbdbd; }
}
</style>`;
}

// ── CSS template loader ───────────────────────────────────────────────────────

export function loadCssTemplate(filePath: string, tokens: Record<string, string> = {}): string {
    if (!fs.existsSync(filePath))
        throw new Error(`CSS template not found: ${filePath}`);

    let css = fs.readFileSync(filePath, 'utf8');
    for (const [token, value] of Object.entries(tokens))
        css = css.replaceAll(`{{${token}}}`, literal(value));

    return `<style>\n${css}\n</style>`;
}

// ── Page CSS ──────────────────────────────────────────────────────────────────

/**
 * Escapes a value for use inside a double-quoted CSS string literal, so titles
 * like `Implementing "Smart" Workflows` don't break the running header rules.
 */
export function cssString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\r\n]+/g, ' ');
}

/** The `@page margin` used when a document sets none — matches WeasyPrint's own default. */
export const DEFAULT_PAGE_MARGIN = '2cm';

/** Converts a CSS length to millimetres. */
function toMm(value: string, unit: string): number {
    const n = parseFloat(value);
    switch (unit.toLowerCase()) {
        case 'cm': return n * 10;
        case 'in': return n * 25.4;
        case 'pt': return n * 25.4 / 72;
        case 'px': return n * 25.4 / 96;
        default:   return n;
    }
}

/** The components of a 1–4 value CSS margin shorthand, in mm; unparseable values count as 0. */
function marginPartsMm(margins: string): number[] {
    const one = (v: string): number => {
        const m = /^([\d.]+)(mm|cm|in|pt|px)$/i.exec(v.trim());
        return m ? toMm(m[1], m[2]) : 0;
    };
    return margins.trim().split(/\s+/).map(one);
}

/** Sums the top+bottom components of a 1–4 value CSS margin shorthand, in mm. */
export function verticalMarginMm(margins: string): number {
    const p = marginPartsMm(margins);
    // CSS shorthand: 1 → all, 2 → v h, 3 → t h b, 4 → t r b l
    if (p.length === 1) return p[0] * 2;
    if (p.length === 2) return p[0] * 2;
    if (p.length === 3) return p[0] + p[2];
    return p[0] + p[2];
}

/** Sums the left+right components of a 1–4 value CSS margin shorthand, in mm. */
export function horizontalMarginMm(margins: string): number {
    const p = marginPartsMm(margins);
    // 1 → all, 2 → v h, 3 → t h b (h is both sides), 4 → t r b l
    if (p.length === 1) return p[0] * 2;
    if (p.length === 2) return p[1] * 2;
    if (p.length === 3) return p[1] * 2;
    return p[1] + p[3];
}

/**
 * Vertical space a body figure has to leave for the page chrome.
 *
 * The running header, the footer band and the caption that usually travels with
 * a figure all sit inside the margin box. This is exactly what the previous
 * hardcoded body-image cap already implied — it allowed 220 mm of height on an
 * A4 page whose margin box is 257 mm tall — kept as a constant because it is
 * chrome, sized in points, and does not grow when the paper does.
 */
const PAGE_CHROME_MM = 37;

/**
 * The area a body image can occupy on this document's page, in millimetres.
 *
 * The cap used to be two constants derived from A4 portrait at the default 2 cm
 * margin — which is right for the common case and wrong for every other one the
 * tool supports. On A3, or in landscape, or with narrow margins, an image was
 * still resized to fit an A4 portrait page and printed soft on paper with room
 * for twice the pixels. Nothing reported it: `inlineImages` logs the resize as
 * ordinary progress, and a slightly blurry figure is not something you notice
 * against the source you no longer have.
 *
 * Defaults reproduce the old numbers exactly: A4 portrait at 2 cm → 170 × 220.
 */
export function contentBoxMm(
    pageSize: string | null,
    margins: string | null,
    orientation: PageOrientation = 'portrait',
): { widthMm: number; heightMm: number } {
    const paper = resolvePaperSize(pageSize);
    const m     = margins ?? DEFAULT_PAGE_MARGIN;

    const isLandscape = orientation === 'landscape';
    const sheetW = isLandscape ? paper.heightMm : paper.widthMm;
    const sheetH = isLandscape ? paper.widthMm  : paper.heightMm;

    return {
        widthMm:  Math.max(20, sheetW - horizontalMarginMm(m)),
        heightMm: Math.max(20, sheetH - verticalMarginMm(m) - PAGE_CHROME_MM),
    };
}

export function buildPageCss(tokens: PageCssTokens): string {
    const { title, header, footer, date, revision, status, author,
            runningHeader, classification, pageSize, margins, orientation,
            hasCover = true } = tokens;
    // `Running Header: true` swaps the static header string for the current
    // section, carried up from the body by `string-set: section content()`.
    // A section-less first page would render nothing, so the literal header
    // stays the fallback until the first h2 sets the string.
    const headerContent = runningHeader
        ? 'string(section)'
        : header ? `"${cssString(header)}"` : `"${cssString(title)}"`;
    const footerContent = footer ? `"${cssString(footer)}"` : `counter(page) " of " counter(pages)`;
    const authorContent = author ? `"${cssString(author)}"` : '""';

    // `@page :first` exists to dress the COVER — brand mark instead of the
    // running header, no footer logo, author instead of the page number. With
    // a cover present those rules are moot anyway (cover.css blanks every
    // margin box on the named `cover` page), but with `Cover Page: false` they
    // land on the first page of actual content, giving it a logo where every
    // other page has header text and an empty footer where every other page has
    // the page number. So without a cover, page one takes the ordinary values.
    const firstTopLeft      = hasCover ? 'element(logo-header)' : headerContent;
    const firstBottomCenter = hasCover ? "''" : 'element(logo-footer)';
    const firstBottomRight  = hasCover ? authorContent : footerContent;

    return loadCssTemplate(getActiveTheme().pageCssFile, {
        HEADER_CONTENT: headerContent,
        FIRST_TOP_LEFT:      firstTopLeft,
        FIRST_BOTTOM_CENTER: firstBottomCenter,
        FIRST_BOTTOM_RIGHT:  firstBottomRight,
        CLASSIFICATION_CONTENT: classification ? 'element(classification)' : "''",
        FOOTER_CONTENT: footerContent,
        DATE_CONTENT:   date     ? `"${cssString(date)}"`   : '""',
        REV_CONTENT:    revision ? `" - Rev${cssString(revision)}"` : '""',
        STATUS_CONTENT: status   ? `"${cssString(status)}"` : '""',
        AUTHOR_CONTENT: authorContent,
        // @page margin boxes use tokens (not CSS vars) to avoid any custom-
        // property resolution edge cases inside WeasyPrint's page context.
        PAGE_FONT:      getActiveTheme().fontBody,
        PAGE_BG:        getActiveTheme().background || 'transparent',
        // Three sizes: the document default (from `Orientation`) plus a fixed
        // landscape and portrait sheet for the `::: landscape` / `::: portrait`
        // per-page overrides.
        PAGE_SIZE:           pageSizeCss(pageSize ?? null, orientation ?? 'portrait'),
        PAGE_SIZE_LANDSCAPE: pageSizeCss(pageSize ?? null, 'landscape'),
        PAGE_SIZE_PORTRAIT:  pageSizeCss(pageSize ?? null, 'portrait'),
        PAGE_MARGIN:    margins ?? DEFAULT_PAGE_MARGIN,
    });
}

/**
 * Caps diagrams and images to what actually fits between the page margins, as
 * CSS variables the theme stylesheet consumes.
 *
 * Without this a tall Mermaid diagram (a multi-phase Gantt, say) simply runs off
 * the bottom of the sheet and is clipped — `break-inside: avoid` cannot help
 * once a single element is taller than one page. The landscape figure is the
 * one that bites, since a rotated A4 is only 210mm tall.
 */
/**
 * Millimetre dimensions for a `Page Size` value — a named size, or the literal
 * `"<width> <height>"` pair the frontmatter also accepts. Unknown input falls
 * back to A4, matching the `@page` default.
 */
export function resolvePaperSize(pageSize: string | null): PaperDimensions {
    const value = (pageSize ?? 'A4').trim();
    const named = PAPER_SIZES[value.toLowerCase()];
    if (named) return named;

    const m = /^([\d.]+)\s*(mm|cm|in|pt|px)\s+([\d.]+)\s*(mm|cm|in|pt|px)$/i.exec(value);
    if (m) return { widthMm: toMm(m[1], m[2]), heightMm: toMm(m[3], m[4]) };

    return PAPER_SIZES.a4;
}

/**
 * A CSS `size` value for one orientation.
 *
 * A named size takes the `portrait`/`landscape` keyword; a literal `W H` pair
 * cannot (the keyword is only valid after a page-size name), so its two lengths
 * are swapped instead.
 */
export function pageSizeCss(pageSize: string | null, orientation: PageOrientation): string {
    const value = (pageSize ?? 'A4').trim();
    if (PAPER_SIZES[value.toLowerCase()]) return `${value} ${orientation}`;

    const m = /^([\d.]+\s*(?:mm|cm|in|pt|px))\s+([\d.]+\s*(?:mm|cm|in|pt|px))$/i.exec(value);
    if (!m) return `A4 ${orientation}`;
    const [w, h] = [m[1].trim(), m[2].trim()];
    // A literal pair is authored width-first, i.e. already the sheet as drawn.
    const isWide = resolvePaperSize(value).widthMm >= resolvePaperSize(value).heightMm;
    const wantWide = orientation === 'landscape';
    return isWide === wantWide ? `${w} ${h}` : `${h} ${w}`;
}

export function buildPageMetricsCss(
    pageSize: string | null,
    margins: string | null,
    orientation: PageOrientation = 'portrait',
): string {
    const paper  = resolvePaperSize(pageSize);
    const vMargin = verticalMarginMm(margins ?? DEFAULT_PAGE_MARGIN);

    // Leave a little slack for the caption/heading that usually sits with a figure.
    const portrait  = Math.max(40, paper.heightMm - vMargin - 10);
    const landscape = Math.max(40, paper.widthMm  - vMargin - 10);

    // The default sheet follows `Orientation`; the cover and any figure on a
    // default page size themselves from it.
    const isLandscape = orientation === 'landscape';
    const sheetW = isLandscape ? paper.heightMm : paper.widthMm;
    const sheetH = isLandscape ? paper.widthMm  : paper.heightMm;
    const usable = isLandscape ? landscape : portrait;

    // --page-width/-height are the FULL sheet, not the usable area: the cover
    // sets `@page cover { margin: 0 }` and so must span the paper edge to edge.
    // Themes hardcoded 210mm x 297mm before this, which left the whole cover
    // squeezed into an A4-sized corner of any larger sheet.
    return `<style>
:root {
  --page-width: ${sheetW}mm;
  --page-height: ${sheetH}mm;
  --page-usable-height: ${usable}mm;
  --page-usable-height-landscape: ${landscape}mm;
  --page-usable-height-portrait: ${portrait}mm;
}
</style>`;
}

/**
 * CSS-variable slug for a palette name: the lowercased name, unless the theme's
 * manifest names one itself in `paletteNames`.
 *
 * The override exists for a theme ported from another project, whose variable
 * names a document may already carry — a `var(--cherry-main)` copied from the
 * source project has to mean the same colour here. That mapping is data about
 * one theme, so it lives in that theme's `theme.json`; this used to be a
 * hardcoded special case naming a specific palette, which put one private
 * theme's vocabulary into every checkout of the exporter.
 */
function paletteSlug(name: string, t?: ReturnType<typeof getActiveTheme>): string {
    return t?.paletteNames?.[name]?.slug ?? name.toLowerCase();
}

const PALETTE_STOPS = [
    ['extraLight', 'extra-light'],
    ['light',      'light'],
    ['main',       'main'],
    ['regular',    'regular'],
    ['medium',     'medium'],
    ['dark',       'dark'],
    ['extraDark',  'extra-dark'],
] as const;

/**
 * Readable foreground for a given background: the first candidate clearing the
 * WCAG AA threshold for body text (4.5:1), else the highest-contrast one.
 *
 * Necessary because "brand main" is not reliably dark. A ramp authored for the
 * screen routinely puts a pale tint at `main` — white on a `#b8e4e1` teal scores
 * 1.38:1, which is unreadable. Hardcoding white silently produces invisible text
 * for every such palette.
 *
 * Candidates are ordered by brand fidelity: white first, then the palette's own
 * darkest stop, then plain black as the backstop — a mid-tone `main` such as
 * `default`'s green `#16a34a` clears neither white nor its own `extraDark`.
 */
function readableOn(bg: string, palette: ColorPalette): string {
    const candidates = ['#ffffff', palette.extraDark, '#000000'];
    return candidates.find(c => contrastRatio(bg, c) >= 4.5)
        ?? candidates.reduce((a, b) => (contrastRatio(bg, b) > contrastRatio(bg, a) ? b : a));
}

/**
 * Inline brand colour blocks — `<div class="modern-cherry-scheme">`. Generated
 * rather than hand-written, so every palette in any theme gets a pair for free
 * and the foreground stays contrast-checked.
 *
 * Classes are prefixed with the theme name, because they are inherently
 * theme-specific — `cherry` is a `modern` palette and has no meaning under
 * `default`. A theme ported from another project can add extra spellings for a
 * palette through its manifest's `paletteNames[…].aliases`, for the case where
 * its ramp and its scheme class were named differently upstream; that used to be
 * a hardcoded table here, naming one private theme's palettes in public source.
 */
function buildSchemeClasses(t: ReturnType<typeof getActiveTheme>): string {
    const prefix = path.basename(t.dir).toLowerCase();
    const rules: string[] = [
        '[class*="-scheme"] { background-color: var(--scheme-bg, transparent);' +
        ' color: var(--scheme-fg, inherit); padding: 0.5em 0.9em; border-radius: 4px; }',
    ];

    for (const [name, p] of Object.entries(t.palettes)) {
        const slug = paletteSlug(name, t);
        const names = [slug, ...(t.paletteNames?.[name]?.aliases ?? [])];
        const selectors = (suffix: string) =>
            names.map(n => `.${prefix}-${n}-${suffix}`).join(', ');

        rules.push(
            `${selectors('scheme')} { --scheme-bg: var(--${slug}-main);` +
            ` --scheme-fg: ${readableOn(p.main, p)}; }`,
        );
        rules.push(
            `${selectors('light-scheme')} { --scheme-bg: var(--${slug}-extra-light);` +
            ` --scheme-fg: ${readableOn(p.extraLight, p)}; }`,
        );
    }
    return rules.join('\n');
}

/**
 * Every palette in the active theme as `--<slug>-<stop>` CSS variables, plus a
 * `--gradient-<slug>` per palette. Generated from theme.json so the manifest is
 * the single source of truth — theme stylesheets reference these and never
 * redeclare the hex values themselves.
 */
function buildPaletteVars(t: ReturnType<typeof getActiveTheme>): string {
    const lines: string[] = [];

    for (const [name, palette] of Object.entries(t.palettes)) {
        const slug = paletteSlug(name, t);
        const stops = PALETTE_STOPS
            .map(([key, css]) => `--${slug}-${css}: ${palette[key]};`)
            .join(' ');
        lines.push(`  ${stops}`);
    }

    // One gradient token per palette, so a theme stylesheet can reach for a
    // ramp's sweep without restating either end of it.
    for (const name of Object.keys(t.palettes)) {
        const slug = paletteSlug(name, t);
        lines.push(`  --gradient-${slug}: linear-gradient(135deg, var(--${slug}-light) 0%, var(--${slug}-dark) 100%);`);
    }

    return lines.join('\n');
}

/**
 * A <style> block exposing the active theme's typography, background and brand
 * palettes as CSS variables, so the theme stylesheet and cover CSS can reference
 * them (`var(--font-body)`, `var(--fs-h1)`, `var(--cherry-main)`, …) instead of
 * hardcoding values. Injected into <head>.
 */
export function buildThemeVarsCss(): string {
    const t  = getActiveTheme();
    const fs = t.fontSizes;
    const pageBg = t.background ? ` --page-bg: ${t.background};` : '';
    return `<style>
:root {
  --font-body: ${t.fontBody}; --font-heading: ${t.fontHeading};
  --fs-body: ${fs.body}; --fs-h1: ${fs.h1}; --fs-h2: ${fs.h2}; --fs-h3: ${fs.h3};
  --fs-h4: ${fs.h4}; --fs-h5: ${fs.h5}; --fs-h6: ${fs.h6};${pageBg}
${buildPaletteVars(t)}
}
${buildSchemeClasses(t)}
</style>`;
}

// ── Font inlining ─────────────────────────────────────────────────────────────

export async function fetchFontFace({ url, family, weight, style, name }: FontConfig): Promise<string | null> {
    try {
        log(`Fetching font: ${name}`);
        const { buffer } = await fetchRemote(url);
        const b64 = buffer.toString('base64');
        log(`Font ready: ${name} (${(buffer.length / 1024).toFixed(0)} KB)`);
        return `@font-face { font-family: '${family}'; src: url('data:font/woff2;base64,${b64}') format('woff2'); font-weight: ${weight}; font-style: ${style}; }`;
    } catch (err: unknown) {
        log(`WARNING: Could not fetch font ${name}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

export async function buildFallbackFontStyles(): Promise<string> {
    const rules = (
        await Promise.all(getActiveTheme().fallbackFonts.map(fetchFontFace))
    ).filter((f): f is string => f !== null).join('\n');

    return rules ? `<style>\n${rules}\n</style>` : '';
}
