import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
    parseHexChannels, relativeLuminance, contrastRatio,
    isDarkColor, readableTextOn, DARK_SURFACE_LUMINANCE,
} from '../color';

describe('parseHexChannels', () => {
    it('reads a six-digit hex', () => {
        assert.deepEqual(parseHexChannels('#336699'), [0x33, 0x66, 0x99]);
    });

    it('expands a three-digit shorthand', () => {
        assert.deepEqual(parseHexChannels('#369'), [0x33, 0x66, 0x99]);
    });

    it('drops the alpha pair of an eight-digit hex', () => {
        assert.deepEqual(parseHexChannels('#33669980'), [0x33, 0x66, 0x99]);
    });

    it('drops the alpha nibble of a four-digit hex', () => {
        assert.deepEqual(parseHexChannels('#3698'), [0x33, 0x66, 0x99]);
    });

    it('tolerates a missing # and surrounding space', () => {
        assert.deepEqual(parseHexChannels('  336699 '), [0x33, 0x66, 0x99]);
    });

    it('returns null for anything that is not a hex colour', () => {
        for (const bad of ['', 'rebeccapurple', 'rgb(1,2,3)', '#12345', '#gggggg', 'var(--x)'])
            assert.equal(parseHexChannels(bad), null, bad);
    });
});

describe('relativeLuminance', () => {
    it('anchors at the endpoints', () => {
        assert.equal(relativeLuminance('#000000'), 0);
        assert.equal(relativeLuminance('#ffffff'), 1);
    });

    it('is gamma-corrected, so mid-grey is well below 0.5', () => {
        const mid = relativeLuminance('#808080');
        assert.ok(mid > 0.21 && mid < 0.22, `#808080 → ${mid}`);
    });

    it('weights green above red above blue', () => {
        assert.ok(relativeLuminance('#00ff00') > relativeLuminance('#ff0000'));
        assert.ok(relativeLuminance('#ff0000') > relativeLuminance('#0000ff'));
    });

    it('returns NaN — never 0 — for an unmeasurable colour', () => {
        // 0 would read as "black", the most consequential wrong answer available.
        assert.ok(Number.isNaN(relativeLuminance('not-a-colour')));
        assert.ok(Number.isNaN(relativeLuminance('')));
    });
});

describe('contrastRatio', () => {
    it('is 21:1 for black on white, either way round', () => {
        assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.001);
        assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.001);
    });

    it('is 1:1 for a colour against itself', () => {
        assert.ok(Math.abs(contrastRatio('#336699', '#336699') - 1) < 0.001);
    });

    it('agrees with the known WCAG value for a mid-tone pair', () => {
        // #767676 on white is the canonical "smallest grey that passes AA".
        assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5);
        assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
    });
});

describe('isDarkColor / readableTextOn', () => {
    it('classifies the obvious ends', () => {
        assert.equal(isDarkColor('#000000'), true);
        assert.equal(isDarkColor('#ffffff'), false);
    });

    it('treats an unparseable colour as not dark', () => {
        // A theme with no background declared must keep the light code theme.
        assert.equal(isDarkColor(''), false);
        assert.equal(isDarkColor('inherit'), false);
    });

    it('picks the foreground that stays legible', () => {
        assert.equal(readableTextOn('#000000'), '#ffffff');
        assert.equal(readableTextOn('#ffffff'), '#1a1a1a');
    });

    it('agrees with its own threshold', () => {
        assert.equal(isDarkColor('#767676'), relativeLuminance('#767676') < DARK_SURFACE_LUMINANCE);
    });
});

// ── The classification that ships ─────────────────────────────────────────────
//
// Consolidating three luminance helpers changed the dark-surface rule from an
// uncorrected `luma < 128` to gamma-corrected `L < 0.179`. They agree on every
// background any shipped theme declares — which is the claim this pins, so a
// future threshold change cannot silently flip a theme's code-block colours.

describe('shipped theme backgrounds', () => {
    const THEMES_DIR = path.join(__dirname, '..', '..', 'themes');

    /** Every `background` a theme declares, at theme level or on a named style. */
    function shippedBackgrounds(): Array<{ theme: string; background: string }> {
        if (!fs.existsSync(THEMES_DIR)) return [];
        const out: Array<{ theme: string; background: string }> = [];
        for (const entry of fs.readdirSync(THEMES_DIR, { withFileTypes: true })) {
            const manifest = path.join(THEMES_DIR, entry.name, 'theme.json');
            if (!fs.existsSync(manifest)) continue;
            const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
                background?: string;
                styles?: Record<string, { background?: string }>;
            };
            for (const bg of [m.background, ...Object.values(m.styles ?? {}).map(s => s.background)])
                if (bg) out.push({ theme: entry.name, background: bg });
        }
        return out;
    }

    it('every declared background classifies unambiguously', () => {
        const backgrounds = shippedBackgrounds();
        assert.ok(backgrounds.length > 0, 'expected at least one theme to declare a background');

        for (const { theme, background } of backgrounds) {
            if (!parseHexChannels(background)) continue;   // gradients etc. are not measured
            const l = relativeLuminance(background);
            // Not within 0.05 of the cutoff: a background that near the line
            // would make the light/dark code-theme choice a coin flip.
            assert.ok(
                Math.abs(l - DARK_SURFACE_LUMINANCE) > 0.05,
                `${theme}: ${background} sits at L=${l.toFixed(3)}, too close to the ${DARK_SURFACE_LUMINANCE} cutoff`,
            );
        }
    });

    it('matches the uncorrected rule it replaced, on every shipped background', () => {
        const legacyIsDark = (hex: string): boolean => {
            const rgb = parseHexChannels(hex)!;
            return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 128;
        };

        for (const { theme, background } of shippedBackgrounds()) {
            if (!parseHexChannels(background)) continue;
            assert.equal(
                isDarkColor(background), legacyIsDark(background),
                `${theme}: ${background} changed dark/light classification`,
            );
        }
    });
});
