/**
 * Makes AntV Infographic's SSR output printable by WeasyPrint.
 *
 * Pure string work with the text measurer injected, so every rule here is
 * testable without the library, the worker, or a font.
 *
 * Three things in the raw output do not survive WeasyPrint, each verified by
 * rendering the library's own output through it:
 *
 *  - **Text lives in `<foreignObject>`.** Every label, description and value is
 *    an HTML `<span>` inside one — 1,616 of them across the 276 built-in
 *    templates, each a single span — and WeasyPrint draws none of them. The
 *    shapes survive; every word is lost. {@link convertForeignObjects} rebuilds
 *    each one as native `<text>`, carrying over the span's colour, size, weight
 *    and flex alignment, and wrapping lines against real font metrics.
 *  - **Remote font stylesheets.** The output opens with `<?xml-stylesheet>`
 *    processing instructions pointing at Ant Group's font CDN. This repo's
 *    diagram renderers do not reach the network, so they are removed.
 *  - **Alibaba PuHuiTi.** The font those stylesheets would have loaded. With them
 *    gone, text is set in {@link INFOGRAPHIC_FONT_STACK} — which is also the font
 *    the wrapping is measured in, so a line that fits is a line that fits.
 */

import { attrOf, attrPattern } from './attributes';
import { literal } from './strings';

/** The stack every infographic's text is set in, and measured in. */
export const INFOGRAPHIC_FONT_STACK = "Arial, Helvetica, 'Liberation Sans', sans-serif";

/**
 * Arial's ascender and descender, as fractions of the em. Used to place the
 * first baseline inside a CSS line box the way a browser would: half-leading
 * above, then the ascender.
 */
const ASCENT  = 0.905;
const DESCENT = 0.212;

/**
 * The metric data available without a browser is Arial Regular only. Bold Arial
 * sets roughly 5–10% wider, so when bold text has to wrap it is measured this
 * much wider, and a wrapped line really fits its box.
 */
export const BOLD_WIDTH_FACTOR = 1.08;

/**
 * How the library sizes a box around text it measured: regular-weight widths,
 * bold text included, plus 1.5% (its `FONT_EXTEND_FACTOR`).
 */
const LIBRARY_WIDTH_FACTOR = 1.015;

/** Width in px of `text` at `fontSize`, in Arial Regular. */
export type MeasureText = (text: string, fontSize: number) => number;

/** A line may overrun its box by this much before it wraps — browser rounding. */
const FIT_TOLERANCE_PX = 0.5;

/**
 * Whitespace a line may break at: all of it except the no-break spaces. `\s`
 * alone includes U+00A0, so `10&nbsp;ms` would wrap where a browser never does.
 */
const BREAKABLE_SPACE = /[^\S\u00a0\u2007\u202f]+/;

/** Removes every `<?…?>` processing instruction: the XML prologue and the font stylesheets. */
export function stripProcessingInstructions(svg: string): string {
    return svg.replace(/<\?[\s\S]*?\?>\s*/g, '');
}

/**
 * Sets every `font-family` attribute to {@link INFOGRAPHIC_FONT_STACK}, or to
 * `family` ahead of it when the theme asked for a font this tool ships.
 *
 * The name is quoted: a CSS identifier may not start with a digit, and the one
 * font a built-in theme asks for is `851tegakizatsu`. Unquoted, the whole
 * declaration is invalid and a browser falls back to its default serif — not
 * even to Arial.
 */
export function normalizeFontFamily(svg: string, family?: string): string {
    const stack = family ? `'${family}', ${INFOGRAPHIC_FONT_STACK}` : INFOGRAPHIC_FONT_STACK;
    return svg.replace(attrPattern('font-family', 'gi'), literal(` font-family="${stack}"`));
}

/**
 * Embeds `css` in the SVG's own `<defs>`.
 *
 * Inside the SVG rather than in the page's stylesheet, because a browser renders
 * an `<img>`-embedded SVG as a separate document that the page's CSS cannot
 * reach. WeasyPrint accepts either; this one placement serves both outputs.
 */
