import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    loadTheme,
    listThemes,
    listThemeEntries,
    setThemeRoots,
    themeRoots,
    themeRootsFromEnv,
    splitThemePath,
    THEME_PATH_ENV,
    setActiveTheme,
    applyStyleOverrides,
    applyLogoOverride,
    getActiveTheme,
    resolveStyle,
    resolveStyleMainColor,
    resolveColorValue,
    buildStyleOverrideCss,
    alpha,
    opaque,
    isColorLiteral,
    hasAlphaChannel,
    DEFAULT_THEME,
    THEMES_DIR,
} from '../theme';
import { buildThemeVarsCss } from '../css';
import { ExitError } from '../errors';
import type { Theme, PaletteRole } from '../types';

// A test-only theme with the same manifest capability shape as a full brand
// package (image style, slogan/address, named logos, split fonts, paletteRoles,
// paletteNames) so this suite doesn't have to load a shipped theme to exercise
// those code paths. Lives outside themes/, so it never appears in
// listThemes()/--theme.
const FIXTURE = path.join(__dirname, '..', '..', 'test-fixtures', 'theme');

/**
 * The colour a palette contributes for a document role, honouring the theme's
 * `paletteRoles` map. Mirrors theme.ts's internal lookup so the tests assert the
 * real contract — "the stop paletteRoles names" — rather than a pinned hex.
 */
function roleStop(theme: Theme, palette: string, role: PaletteRole): string {
    const stop = theme.paletteRoles[palette]?.[role] ?? role;
    return theme.palettes[palette][stop];
}

describe('alpha', () => {
    it('appends a two-digit hex alpha channel', () => {
        assert.equal(alpha('#009146', 1), '#009146ff');
        assert.equal(alpha('#009146', 0), '#00914600');
        assert.equal(alpha('#ec652f', 0.7), '#ec652fb3'); // 0.7*255 = 178.5 → 179 = b3
    });

    it('expands #rgb shorthand before appending the channel', () => {
        assert.equal(alpha('#abc', 1), '#aabbccff');
    });

    it('converts rgb() to rgba() rather than appending hex', () => {
        assert.equal(alpha('rgb(236,1,140)', 0.8), 'rgba(236, 1, 140, 0.8)');
        assert.equal(alpha('rgb(236 1 140)', 0.5), 'rgba(236, 1, 140, 0.5)');
        assert.equal(alpha('rgb(92%, 0%, 55%)', 0.8), 'rgba(92%, 0%, 55%, 0.8)');
    });

    it('leaves a colour that already carries alpha untouched — explicit wins', () => {
        // The whole point: a document writing #EC018C50 overrides the cover
        // overlay's 0.8 default instead of compounding into invalid CSS.
        assert.equal(alpha('#ec018c50', 0.8), '#ec018c50');
        assert.equal(alpha('#abcd', 0.8), '#abcd');
        assert.equal(alpha('rgba(236,1,140,0.5)', 0.8), 'rgba(236,1,140,0.5)');
        assert.equal(alpha('rgb(236 1 140 / 50%)', 0.8), 'rgb(236 1 140 / 50%)');
    });
});

describe('resolveColorValue', () => {
    before(() => setActiveTheme(FIXTURE));

    it('passes a validated literal through unchanged', () => {
        for (const c of ['#FFD84D', '#ffd', '#ffd84d80', 'rgb(255,216,77)', 'rgba(255,216,77,0.5)'])
            assert.equal(resolveColorValue(c), c);
    });

    it('resolves a palette name to that palette\'s document colour', () => {
        const theme = getActiveTheme();
        assert.equal(resolveColorValue('Muted'), roleStop(theme, 'Muted', 'main'));
        assert.equal(resolveColorValue('Brand'), roleStop(theme, 'Brand', 'main'));
    });

    it('trims surrounding whitespace', () => {
        assert.equal(resolveColorValue('  #FFD84D  '), '#FFD84D');
    });

    it('rejects an unknown name with ExitError(2)', () => {
        assert.throws(
            () => resolveColorValue('Chartreuse'),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2 && /Unknown colour/.test(e.message),
        );
    });

    it('rejects a malformed literal rather than treating it as a palette name', () => {
        assert.throws(
            () => resolveColorValue('#FFD84D5'),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2 && /Invalid colour/.test(e.message),
        );
    });
});

