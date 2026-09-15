import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { BUNDLED_FONTS, FONT_DIR, bundledFontFor, fontFaceCss } from '../infographic-fonts';

describe('bundledFontFor', () => {
    it('matches the family the hand-drawn theme asks for', () => {
        assert.equal(bundledFontFor('851tegakizatsu')?.family, '851tegakizatsu');
    });

    it('reads through the quoting and the fallbacks around it', () => {
        assert.equal(bundledFontFor(`'851tegakizatsu', Arial, sans-serif`)?.family, '851tegakizatsu');
        assert.equal(bundledFontFor('"851tegakizatsu"')?.family, '851tegakizatsu');
        assert.equal(bundledFontFor('  851TEGAKIZATSU  ')?.family, '851tegakizatsu');
    });

    it('only considers the first family — the one the theme asked for', () => {
        assert.equal(bundledFontFor('Arial, 851tegakizatsu'), null);
    });

    it('is null for a font this tool does not ship', () => {
        for (const family of ['Alibaba PuHuiTi', 'Comic Sans MS', '', null, undefined]) {
            assert.equal(bundledFontFor(family), null, String(family));
        }
    });
});

describe('the bundled font files', () => {
    for (const font of BUNDLED_FONTS) {
        it(`${font.family} ships, with its licence notice beside it`, () => {
            const file = path.join(FONT_DIR, font.file);
            assert.ok(fs.existsSync(file), `${file} is missing`);

            // A subset, not the 28.6 MB original: it is embedded in every SVG
            // that uses it, so its size lands in every export.
            const kb = fs.statSync(file).size / 1024;
            assert.ok(kb < 200, `${font.file} is ${kb.toFixed(0)} KB — too large to embed per diagram`);

            // The licence permits redistribution only with attribution intact.
            const notice = file.replace(/\.woff2$/, '.NOTICE.md');
            assert.ok(fs.existsSync(notice), `${notice} is missing`);
            const text = fs.readFileSync(notice, 'utf8');
            assert.match(text, /pm85122\.onamae\.jp/, 'the notice must name where the font came from');
            assert.match(text, /再配布/, 'and quote the terms that allow shipping it');
        });

        it(`${font.family} has metrics to measure with`, async () => {
            // Without these the wrapping would be measured in Arial while the
            // glyphs are drawn in this font.
            const data = (await import(font.measury)).default;
            assert.equal(data.fontFamily, font.family);
            assert.ok(data.metrics.ascender > 0 && data.unitsPerEm > 0, 'usable metrics');
        });
    }
});

describe('fontFaceCss', () => {
    const font = BUNDLED_FONTS[0];

    it('embeds the file as a woff2 data URI under the family name', () => {
        const css = fontFaceCss(font, () => Buffer.from('FONTBYTES'));
        assert.equal(css,
            `@font-face{font-family:"${font.family}";`
            + `src:url(data:font/woff2;base64,${Buffer.from('FONTBYTES').toString('base64')}) format("woff2");`
            + 'font-weight:normal;font-style:normal;}');
    });

    it('reads the real file by default', () => {
        const css = fontFaceCss(font);
        assert.match(css, /^@font-face\{font-family:"851tegakizatsu";src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/);
        assert.ok(css.length > 10_000, 'a real font is embedded, not an empty file');
    });
});
