/**
 * The fonts an infographic theme may ask for, and which of them this tool ships.
 *
 * A theme can name a font: the built-in `hand-drawn` theme sets
 * `font-family: 851tegakizatsu`, and the library then expects it to arrive from
 * Ant Group's CDN through the `<?xml-stylesheet?>` instructions its output opens
 * with. Those are stripped — diagram renderers do not reach the network — so
 * without this module a hand-drawn diagram keeps its sketched shapes and sets
 * every word in Arial.
 *
 * So the font is bundled, as a Latin subset (53 KB of a 28.6 MB original; see
 * the NOTICE beside it for the licence that permits both), and embedded in the
 * SVG itself. That is the one placement both renderers honour: WeasyPrint reads
 * an `@font-face` from the document or from the SVG, but a browser treats an
 * `<img>`-embedded SVG as its own document, so a face in the page's CSS never
 * reaches it. The family name has to be **quoted** in `font-family` — a CSS
 * identifier may not start with a digit, and unquoted `851tegakizatsu` voids the
 * whole declaration, which is why Chrome fell back to its default serif rather
 * than to Arial.
 *
 * Anything not listed here is set in Arial, exactly as before.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A font this tool ships for a family an infographic theme may request. */
export interface BundledFont {
    /** The family as the library writes it into the SVG. */
    family: string;
    /** File under `assets/fonts/`. */
    file: string;
    /** The module under `measury/fonts/` whose metrics match it. */
    measury: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
    {
        family: '851tegakizatsu',
        file: '851tegakizatsu-Regular-latin.woff2',
        measury: 'measury/fonts/851tegakizatsu-Regular',
    },
];

/** Where the bundled fonts live, both in the repo and in a packaged copy. */
export const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

/**
 * The bundled font for one `font-family` value, or null.
 *
 * The value arrives as the library wrote it, so it may be quoted and may carry
 * fallbacks; only the first family is considered, since that is the one the
 * theme asked for.
 */
export function bundledFontFor(fontFamily: string | null | undefined): BundledFont | null {
    const first = (fontFamily ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    return BUNDLED_FONTS.find(f => f.family.toLowerCase() === first) ?? null;
}

/** The `@font-face` rule embedding `font` as a data URI, read from disk. */
export function fontFaceCss(font: BundledFont, read: (file: string) => Buffer = fs.readFileSync): string {
    const base64 = Buffer.from(read(path.join(FONT_DIR, font.file))).toString('base64');
    return `@font-face{font-family:"${font.family}";`
         + `src:url(data:font/woff2;base64,${base64}) format("woff2");`
         + `font-weight:normal;font-style:normal;}`;
}
