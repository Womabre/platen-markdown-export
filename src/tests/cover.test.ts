import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRevisionTable, buildCoverPage, validateDocumentColors } from '../cover';
import * as fs from 'fs';
import * as path from 'path';
import { setActiveTheme, applyStyleOverrides, getActiveTheme, resolveColorValue, listThemes, THEMES_DIR } from '../theme';

// See theme.test.ts for why this fixture exists instead of loading a real
// brand theme here.
const FIXTURE = path.join(__dirname, '..', '..', 'test-fixtures', 'theme');

describe('buildRevisionTable', () => {
    it('returns null for empty revisions', () => {
        assert.equal(buildRevisionTable([]), null);
    });

    it('returns null for null input', () => {
        assert.equal(buildRevisionTable(null), null);
    });

    it('returns null for undefined input', () => {
        assert.equal(buildRevisionTable(undefined), null);
    });

    it('renders a table with revision rows', () => {
        const result = buildRevisionTable([
            { revision: 'A', date: '2024-01-01', author: 'Alice', remarks: 'Initial' },
        ]);
        assert.ok(result?.includes('<table class="revision-table">'));
        assert.ok(result?.includes('Alice'));
        assert.ok(result?.includes('Initial'));
        assert.ok(result?.includes('2024-01-01'));
    });

    it('limits rows to the specified count (default 3)', () => {
        const revisions = [
            { revision: 'A', date: '2024-01-01', author: 'Alice', remarks: 'r1' },
            { revision: 'B', date: '2024-01-02', author: 'Bob',   remarks: 'r2' },
            { revision: 'C', date: '2024-01-03', author: 'Carol', remarks: 'r3' },
            { revision: 'D', date: '2024-01-04', author: 'Dave',  remarks: 'r4' },
        ];
        const result = buildRevisionTable(revisions, 3);
        assert.ok(!result?.includes('Alice')); // oldest excluded
        assert.ok(result?.includes('Bob'));
        assert.ok(result?.includes('Carol'));
        assert.ok(result?.includes('Dave'));
    });

    it('respects a custom limit', () => {
        const revisions = [
            { revision: 'A', date: '2024-01-01', author: 'Alice', remarks: '' },
            { revision: 'B', date: '2024-01-02', author: 'Bob',   remarks: '' },
        ];
        const result = buildRevisionTable(revisions, 1);
        assert.ok(!result?.includes('Alice'));
        assert.ok(result?.includes('Bob'));
    });
});

// ── Cover background duplication guard ────────────────────────────────────────
//
// A full-bleed theme paints the cover composition on the `@page cover` box. An
// extra copy on the `.cover-page` element is only needed when the theme/style
// sets an opaque `background`, which would otherwise paint over the page box.
// Emitting it unconditionally composited the photo and gradient onto the cover
// twice — visible as duplicate layers in a PDF editor.

describe('buildCoverPage — Cover Title Color', () => {
    // The theme's own cover.css also has `.cover-page` rules; the injected one
    // is the last, immediately before the closing </style>.
    const coverPageRule = (css: string) =>
        /\.cover-page \{([^}]*)\}\s*<\/style>/.exec(css)?.[1] ?? '';

    it('sets --cover-title-color on .cover-page', async () => {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        const cover = await buildCoverPage({ title: 'A — B', style: 'none', coverTitleColor: '#FFD84D' });
        assert.match(coverPageRule(cover!.css), /--cover-title-color: #FFD84D;/);
    });

    it('resolves a palette name the same way Style.Color does', async () => {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        const muted = resolveColorValue('Muted');
        assert.notEqual(muted, 'Muted', 'precondition: the name must resolve to a colour');
        const cover = await buildCoverPage({ title: 'T', style: 'none', coverTitleColor: 'Muted' });
        assert.match(coverPageRule(cover!.css), new RegExp(`--cover-title-color: ${muted};`));
    });

    it('sets nothing when the key is absent, leaving theme typography alone', async () => {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        const cover = await buildCoverPage({ title: 'T', style: 'none' });
        assert.doesNotMatch(coverPageRule(cover!.css), /--cover-title-color/);
    });
});