export function injectStyle(svg: string, css: string): string {
    return svg.replace(/<svg\b[^>]*>/, tag => `${tag}<defs><style>${css}</style></defs>`);
}

/** A `style="…"` attribute value as a map of lowercased property to value. */
export function parseInlineStyle(style: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of style.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim().toLowerCase();
        if (prop) out[prop] = decl.slice(i + 1).trim();
    }
    return out;
}

/** Decodes the entities an SVG serializer emits in text content. */
export function decodeEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g,          (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, '\u00a0')
        .replace(/&amp;/g, '&');
}

/** Escapes for text content and for a double-quoted attribute value alike. */
function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `font-weight` as SVG accepts it, and whether it measures as bold.
 *
 * The library emits `regular` and `medium`, which are font style names rather
 * than CSS weights; WeasyPrint would ignore them.
 */
export function normalizeFontWeight(raw: string | undefined): { weight: string; bold: boolean } {
    const v = (raw ?? '').trim().toLowerCase();
    if (!v || v === 'normal' || v === 'regular') return { weight: 'normal', bold: false };
    if (v === 'medium')                          return { weight: '500',    bold: false };
    if (v === 'bold' || v === 'bolder')          return { weight: 'bold',   bold: true  };
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? { weight: 'normal', bold: false } : { weight: String(n), bold: n >= 600 };
}

/**
 * Wraps `text` into lines no wider than `maxWidth`.
 *
 * Mirrors the span's `white-space: pre-wrap; word-break: break-word`: explicit
 * newlines always break, words wrap at spaces, and a single word wider than the
 * box is broken between characters rather than allowed to overflow. A
 * non-positive `maxWidth` means "no box to fit" and wraps only at newlines.
 */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string[] {
    const fits = (s: string) => width(s) <= maxWidth + FIT_TOLERANCE_PX;
    const lines: string[] = [];

    for (const paragraph of text.split('\n')) {
        if (!(maxWidth > 0)) { lines.push(paragraph.trim()); continue; }

        let line = '';
        for (const word of paragraph.split(BREAKABLE_SPACE).filter(Boolean)) {
            const candidate = line ? `${line} ${word}` : word;
            if (fits(candidate)) { line = candidate; continue; }
            if (line) { lines.push(line); line = ''; }
            if (fits(word)) { line = word; continue; }

            // A word wider than the box: break it between characters.
            let chunk = '';
            for (const ch of Array.from(word)) {
                if (chunk && !fits(chunk + ch)) { lines.push(chunk); chunk = ''; }
                chunk += ch;
            }
            line = chunk;
        }
        lines.push(line);
    }
    return lines;
}

/**
 * {@link wrapText} for bold text, given Arial Regular widths.
 *
 * Many boxes are not fixed slots but were sized by the library around the text
 * they hold — measured, bold or not, at regular weight. A bold label in such a
 * box is too wide by bold's own measure, yet was meant as one line, and wrapping
 * it pushes a second line out of a box one line tall. So a paragraph that fits at
 * regular width, as the library measured it, stays whole, overhanging by the few
 * percent bold adds; one that does not wraps at bold width, so each line it wraps
 * to fits. Across the 276 built-in templates this cuts the text boxes whose
 * wrapped lines no longer fit from 41 to 19, and every one left is a fixed slot
 * holding more text than it was designed for.
 */
export function wrapBoldText(text: string, maxWidth: number, regularWidth: (s: string) => number): string[] {
    return text.split('\n').flatMap(paragraph => {
        const whole = paragraph.split(BREAKABLE_SPACE).filter(Boolean).join(' ');
        return regularWidth(whole) * LIBRARY_WIDTH_FACTOR <= maxWidth + FIT_TOLERANCE_PX
            ? [whole]
            : wrapText(paragraph, maxWidth, s => regularWidth(s) * BOLD_WIDTH_FACTOR);
    });
}