describe('colour literal helpers', () => {
    it('isColorLiteral accepts every CSS hex and rgb form', () => {
        for (const c of ['#abc', '#abcd', '#aabbcc', '#aabbccff', 'rgb(1,2,3)',
                         'RGBA(1, 2, 3, 0.5)', 'rgb(1 2 3 / 40%)'])
            assert.equal(isColorLiteral(c), true, c);
    });

    it('isColorLiteral rejects malformed literals and palette names', () => {
        for (const c of ['#ec018c5', '#gggggg', '#12345', 'rgb(1,2,3', 'Blackcurrant', 'Cherry'])
            assert.equal(isColorLiteral(c), false, c);
    });

    it('hasAlphaChannel distinguishes 4/8-digit hex and 4-component rgb', () => {
        assert.equal(hasAlphaChannel('#aabbcc'), false);
        assert.equal(hasAlphaChannel('#abc'), false);
        assert.equal(hasAlphaChannel('#aabbccff'), true);
        assert.equal(hasAlphaChannel('#abcd'), true);
        assert.equal(hasAlphaChannel('rgb(1,2,3)'), false);
        assert.equal(hasAlphaChannel('rgba(1,2,3,0.5)'), true);
        assert.equal(hasAlphaChannel('rgb(1 2 3 / 40%)'), true);
    });

    it('opaque strips the channel and leaves solid colours alone', () => {
        assert.equal(opaque('#ec018c50'), '#ec018c');
        assert.equal(opaque('#abcd'), '#abc');
        assert.equal(opaque('#ec018c'), '#ec018c');
        assert.equal(opaque('rgba(236, 1, 140, 0.5)'), 'rgb(236, 1, 140)');
        assert.equal(opaque('rgb(236 1 140 / 50%)'), 'rgb(236 1 140)');
        assert.equal(opaque('Blackcurrant'), 'Blackcurrant');
    });
});

describe('loadTheme (full-capability fixture)', () => {
    const theme = loadTheme(FIXTURE);

    it('resolves branding metadata', () => {
        assert.equal(theme.name, 'Test Fixture');
        assert.equal(theme.slogan, 'Fixture slogan for tests.');
        assert.ok(theme.address.length > 0);
    });

    it('resolves all asset paths to existing absolute files', () => {
        for (const p of [theme.logo, theme.logoWhite, theme.stylesheetFile,
                         theme.pageCssFile, theme.coverCssFile,
                         theme.coverHtmlFile, theme.revisionHtmlFile]) {
            assert.ok(path.isAbsolute(p), `${p} should be absolute`);
            assert.ok(fs.existsSync(p), `${p} should exist`);
        }
    });

    it('resolves body/heading font stacks from the manifest', () => {
        // The fixture sets headings and body in deliberately different families
        // — assert each on its own rather than assuming one face throughout.
        assert.match(theme.fontBody, /fixture-body-sans/);
        assert.match(theme.fontHeading, /fixture-heading-serif/);
    });

    it('builds style gradients and main colours from palette references', () => {
        const hero = theme.styles.Hero;
        assert.equal(hero.mainColor, roleStop(theme, 'Brand', 'main'));
        assert.ok(hero.gradient?.includes(alpha(roleStop(theme, 'Brand', 'main'), 0.7)));
        assert.ok(path.isAbsolute(hero.image!));
        assert.equal(hero.position, 0.3);
    });

    it('falls back to the default palette for styles without their own', () => {
        // Borrowed explicitly references the theme's default (Brand) palette.
        assert.equal(theme.styles.Borrowed.mainColor, roleStop(theme, 'Brand', 'main'));
    });

    it('draws the document colour from the stop paletteRoles names, not `main`', () => {
        // The point of paletteRoles: a ramp can be ordered so `main` isn't the
        // right document colour — paletteRoles picks the stop that actually is.
        assert.equal(theme.paletteRoles.Muted.main, 'medium');
        assert.equal(theme.styles.Muted.mainColor, theme.palettes.Muted.medium);
        assert.notEqual(theme.styles.Muted.mainColor, theme.palettes.Muted.main);
    });
});

describe('loadTheme errors', () => {
    it('throws ExitError(3) for an unknown theme', () => {
        assert.throws(() => loadTheme('does-not-exist'), (err: unknown) => {
            assert.ok(err instanceof ExitError);
            assert.equal((err as ExitError).exitCode, 3);
            return true;
        });
    });
});