describe('every theme template exposes every cover override slot', () => {
    // A missing slot fails silently: the frontmatter key parses, the engine
    // fills the token, and the theme simply never renders it. That is how
    // `Cover Slogan` went unnoticed on ten themes and `Cover Address` on five.
    // Comments are stripped first — the templates document their own tokens in a
    // header comment, which is exactly what made a grep-based audit lie.
    const REQUIRED = ['COVER_TITLE_MAIN', 'COVER_SUBTITLE', 'COVER_INFO_ROWS',
                      'COVER_ADDRESS', 'COVER_SLOGAN', 'REVISION_TABLE', 'COVER_LOGO_IMG'];

    const liveMarkup = (file: string) =>
        fs.readFileSync(file, 'utf8')
          .split(/<script>/)[0]              // drop the standalone-preview shell
          .replace(/<!--[\s\S]*?-->/g, ''); // drop the token-documentation header

    for (const name of listThemes()) {
        const file = path.join(THEMES_DIR, name, 'html', 'cover-page.html');
        if (!fs.existsSync(file)) continue;

        it(`${name} renders every override token`, () => {
            const body = liveMarkup(file);
            const missing = REQUIRED.filter(t => !body.includes(`{{${t}}}`));
            assert.deepEqual(missing, [], `${name}: template has no slot for these`);
            // The brand mark comes in two variants; a light-background layout
            // uses the dark one. Either satisfies `Cover Footer Logo`, which
            // now drives both.
            assert.ok(/\{\{LOGO_IMG\}\}|\{\{LOGO_DARK_IMG\}\}/.test(body),
                `${name}: template renders neither logo variant`);
        });
    }
});

describe('every theme routes cover title colour through --cover-title-color', () => {
    // The switch only reaches a theme if that theme's own CSS reads the
    // property. A theme that hardcodes a title, rule or subtitle colour would
    // silently ignore `Cover Title Color` — so this fails the build instead.
    const COLOUR_PROPS = /^(color|border(-(top|bottom|left|right))?(-color)?)$/;

    for (const name of listThemes()) {
        it(`${name} hardcodes no title/subtitle colour`, () => {
            const file = path.join(THEMES_DIR, name, 'css', 'cover.css');
            if (!fs.existsSync(file)) return;
            const css = fs.readFileSync(file, 'utf8');
            const offenders: string[] = [];

            for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
                const s = sel.trim().replace(/\s+/g, ' ');
                const pseudo  = /\.cover-title::(after|before)/.test(s);
                const element = !pseudo && /\.cover-(title|subtitle)\b/.test(s);
                if (!pseudo && !element) continue;

                for (const decl of body.split(';')) {
                    const m = /^\s*([-a-z]+)\s*:\s*(.+)$/i.exec(decl);
                    if (!m) continue;
                    const [, prop, value] = m;
                    const paints = pseudo
                        ? /^background(-color)?$/.test(prop)
                        : COLOUR_PROPS.test(prop);
                    if (!paints) continue;
                    // A colour literal that isn't wrapped in the property is drift.
                    const literal = /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value);
                    if (literal && !value.includes('--cover-title-color'))
                        offenders.push(`${s} { ${prop}: ${value.trim()} }`);
                }
            }
            assert.deepEqual(offenders, [],
                `${name}: these paint the cover title block but ignore --cover-title-color`);
        });
    }
});

describe('buildCoverPage — element-level background copy', () => {
    it('omits the element copy for a full-bleed theme with no background', async () => {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        assert.equal(getActiveTheme().background, '', 'precondition: fixture theme sets no background');

        const cover = await buildCoverPage({ title: 'T', style: 'none' });
        assert.ok(cover, "a style was given, so a cover must be built");
        const { css } = cover;
        const rule = /\.cover-page \{([^}]*)\}\s*<\/style>/.exec(css);
        assert.ok(rule, 'the injected .cover-page rule should exist');
        assert.doesNotMatch(rule[1], /background-image/,
            'no opaque background → the page-box paint is enough');
    });

    it('keeps the element copy when the theme sets an opaque background', async () => {
        setActiveTheme('gaia');
        applyStyleOverrides(null);
        assert.ok(getActiveTheme().background, 'precondition: gaia sets a background');

        const cover = await buildCoverPage({ title: 'T', style: 'Gaia' });
        assert.ok(cover, "a style was given, so a cover must be built");
        const { css } = cover;
        const rule = /\.cover-page \{([^}]*)\}\s*<\/style>/.exec(css);
        assert.ok(rule, 'the injected .cover-page rule should exist');
        assert.match(rule[1], /background-image/,
            'an opaque background would cover the page box — the element copy must survive');
    });

    it('picks up a background contributed by the selected style', async () => {
        setActiveTheme('jasonm23');
        applyStyleOverrides('Dark');
        assert.equal(getActiveTheme().background, '#000000');

        const cover = await buildCoverPage({ title: 'T', style: 'Dark' });
        assert.ok(cover, "a style was given, so a cover must be built");
        const { css } = cover;
        const rule = /\.cover-page \{([^}]*)\}\s*<\/style>/.exec(css);
        assert.ok(rule, 'the injected .cover-page rule should exist');
        assert.match(rule[1], /background-image/,
            'style-level backgrounds must be resolved before the cover is built');
    });

    it('always exposes the --cover-* custom properties, copy or not', async () => {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        const cover = await buildCoverPage({ title: 'T', style: 'none' });
        assert.ok(cover, "a style was given, so a cover must be built");
        const { css } = cover;
        assert.match(css, /--cover-photo:/);
        assert.match(css, /--cover-overlay:/);
        assert.match(css, /--cover-photo-pos-x:/);
    });
});