const round = (v: number): string => String(Number(v.toFixed(2)));

/**
 * Rebuilds every `<foreignObject><span style="…">text</span></foreignObject>`
 * as native SVG `<text>`.
 *
 * Placement follows the span's own flex layout: `text-align` (or, failing that,
 * `justify-content`) picks the anchor, and `align-items` / `align-content` puts
 * the block of lines at the top, middle or bottom of the foreignObject's box.
 * Each line's baseline is where a browser would put it — half-leading, then the
 * ascender — so converted text sits where the original did.
 *
 * The `<text>` replaces the foreignObject in place, so it inherits the same
 * ancestor transforms. An empty span is dropped rather than left as an empty
 * element.
 */
export function convertForeignObjects(svg: string, measure: MeasureText): string {
    return svg.replace(/<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/g, (_m, attrs: string, inner: string) => {
        const tag = `<foreignObject${attrs}>`;
        const num = (name: string): number => parseFloat(attrOf(tag, name) ?? '') || 0;
        const x = num('x'), y = num('y'), w = num('width'), h = num('height');

        const span = /<span\b([^>]*)>([\s\S]*?)<\/span>/i.exec(inner);
        const style = parseInlineStyle(span ? (attrOf(`<span${span[1]}>`, 'style') ?? '') : '');
        const text = decodeEntities((span ? span[2] : inner)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ''));
        if (!text.trim()) return '';

        const fontSize = parseFloat(style['font-size'] ?? '') || 14;
        const lh = style['line-height'] ?? '';
        const lineHeight = /px$/i.test(lh) ? parseFloat(lh)
                         : (parseFloat(lh) > 0 ? parseFloat(lh) * fontSize : 1.2 * fontSize);
        const { weight, bold } = normalizeFontWeight(style['font-weight']);

        const regular = (s: string): number => measure(s, fontSize);
        const lines = bold ? wrapBoldText(text, w, regular) : wrapText(text, w, regular);

        const horizontal = style['text-align'] ?? style['justify-content'] ?? 'left';
        const anchor = /center/.test(horizontal)            ? 'middle'
                     : /right|end/.test(horizontal)          ? 'end'
                     : 'start';
        const ax = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w : x;

        const vertical = style['align-items'] ?? style['align-content'] ?? 'flex-start';
        const blockH = lines.length * lineHeight;
        const top = /center/.test(vertical) ? y + (h - blockH) / 2
                  : /end/.test(vertical)    ? y + h - blockH
                  : y;
        const firstBaseline = top + (lineHeight - (ASCENT + DESCENT) * fontSize) / 2 + ASCENT * fontSize;

        const tspans = lines.map((line, i) =>
            `<tspan x="${round(ax)}" y="${round(firstBaseline + i * lineHeight)}">${escapeXml(line)}</tspan>`).join('');

        const fill = style['color'] ? ` fill="${escapeXml(style['color'])}"` : '';
        return `<text font-size="${round(fontSize)}" font-weight="${weight}" text-anchor="${anchor}"`
             + ` font-family="${INFOGRAPHIC_FONT_STACK}"${fill}>${tspans}</text>`;
    });
}

/** A font the theme asked for and this tool ships: see infographic-fonts.ts. */
export interface EmbeddedFont {
    /** Family name, quoted first in every `font-family` the output carries. */
    family: string;
    /** The `@font-face` rule that carries it, as a data URI. */
    faceCss: string;
}

/**
 * Every transformation above, in the order they have to run.
 *
 * With a `font`, its face is embedded and its family leads the stack; `measure`
 * is then expected to measure in that font, so the wrapping still matches what
 * is drawn.
 */
export function postProcessInfographicSvg(raw: string, measure: MeasureText, font?: EmbeddedFont): string {
    const svg = normalizeFontFamily(convertForeignObjects(stripProcessingInstructions(raw), measure), font?.family);
    return font ? injectStyle(svg, font.faceCss) : svg;
}
