/**
 * Colour measurement — luminance, contrast, and the readable-foreground choice.
 *
 * These lived in three places at once: `hexLuminance` in html.ts (for the hex
 * chips), `luminance`/`contrast` in css.ts (for the palette scheme classes), and
 * `isDarkSurface` in css.ts (for picking a highlight.js theme). The first two
 * were the same WCAG formula written twice with different sRGB cutoffs and
 * different hex parsers; the third answered the same question — "is this surface
 * dark?" — with an uncorrected weighted average, so it disagreed with the others
 * across a band of mid-greys.
 *
 * One implementation, one parser, one threshold.
 */

/**
 * Splits a CSS hex colour into 0–255 channels, or null if it is not one.
 *
 * Accepts every form the rest of the tool emits — `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, with or without the leading `#`. Any alpha channel is dropped:
 * these measurements describe a colour, and what it composites onto is not
 * knowable here.
 */
export function parseHexChannels(color: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
    if (!m) return null;

    const h = m[1].length <= 4
        ? [...m[1].slice(0, 3)].map(c => c + c).join('')   // #rgb / #rgba → #rrggbb
        : m[1].slice(0, 6);                                 // drop any alpha pair

    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

/**
 * Relative luminance (WCAG 2.x / sRGB), 0 for black to 1 for white.
 *
 * Returns NaN for anything that is not a hex colour, so callers must decide what
 * an unmeasurable colour means rather than silently getting 0 (which would read
 * as "black", the most consequential wrong answer available).
 */
export function relativeLuminance(color: string): number {
    const rgb = parseHexChannels(color);
    if (!rgb) return NaN;

    const lin = rgb.map(c => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Luminance below which a surface is treated as dark.
 *
 * 0.179 is the standard sRGB midpoint for this decision — the luminance at which
 * black and white text score equal contrast against the background — and is the
 * value the hex-chip code already used to pick its foreground. Applying it to
 * the highlight.js surface test too is what makes the two agree.
 *
 * It is NOT 0.5: relative luminance is gamma-corrected, so mid-grey `#808080`
 * sits at 0.216, not halfway. The uncorrected `luma < 128` rule this replaces
 * called everything below roughly `#7f7f7f` dark; the two agree on every
 * background any shipped theme declares, and differ only across a narrow band of
 * mid-greys where the corrected answer is the defensible one.
 */
export const DARK_SURFACE_LUMINANCE = 0.179;

/** Whether a colour reads as a dark surface. Unparseable input is not dark. */
export function isDarkColor(color: string): boolean {
    const l = relativeLuminance(color);
    return Number.isFinite(l) && l < DARK_SURFACE_LUMINANCE;
}

/** Near-black or white, whichever stays legible on the given background. */
export function readableTextOn(background: string): string {
    return isDarkColor(background) ? '#ffffff' : '#1a1a1a';
}