// ── Cover element overrides ───────────────────────────────────────────────────

describe('buildCoverPage — slogan / address / brand-mark overrides', () => {
    async function cover(opts: Record<string, unknown>) {
        setActiveTheme(FIXTURE);
        applyStyleOverrides(null);
        const c = await buildCoverPage({ title: 'T', style: 'Hero', ...opts });
        assert.ok(c, 'a style was given, so a cover must be built');
        return c.html;
    }

    it('uses the theme slogan and address by default', async () => {
        const html = await cover({});
        assert.match(html, /Fixture slogan for tests\./);
        assert.match(html, /1 Fixture Way/);
    });

    it('replaces the slogan', async () => {
        assert.match(await cover({ coverSlogan: 'Engineering, delivered.' }),
                     /Engineering, delivered\./);
    });

    it('removes the slogan on false', async () => {
        assert.doesNotMatch(await cover({ coverSlogan: false }), /Fixture slogan for tests/);
    });

    it('replaces a multi-line address, one <br> per line', async () => {
        const html = await cover({ coverAddress: 'Acme B.V.\nIndustrieweg 12\n5000 AA Eindhoven' });
        assert.match(html, /Acme B\.V\.<br>Industrieweg 12<br>5000 AA Eindhoven/);
        assert.doesNotMatch(html, /1 Fixture Way/);
    });

    it('removes the address on false', async () => {
        assert.doesNotMatch(await cover({ coverAddress: false }), /1 Fixture Way/);
    });

    it('escapes replacement text rather than trusting it as markup', async () => {
        const html = await cover({ coverSlogan: 'A & B <script>' });
        assert.match(html, /A &amp; B &lt;script&gt;/);
    });

    it('drops the bottom-right brand mark on false', async () => {
        const html = await cover({ coverFooterLogo: false });
        assert.match(html, /<div class="cover-l4-cover"><\/div>/,
            'the slot should remain but be empty');
    });
});

// ── validateDocumentColors ────────────────────────────────────────────────────

describe('validateDocumentColors', () => {
    const check = (fm: { coverTitleColor?: string | null; background?: string | null }) => {
        setActiveTheme(FIXTURE);
        return () => validateDocumentColors({
            coverTitleColor: fm.coverTitleColor ?? null,
            coverLogo: fm.background === undefined
                ? null
                : { path: 'logo.svg', background: fm.background },
        });
    };

    it('accepts a document with no colour keys at all', () => {
        assert.doesNotThrow(check({}));
    });

    it('accepts hex and rgb literals', () => {
        assert.doesNotThrow(check({ coverTitleColor: '#fff' }));
        assert.doesNotThrow(check({ coverTitleColor: '#ff00ff80' }));
        assert.doesNotThrow(check({ background: 'rgba(255,255,255,0.5)' }));
    });

    it('accepts a palette name from the active theme', () => {
        assert.doesNotThrow(check({ coverTitleColor: 'Brand' }));
        assert.doesNotThrow(check({ background: 'Muted' }));
    });

    it('rejects an unknown colour and names the key that carried it', () => {
        assert.throws(check({ coverTitleColor: 'notacolour' }), /^ExitError: Cover Title Color: Unknown colour/);
    });

    it('validates Cover Logo Background, which used to bypass the grammar entirely', () => {
        // It went straight into a style attribute: no palette names, a typo
        // rendered nothing rather than failing, and a value like this one
        // injected extra CSS declarations.
        assert.throws(
            check({ background: 'red; position:fixed; top:0' }),
            /^ExitError: Cover Logo Background: Unknown colour/,
        );
    });

    it('reports a usage error, so the CLI exits 2 rather than 1', () => {
        try {
            check({ coverTitleColor: 'nope' })();
            assert.fail('should have thrown');
        } catch (err) {
            assert.equal((err as { exitCode?: number }).exitCode, 2);
        }
    });

    it('ignores empty values rather than calling them invalid', () => {
        assert.doesNotThrow(check({ coverTitleColor: '', background: '' }));
    });
});