describe('all built-in themes', () => {
    it('every theme loads and its required asset files exist', () => {
        for (const name of listThemes()) {
            const t = loadTheme(name);
            for (const p of [t.logo, t.logoWhite, t.stylesheetFile, t.pageCssFile,
                             t.coverCssFile, t.coverHtmlFile, t.revisionHtmlFile]) {
                assert.ok(fs.existsSync(p), `${name}: missing ${p}`);
            }
        }
    });

    /**
     * The generated abbreviation glossary is a table like any other, and must
     * look like the tables written in the same document. Every theme used to
     * carry a `.glossary-table` block that half-overrode its own table styling
     * — a larger font size, flush-left header cells, grey rules — so the
     * glossary was the one table that ignored the theme it was exported with.
     */
    it('no theme gives the glossary table a look of its own', () => {
        for (const name of listThemes()) {
            const css = fs.readFileSync(loadTheme(name).stylesheetFile, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '');
            assert.doesNotMatch(css, /\.glossary-table\b/, `${name}: styles .glossary-table`);
        }
    });

    /**
     * Tables are reading text, so every table uses the theme's body font. Two
     * places broke that. Platen put `table` in its sans-serif label stack, so its
     * tables alone left the body font. Every cover put the revision table and
     * the document-details rows in `--font-heading`, which only shows where the
     * heading font differs (Modern's Rubik against its Valley Sans body).
     */
    describe('every table uses the body font', () => {
        const rules = (file: string) => [...fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .map(([, selector, body]) => ({
                selector: selector.trim().replace(/\s+/g, ' '),
                font: /font-family\s*:\s*([^;]+)/.exec(body)?.[1].trim(),
            }))
            .filter(r => r.font !== undefined);

        it('no theme stylesheet sets a font on tables or the HTML banner revision table', () => {
            for (const name of listThemes()) {
                for (const { selector, font } of rules(loadTheme(name).stylesheetFile)) {
                    const elements = selector.replace(/[.#][\w-]+/g, '');
                    const table = /(^|[\s,>+~])(table|thead|tbody|tfoot|tr|th|td)\b/.test(elements)
                        || /\.html-banner-revisions\b/.test(selector);
                    assert.ok(!table, `${name}: theme.css sets font-family ${font} on "${selector}"`);
                }
            }
        });

        it('every cover sets its revision table and document-details rows in --font-body', () => {
            for (const name of listThemes()) {
                const cover = rules(loadTheme(name).coverCssFile);
                for (const part of [/\.revision-table\b|\.rev-center\b/, /\.cover-info-(table|label|value)\b/]) {
                    const matching = cover.filter(r => part.test(r.selector));
                    assert.ok(matching.length > 0, `${name}: cover.css sets no font for ${part}`);
                    for (const { selector, font } of matching) {
                        assert.match(font!, /^var\(--font-body\b/, `${name}: "${selector}" uses ${font}`);
                    }
                }
            }
        });
    });

    /**
     * The sample documents are the worked examples a new user copies from, and
     * they each open with the list of themes to choose between. That list drifted:
     * it named a theme that is not in this repository at all — an externally
     * linked one, symlinked into `themes/` and gitignored — while omitting a
     * theme that is. Anyone cloning the repo and following the sample therefore
     * chose a theme they did not have.
     *
     * `listThemes()` deliberately follows symlinks, because an externally linked
     * theme is a perfectly good theme to *use*. It is just not one this project
     * can *document*, since it is not in the checkout. That is the distinction
     * this asserts, and it is why the expected set is built from real
     * directories rather than from `listThemes()`.
     */
    it('every sample documents exactly the themes this repository ships', () => {
        const shipped = fs.readdirSync(THEMES_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.isSymbolicLink()
                && fs.existsSync(path.join(THEMES_DIR, d.name, 'theme.json')))
            .map(d => d.name)
            .sort();

        assert.ok(shipped.length >= 2, 'expected several shipped themes');

        for (const theme of shipped) {
            const [sample] = fs.readdirSync(path.join(THEMES_DIR, theme))
                .filter(f => f.startsWith('sample ') && f.endsWith('.md'));
            assert.ok(sample, `${theme}: no sample document`);

            const text = fs.readFileSync(path.join(THEMES_DIR, theme, sample), 'utf8');
            // The `# Brand package — see --list-themes` banner: the comment lines
            // that follow it, each a `|`-separated run of theme names.
            const banner = /# Brand package[^\n]*\n((?:#[^\n]*\n)+)/.exec(text);
            assert.ok(banner, `${theme}: no theme-list banner in ${sample}`);

            const listed = banner[1]
                .split('\n')
                .flatMap(l => l.replace(/^#\s*/, '').split('|'))
                .map(s => s.trim())
                .filter(Boolean)
                .sort();

            assert.deepEqual(listed, shipped, `${sample}: theme list is out of date`);
        }
    });

    it('the merged mixu theme shares one neutral base stylesheet; per-style colour comes from the style override', () => {
        const t = loadTheme('mixu');
        assert.equal(t.name, 'Mixu');
        const css = fs.readFileSync(t.stylesheetFile, 'utf8');
        assert.match(css, /\.admonition-note/);              // full structural base inlined
        assert.match(css, /--brand-main:\s*var\(--neutral-main\)/); // base brand colour is neutral, not per-variant
        assert.equal(t.styles.Page.mainColor, '#222222');
        // The variant's colours now live in the style override block, not the base CSS.
        setActiveTheme('mixu');
        const override = buildStyleOverrideCss('Page');
        assert.match(override, /--brand-main: #222222/);
        assert.match(override, /--link-color: #3399cc/);
    });

    // `paletteNames` replaced a hardcoded table in css.ts that named one private
    // theme's palettes, so every checkout of the exporter carried that theme's
    // vocabulary. The mechanism it replaced was never tested — which is how the
    // special case survived — so it is locked down here from both ends: a palette
    // that declares nothing still slugs to its lowercased name, and one that
    // declares a slug and an alias gets both, in the variables AND the classes.
    it('paletteNames renames a palette\'s CSS slug and adds scheme-class aliases', () => {
        setActiveTheme(FIXTURE);
        const css = buildThemeVarsCss();

        // Declared: slug "quiet" replaces the lowercased "muted", everywhere.
        assert.match(css, /--quiet-main:/);
        assert.match(css, /--gradient-quiet:/);
        assert.doesNotMatch(css, /--muted-main:/);

        // Undeclared palettes are untouched — the default is still the lowercased name.
        assert.match(css, /--brand-main:/);

        // The scheme class carries the slug and every declared alias, so a
        // document written against the upstream project's spelling still matches.
        assert.match(css, /\.theme-quiet-scheme/);
        assert.match(css, /\.theme-MutedUpstream-scheme/);
        assert.match(css, /\.theme-brand-scheme/);
    });

    it('a merged theme applies per-style typography, background and a web-font import', () => {
        setActiveTheme('jasonm23');
        applyStyleOverrides('Foghorn');
        assert.match(getActiveTheme().fontBody, /Vollkorn/);         // style overrides the theme body font
        const override = buildStyleOverrideCss('Foghorn');
        assert.match(override, /@import url\("https:\/\/fonts\.googleapis\.com[^"]*Vollkorn/);
        assert.match(override, /--link-color: #2484c1/);

        // A style without its own background leaves the (white) theme default untouched…
        setActiveTheme('jasonm23');
        applyStyleOverrides('Foghorn');
        assert.equal(getActiveTheme().background, '');
        // …while one that declares a background applies it.
        setActiveTheme('jasonm23');
        applyStyleOverrides('Dark');
        assert.equal(getActiveTheme().background, '#000000');
    });

    it('a { Name, Image } style layers the named style\'s main colour over the image (flat 80% wash by default) and still applies its overrides', () => {
        setActiveTheme('jasonm23');
        const style = { name: 'Foghorn', image: 'https://example.com/hero.jpg', color: null, position: null };
        const r = resolveStyle(style);
        assert.equal(r.imageSource, 'https://example.com/hero.jpg');     // document hero retained
        const pal = loadTheme('jasonm23').palettes.Foghorn;
        assert.equal(r.gradient, `linear-gradient(150deg, ${alpha(pal.main, 0.8)} 0%, ${alpha(pal.main, 0.8)} 90%)`);
        assert.equal(resolveStyleMainColor(style), pal.main);            // heading tint from the named style
        applyStyleOverrides(style);
        assert.match(getActiveTheme().fontBody, /Vollkorn/);             // per-style font still applied
        assert.match(buildStyleOverrideCss(style), /--link-color: #2484c1/);
    });

    it('a { Name, Image, Overlay } style uses the custom [start, end] range instead of the flat 80% default', () => {
        setActiveTheme('jasonm23');
        const style = { name: 'Foghorn', image: 'https://example.com/hero.jpg', color: null, position: null, overlay: [0.3, 0.9] as [number, number] };
        const r = resolveStyle(style);
        const pal = loadTheme('jasonm23').palettes.Foghorn;
        assert.equal(r.gradient, `linear-gradient(150deg, ${alpha(pal.main, 0.3)} 0%, ${alpha(pal.main, 0.9)} 90%)`);
    });

    it('the github theme uses GitHub colours in the shared theme structure', () => {
        const css = fs.readFileSync(loadTheme('github').stylesheetFile, 'utf8');
        assert.match(css, /#0969da/);                 // GitHub link blue
        assert.match(css, /#1f2328/);                 // GitHub body/heading text
        // Shared structure (same sections as the master) is present:
        assert.match(css, /nav\.toc a::after/);        // TOC dot leader + page numbers
        assert.match(css, /target-counter\(attr\(href\), page\)/);
        assert.match(css, /\.admonition-note/);       // admonitions
        assert.match(css, /\.markdown-alert-note/);   // GitHub alerts
        assert.match(css, /\.glossary-section/);      // glossary
        // The 2600-line vendored github-markdown-css blob is gone. The colour
        // assertion above is the real check; this line count is a coarse
        // backstop, sized to leave room for the shared feature CSS every theme
        // carries (kbd, markdown extras, numbering, captions, watermark, …)
        // while still catching a re-vendored blob by an order of magnitude.
        assert.doesNotMatch(css, /#0d1117/);          // no vendored dark blob
        assert.ok(css.split('\n').length < 800, 'github theme.css should be lean');
    });

    it('the solarized theme resolves a white header logo and per-style dark/light backgrounds', () => {
        const t = loadTheme('solarized');
        assert.match(t.logo, /logo-white\.svg$/);
        setActiveTheme('solarized');
        applyStyleOverrides('Dark');
        assert.equal(getActiveTheme().background, '#002b36');
        setActiveTheme('solarized');
        applyStyleOverrides('Light');
        assert.equal(getActiveTheme().background, '#fdf6e3');
    });
});

describe('font sizes', () => {
    it('defaults body to 9pt and headings to an em scale', () => {
        const t = loadTheme('default');
        assert.equal(t.fontSizes.body, '9pt');
        assert.equal(t.fontSizes.h1, '2em');
        assert.equal(t.fontSizes.h6, '0.75em');
    });

    it('honours a fontSize override from the manifest', () => {
        const t = loadTheme('witex');
        assert.equal(t.fontSizes.body, '11pt');
    });
});

describe('listThemes', () => {
    it('includes all built-in themes', () => {
        const themes = listThemes();
        for (const name of ['modern', 'default', 'gaia', 'uncover'])
            assert.ok(themes.includes(name), `missing theme: ${name}`);
    });
});

describe('Marp-derived themes (gaia, uncover)', () => {
    it('gaia: Lato body font and #0288d1 accent', () => {
        const t = loadTheme('gaia');
        assert.equal(t.name, 'Gaia');
        assert.match(t.fontBody, /Lato/);
        assert.equal(t.styles.Gaia.mainColor, '#0288d1');
    });

    it('uncover: system body font and #009dd5 accent', () => {
        const t = loadTheme('uncover');
        assert.equal(t.name, 'Uncover');
        assert.match(t.fontBody, /-apple-system/);
        assert.equal(t.styles.Uncover.mainColor, '#009dd5');
    });
});

describe('loadTheme (built-in default)', () => {
    const theme = loadTheme(DEFAULT_THEME);

    it('is the Marp-aligned default theme', () => {
        assert.equal(theme.name, 'Default');
        assert.equal(theme.defaultPalette, 'Navy');
        assert.equal(theme.slogan, '');
        assert.deepEqual(theme.address, []);
    });

    it('resolves required assets and uses no network fonts', () => {
        for (const p of [theme.logo, theme.logoWhite, theme.stylesheetFile,
                         theme.pageCssFile, theme.coverCssFile,
                         theme.coverHtmlFile, theme.revisionHtmlFile]) {
            assert.ok(fs.existsSync(p), `${p} should exist`);
        }
        assert.equal(theme.fallbackFonts.length, 0);
    });

    it('builds colour-only styles (no hero image)', () => {
        assert.equal(theme.styles.Navy.mainColor, '#224466');
        assert.equal(theme.styles.Blue.image, undefined);
        assert.ok(theme.styles.Blue.gradient?.includes(theme.palettes.Blue.main));
    });

    it('uses the Marp default font stack', () => {
        assert.match(theme.fontBody, /Helvetica Neue/);
    });
});

describe('external theme directory', () => {
    let dir: string;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-theme-test-'));
        fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
        fs.writeFileSync(path.join(dir, 'page.css'), '@page{}');
        fs.writeFileSync(path.join(dir, 'cover.css'), '.cover-page{width:210mm;height:297mm}');
        fs.writeFileSync(path.join(dir, 'cover.html'), '<body></body>');
        fs.writeFileSync(path.join(dir, 'revision.html'), '<body></body>');
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
            name: 'Acme',
            logo: 'logo.svg',
            logoWhite: 'logo.svg',
            css: { stylesheet: 'style.css', page: 'page.css', cover: 'cover.css' },
            html: { cover: 'cover.html', revision: 'revision.html' },
            defaultPalette: 'brand',
            palettes: { brand: { extraLight: '#eef', light: '#99f', main: '#0000ff', regular: '#22f', medium: '#55f', dark: '#00a', extraDark: '#005' } },
            styles: { hero: { color: '#123456' } },
        }));
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('loads a theme from an arbitrary directory path', () => {
        const t = loadTheme(dir);
        assert.equal(t.name, 'Acme');
        assert.equal(t.styles.hero.mainColor, '#123456');
        assert.equal(t.defaultPalette, 'brand');
        // No fontFamily in this manifest → falls back to a system stack.
        assert.match(t.fontBody, /system-ui/);
        assert.equal(t.fontHeading, t.fontBody);
    });
});

describe('style resolution (active theme)', () => {
    before(() => setActiveTheme(FIXTURE));

    it('resolves a named style to image/position/gradient', () => {
        const r = resolveStyle('Hero');
        assert.ok(r.imageSource?.endsWith(path.join('hero', 'photo.png')));
        assert.equal(r.position, 0.3);
        assert.ok(r.gradient?.startsWith('linear-gradient'));
    });

    it('resolves an inline hex-colour style', () => {
        const r = resolveStyle({ color: '#abcdef', image: null, position: null });
        assert.equal(r.imageSource, null);
        assert.ok(r.gradient?.includes('#abcdef'));
    });

    it('washes a cover photo at 80% for a colour with no alpha of its own', () => {
        const r = resolveStyle({ color: '#ec018c', image: 'hero.jpg', position: null });
        assert.equal(r.gradient, 'linear-gradient(150deg, #ec018ccc 0%, #ec018ccc 90%)');
    });

    it('an explicit alpha channel overrides the 80% wash', () => {
        const r = resolveStyle({ color: '#ec018c50', image: 'hero.jpg', position: null });
        // Not #ec018c50cc — that is invalid CSS and blanks the whole cover.
        assert.equal(r.gradient, 'linear-gradient(150deg, #ec018c50 0%, #ec018c50 90%)');
    });

    it('accepts rgb() and applies the same 80% wash over a photo', () => {
        const r = resolveStyle({ color: 'rgb(236,1,140)', image: 'hero.jpg', position: null });
        assert.equal(r.gradient, 'linear-gradient(150deg, rgba(236, 1, 140, 0.8) 0%, rgba(236, 1, 140, 0.8) 90%)');
    });

    it('accepts rgba() and lets its alpha override the wash', () => {
        const r = resolveStyle({ color: 'rgba(236,1,140,0.31)', image: 'hero.jpg', position: null });
        assert.equal(r.gradient, 'linear-gradient(150deg, rgba(236,1,140,0.31) 0%, rgba(236,1,140,0.31) 90%)');
    });

    it('leaves a colour at full strength when there is no photo to wash', () => {
        for (const color of ['#ec018c', 'rgb(236,1,140)']) {
            const r = resolveStyle({ color, image: null, position: null });
            const full = alpha(color, 1);
            assert.equal(r.gradient, `linear-gradient(150deg, ${full} 0%, ${full} 90%)`);
        }
    });

    it('a custom [start, end] Overlay applies even without an image', () => {
        const r = resolveStyle({ color: '#ec018c', image: null, position: null, overlay: [0.5, 0.9] as [number, number] });
        assert.equal(r.gradient, `linear-gradient(150deg, ${alpha('#ec018c', 0.5)} 0%, ${alpha('#ec018c', 0.9)} 90%)`);
    });

    it('a custom [start, end] Overlay applies to a palette-name colour', () => {
        const pal = loadTheme(FIXTURE).palettes.Muted;
        const r = resolveStyle({ color: 'Muted', image: 'hero.jpg', position: null, overlay: [0.2, 0.6] as [number, number] });
        // paletteRoles.Muted.main -> "medium" stop
        assert.equal(r.gradient, `linear-gradient(150deg, ${alpha(pal.medium, 0.2)} 0%, ${alpha(pal.medium, 0.6)} 90%)`);
    });

    it('strips alpha from the heading/table colour — the wash is cover-only', () => {
        assert.equal(resolveStyleMainColor({ color: '#ec018c50', image: null, position: null }), '#ec018c');
        assert.equal(resolveStyleMainColor({ color: 'rgba(236,1,140,0.5)', image: null, position: null }), 'rgb(236, 1, 140)');
        assert.ok(!buildStyleOverrideCss({ color: '#ec018c50', image: null, position: null }).includes('#ec018c50'));
    });

    it('rejects a malformed literal instead of silently blanking the cover', () => {
        for (const color of ['#ec018c5', 'rgb(236,1,140']) {
            assert.throws(
                () => resolveStyle({ color, image: null, position: null }),
                (e: unknown) => e instanceof ExitError && /Invalid colour/.test(e.message),
                color,
            );
        }
        // A bare word is still a palette name, and still reports as one.
        assert.throws(
            () => resolveStyle({ color: 'Nonsense', image: null, position: null }),
            /Unknown style colour name/,
        );
    });

    it('resolveStyleMainColor: named style → the palette\'s document colour', () => {
        // Derived from the manifest, not hardcoded, so an intentional palette
        // change here doesn't look like a logic regression.
        const theme = getActiveTheme();
        assert.equal(resolveStyleMainColor('Hero'), roleStop(theme, 'Brand', 'main'));
        // Borrowed draws from the theme's default (Brand) palette rather than
        // one named after itself.
        assert.equal(resolveStyleMainColor('Borrowed'), roleStop(theme, 'Brand', 'main'));
        assert.equal(resolveStyleMainColor(null), null);
    });

    it('buildStyleOverrideCss emits the resolved colour or empty string', () => {
        const heroMain = roleStop(getActiveTheme(), 'Brand', 'main');
        assert.ok(buildStyleOverrideCss('Hero').includes(heroMain));
        assert.equal(buildStyleOverrideCss(null), '');
    });
});

describe('applyLogoOverride', () => {
    // Each case re-loads the theme: the override mutates the active singleton.
    beforeEach(() => setActiveTheme(FIXTURE));

    it('null leaves the theme logo untouched', () => {
        const before = getActiveTheme().logo;
        applyLogoOverride(null);
        assert.equal(getActiveTheme().logo, before);
    });

    it('resolves a named logo from the manifest map', () => {
        applyLogoOverride('Alt');
        const theme = getActiveTheme();
        assert.equal(theme.logo, theme.logos.Alt);
        // Suite marks have no white variant — both slots get the same file.
        assert.equal(theme.logoWhite, theme.logos.Alt);
    });

    it('matches named logos case-insensitively', () => {
        applyLogoOverride('aLt');
        const theme = getActiveTheme();
        assert.equal(theme.logo, theme.logos.Alt);
    });

    it('accepts a path relative to the theme directory', () => {
        applyLogoOverride('logos/alt-logo.svg');
        assert.ok(getActiveTheme().logo.endsWith(
            path.join('logos', 'alt-logo.svg'),
        ));
    });

    it('is independent of the active style', () => {
        // The whole point of the key: an Alt mark on a Hero-styled cover.
        applyStyleOverrides('Hero');
        applyLogoOverride('Alt');
        const theme = getActiveTheme();
        assert.equal(theme.logo, theme.logos.Alt);
    });

    it('throws ExitError(3) for an unknown name rather than falling back', () => {
        // A silent fallback would ship the wrong brand mark on a deliverable.
        assert.throws(
            () => applyLogoOverride('NotARealSuite'),
            (err: unknown) => err instanceof ExitError && err.exitCode === 3,
        );
    });
});

describe('cover sizing follows the configured page size', () => {
    it('no theme hardcodes A4 for the cover box', () => {
        // A hardcoded 210mm x 297mm cover leaves the whole cover in an
        // A4-sized corner of any larger sheet (reported on A3).
        for (const name of listThemes()) {
            const css = fs.readFileSync(loadTheme(name).coverCssFile, 'utf8');
            const box = /\.cover-page\s*\{[^}]*\}/.exec(css);
            assert.ok(box, `${name}: .cover-page rule not found`);
            assert.match(box[0], /width:\s*var\(--page-width/,
                `${name}: cover width should track --page-width`);
            assert.match(box[0], /height:\s*var\(--page-height/,
                `${name}: cover height should track --page-height`);
        }
    });
});

// ── External theme roots ──────────────────────────────────────────────────────

/**
 * `--theme /abs/path` always worked; *discovery* did not. `listThemes` read only
 * the bundled directory, so an external theme could be exported with but never
 * listed, picked from a menu or validated — and `--list-themes` said it did not
 * exist. That is fine for one person with a path in their fingers and useless
 * for the settings UI, which is what these roots are for.
 */
describe('external theme roots', () => {
    let dir: string;
    /** A minimal-but-real theme, copied from the bundled default under a new name. */
    const plant = (root: string, name: string): string => {
        const target = path.join(root, name);
        fs.cpSync(path.join(THEMES_DIR, 'default'), target, { recursive: true });
        const manifestPath = path.join(target, 'theme.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name: string };
        m.name = name;
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        return target;
    };

    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-roots-')); });
    after(()  => { fs.rmSync(dir, { recursive: true, force: true }); setThemeRoots([]); });
    afterEach(() => setThemeRoots([]));

    it('finds nothing extra when no root is registered', () => {
        setThemeRoots([]);
        assert.deepEqual(listThemeEntries().filter(e => e.source === 'external'), []);
    });

    it('lists a theme under a registered root', () => {
        const root = path.join(dir, 'r1');
        fs.mkdirSync(root, { recursive: true });
        plant(root, 'acme');
        setThemeRoots([root]);

        const external = listThemeEntries().filter(e => e.source === 'external');
        assert.equal(external.length, 1);
        assert.equal(external[0].name, 'acme');
        assert.equal(external[0].dir, path.join(root, 'acme'));
        assert.ok(listThemes().includes('acme'));
    });

    it('still lists the built-ins alongside', () => {
        const root = path.join(dir, 'r2');
        fs.mkdirSync(root, { recursive: true });
        plant(root, 'acme2');
        setThemeRoots([root]);
        assert.ok(listThemes().includes('default'), 'a registered root must not hide the built-ins');
    });

    it('loads an external theme by name', () => {
        const root = path.join(dir, 'r3');
        fs.mkdirSync(root, { recursive: true });
        plant(root, 'acme3');
        setThemeRoots([root]);
        assert.equal(loadTheme('acme3').name, 'acme3');
    });

    it('lets an external theme shadow a built-in of the same name', () => {
        // Deliberate: registering a folder called `default` is how you override
        // the bundled one, and the opposite rule would make that impossible.
        const root = path.join(dir, 'r4');
        fs.mkdirSync(root, { recursive: true });
        const shadow = plant(root, 'default');
        setThemeRoots([root]);
        assert.equal(loadTheme('default').dir, shadow);
    });

    it('de-duplicates a name across roots without losing the built-in', () => {
        const root = path.join(dir, 'r5');
        fs.mkdirSync(root, { recursive: true });
        plant(root, 'default');
        setThemeRoots([root]);
        assert.equal(listThemes().filter(n => n === 'default').length, 1);
    });

    it('ignores a root that does not exist', () => {
        // An ordinary state for a path typed into a shared settings file months
        // ago; it must not fail a lookup the other roots would have answered.
        setThemeRoots([path.join(dir, 'gone')]);
        assert.doesNotThrow(() => listThemes());
        assert.ok(listThemes().includes('default'));
    });

    it('ignores a directory that holds no theme.json', () => {
        const root = path.join(dir, 'r6');
        fs.mkdirSync(path.join(root, 'not-a-theme'), { recursive: true });
        setThemeRoots([root]);
        assert.deepEqual(listThemeEntries().filter(e => e.source === 'external'), []);
    });

    it('names the roots it searched when a theme is missing', () => {
        const root = path.join(dir, 'r7');
        fs.mkdirSync(root, { recursive: true });
        setThemeRoots([root]);
        assert.throws(() => loadTheme('nope'), (err: unknown) => {
            assert.match((err as Error).message, /Searched:/);
            assert.match((err as Error).message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            return true;
        });
    });

    it('resolves the roots to absolute paths and drops duplicates', () => {
        const root = path.join(dir, 'r8');
        fs.mkdirSync(root, { recursive: true });
        setThemeRoots([root, root]);
        assert.deepEqual(themeRoots(), [path.resolve(root)]);
    });
});

describe('splitThemePath', () => {
    it('splits on the platform delimiter and drops empties', () => {
        assert.deepEqual(splitThemePath(['/a', '/b'].join(path.delimiter)), ['/a', '/b']);
        assert.deepEqual(splitThemePath(''), []);
        assert.deepEqual(splitThemePath(path.delimiter), []);
    });

    it('trims surrounding whitespace', () => {
        assert.deepEqual(splitThemePath(` /a ${path.delimiter} /b `), ['/a', '/b']);
    });

    it('keeps a Windows drive letter intact', () => {
        // The value is routinely typed by hand into a settings file shared across
        // machines; splitting `C:\themes` on the colon would yield a root named `C`.
        assert.deepEqual(splitThemePath('C:\\themes'), ['C:\\themes']);
        assert.deepEqual(splitThemePath('C:\\themes;D:\\more'), ['C:\\themes', 'D:\\more']);
    });

    it('accepts a semicolon-separated list on any platform', () => {
        assert.deepEqual(splitThemePath('/a;/b'), ['/a', '/b']);
    });
});

describe('themeRootsFromEnv', () => {
    it('reads EXPORT_THEME_PATH', () => {
        assert.deepEqual(themeRootsFromEnv({ [THEME_PATH_ENV]: ['/x', '/y'].join(path.delimiter) }),
                         ['/x', '/y']);
    });

    it('is empty when the variable is unset', () => {
        assert.deepEqual(themeRootsFromEnv({}), []);
    });
});


describe('a root that is itself a theme', () => {
    let dir: string;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-single-')); });
    after(()  => { fs.rmSync(dir, { recursive: true, force: true }); setThemeRoots([]); });
    afterEach(() => setThemeRoots([]));

    /** A theme folder whose manifest name differs from its directory name. */
    const plantTheme = (at: string, manifestName: string): string => {
        fs.cpSync(path.join(THEMES_DIR, 'default'), at, { recursive: true });
        const manifestPath = path.join(at, 'theme.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name: string };
        m.name = manifestName;
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        return at;
    };

    it('discovers a theme when the root IS the theme folder', () => {
        // What "add my external theme" means to a person pointing this at
        // ~/Dev/acme-theme. Requiring a folder OF theme folders produced
        // "Theme not found", naming the theme rather than the folder that did
        // not contain it.
        const themeDir = plantTheme(path.join(dir, 'acme-theme'), 'Acme');
        setThemeRoots([themeDir]);

        const external = listThemeEntries().filter(e => e.source === 'external');
        assert.equal(external.length, 1);
        assert.equal(external[0].name, 'acme-theme', 'the folder name is the identity');
        assert.equal(external[0].dir, themeDir);
    });

    it('still reads a root that holds several theme folders', () => {
        const root = path.join(dir, 'many');
        fs.mkdirSync(root, { recursive: true });
        plantTheme(path.join(root, 'one'), 'One');
        plantTheme(path.join(root, 'two'), 'Two');
        setThemeRoots([root]);
        assert.deepEqual(listThemeEntries().filter(e => e.source === 'external').map(e => e.name).sort(),
                         ['one', 'two']);
    });

    it('loads it by the folder name', () => {
        const themeDir = plantTheme(path.join(dir, 'byfolder'), 'Something Else');
        setThemeRoots([themeDir]);
        assert.equal(loadTheme('byfolder').dir, themeDir);
    });

    it('loads it by the name its manifest declares', () => {
        // The reported failure: folder `acme-theme`, manifest `Acme`, and a
        // document that reasonably writes `Theme: Acme` — the name on the cover
        // and in the theme's own README.
        const themeDir = plantTheme(path.join(dir, 'acme-theme2'), 'Acme');
        setThemeRoots([themeDir]);
        assert.equal(loadTheme('Acme').dir, themeDir);
        assert.equal(loadTheme('acme').dir, themeDir, 'and case-insensitively');
    });

    it('reports both names when they differ', () => {
        const themeDir = plantTheme(path.join(dir, 'aliased'), 'Aliased Brand');
        setThemeRoots([themeDir]);
        const entry = listThemeEntries().find(e => e.name === 'aliased');
        assert.equal(entry?.displayName, 'Aliased Brand');
    });

    it('falls back to the folder name when the manifest cannot be read', () => {
        const themeDir = plantTheme(path.join(dir, 'broken'), 'X');
        fs.writeFileSync(path.join(themeDir, 'theme.json'), '{ not json');
        setThemeRoots([themeDir]);
        // Listing must survive it; loadTheme is where a bad manifest is an error.
        const entry = listThemeEntries().find(e => e.name === 'broken');
        assert.equal(entry?.displayName, 'broken');
        assert.throws(() => loadTheme('broken'), /Could not parse theme manifest/);
    });

    it('names what IS available when a lookup fails', () => {
        // "Theme not found" plus a list of directories asks you to go and check
        // them by hand; the names are the thing that answers the question.
        const themeDir = plantTheme(path.join(dir, 'present'), 'Present Brand');
        setThemeRoots([themeDir]);
        assert.throws(() => loadTheme('absent'), (err: unknown) => {
            const msg = (err as Error).message;
            assert.match(msg, /Available:/);
            assert.match(msg, /present \(Present Brand\)/);
            return true;
        });
    });
});

describe('built-in themes resolve by either name', () => {
    afterEach(() => setThemeRoots([]));

    it('accepts the folder name, which is what everything already writes', () => {
        setThemeRoots([]);
        assert.equal(path.basename(loadTheme('markedapp-byword').dir), 'markedapp-byword');
    });

    it('accepts the manifest name, which is what the theme calls itself', () => {
        // Every shipped theme disagrees with its folder — `roryg-ghostwriter`
        // declares `Ghostwriter` — and nothing accepted the declared name until
        // an external theme made the gap visible.
        setThemeRoots([]);
        assert.equal(path.basename(loadTheme('Byword').dir), 'markedapp-byword');
        assert.equal(path.basename(loadTheme('Ghostwriter').dir), 'roryg-ghostwriter');
    });

    it('keeps listing them under their folder names', () => {
        // The identity every document, script and CI job already uses; switching
        // the listing to manifest names would rename all thirteen at once.
        setThemeRoots([]);
        const names = listThemes();
        assert.ok(names.includes('markedapp-byword'));
        assert.ok(!names.includes('Byword'));
    });
});
