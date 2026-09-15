import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as vm   from 'vm';
import { parseArgs } from '../cli';
import { ExitError } from '../errors';
import { setQuiet } from '../logger';
import {
    buildMpeParser, buildPreviewCss, isReplaceableParser, joinPreviewCss,
    planPreviewKit, writeMpeParser, writePreviewKit, MPE_PARSER_MARKER, type PreviewKitPlan,
} from '../preview-kit';
import {
    applyPreview, containWideContent, frontmatterScalar, markPreview, selectPreview, styleElement,
    PREVIEW_CLOSE, PREVIEW_OPEN, type PreviewKitIndex,
} from '../preview-plugin';
import { PREVIEW_RESET_CSS, PREVIEW_SCOPE, scopeForPreview, scopeSelector, splitSelectors } from '../preview-css';
import { readLocalStylesheet } from '../stylesheets';
import { applyStyleOverrides, setActiveTheme, setThemeRoots } from '../theme';

/**
 * The live-preview kit (`--preview-kit`).
 *
 * The kit is only worth having if a preview shows what an export would, so most
 * of this pins that: the stylesheets are built from the export's CSS and adapted
 * in exactly the two ways a previewer needs, the stylesheet a document gets is
 * the one the exporter's own precedence picks, and the two output formats carry
 * byte-identical CSS.
 *
 * `preview-plugin.ts` also runs inside Markdown Preview Enhanced's QuickJS
 * sandbox, where `require`, `module` and `process` do not exist. Those tests use
 * a `vm` context with none of them, which is the closest Node gets to that realm.
 */

setQuiet(true);

let dir: string;
let plan: PreviewKitPlan;

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-preview-'));
    setThemeRoots([]);
    plan = planPreviewKit();
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A tiny hand-written index, so selection tests do not depend on shipped themes. */
const INDEX: PreviewKitIndex = {
    schema: 1,
    generator: 'test',
    defaultTheme: 'default',
    aliases: { default: 'default', modern: 'modern', 'markedapp-byword': 'byword', byword: 'byword' },
    themes: {
        default: { name: 'default', displayName: 'Default', base: 'd/_base.css', unknown: 'd/_unknown.css',
            styles: { navy: 'd/navy.css' } },
        modern: { name: 'modern', displayName: 'Modern', base: 'm/_base.css', unknown: 'm/_unknown.css',
            styles: { cherry: 'm/cherry.css', 'blue berry': 'm/blue-berry.css' } },
        byword: { name: 'markedapp-byword', displayName: 'Byword', base: 'b/_base.css', unknown: 'b/_unknown.css',
            styles: {} },
    },
};

const doc = (frontmatter: string, body = '# Title\n'): string => `---\n${frontmatter}\n---\n\n${body}`;

describe('frontmatterScalar', () => {
    it('reads a top-level key case-insensitively, stripping quotes and comments', () => {
        assert.equal(frontmatterScalar('theme: Modern', 'Theme'), 'Modern');
        assert.equal(frontmatterScalar('Theme: "Modern"', 'Theme'), 'Modern');
        assert.equal(frontmatterScalar("Theme: 'Mod # ern'", 'Theme'), 'Mod # ern');
        assert.equal(frontmatterScalar('Theme: modern   # the house look', 'Theme'), 'modern');
    });

    it('ignores indented keys and reads a mapping as no name', () => {
        assert.equal(frontmatterScalar('Document Info:\n  Theme: modern', 'Theme'), null);
        assert.equal(frontmatterScalar('Style:\n  Color: "#ff0000"', 'Style'), null);
        assert.equal(frontmatterScalar('Style: # later', 'Style'), null);
    });
});

describe('selectPreview', () => {
    it('leaves a document without frontmatter alone', () => {
        assert.equal(selectPreview('# README\n', INDEX), null);
    });

    it('leaves a document whose frontmatter does not speak to this tool alone', () => {
        assert.equal(selectPreview(doc('title: Notes\ntags: [a]'), INDEX), null);
        assert.equal(selectPreview(doc('Info:\n  Mode: pdf'), INDEX), null);
    });

    it('previews a Mode-only document in the default theme, base stylesheet', () => {
        assert.deepEqual(selectPreview(doc('Mode: pdf'), INDEX), { theme: 'default', file: 'd/_base.css' });
    });

    // resolveThemeName: --theme → Theme → EXPORT_THEME → default.
    const precedence: Array<[string, string, { forcedTheme?: string | null; envTheme?: string | null }, string]> = [
        ['forced beats the document', 'Theme: modern', { forcedTheme: 'byword', envTheme: 'default' }, 'byword'],
        ['the document beats env',    'Theme: modern', { envTheme: 'byword' }, 'modern'],
        ['env beats the default',     'Mode: html',    { envTheme: 'modern' }, 'modern'],
        ['empty forced counts as unset', 'Theme: modern', { forcedTheme: '  ' }, 'modern'],
        ['a manifest name resolves',  'Theme: BYWORD', {}, 'byword'],
        ['a folder name resolves',    'Theme: Markedapp-Byword', {}, 'byword'],
    ];
    for (const [label, fm, options, theme] of precedence) {
        it(label, () => {
            assert.equal(selectPreview(doc(fm), INDEX, options)?.theme, theme);
        });
    }

    it('picks a named style case-insensitively, spaces included', () => {
        assert.equal(selectPreview(doc('Theme: modern\nStyle: Cherry'), INDEX)?.file, 'm/cherry.css');
        assert.equal(selectPreview(doc('Theme: modern\nStyle: "Blue Berry"'), INDEX)?.file, 'm/blue-berry.css');
    });

    it('gives an unknown style the unknown sheet and a mapping style the base sheet', () => {
        assert.equal(selectPreview(doc('Theme: modern\nStyle: mango'), INDEX)?.file, 'm/_unknown.css');
        assert.equal(selectPreview(doc('Theme: modern\nStyle:\n  Color: red'), INDEX)?.file, 'm/_base.css');
    });

    it('selects nothing for a theme the kit does not hold', () => {
        assert.equal(selectPreview(doc('Theme: ./brand/theme'), INDEX), null);
        assert.equal(selectPreview(doc('Mode: pdf'), INDEX, { forcedTheme: 'nope' }), null);
    });

    it('does not mistake object prototype names for kit entries', () => {
        assert.equal(selectPreview(doc('Theme: constructor'), INDEX), null);
        assert.equal(selectPreview(doc('Theme: modern\nStyle: constructor'), INDEX)?.file, 'm/_unknown.css');
    });

    it('reads frontmatter after a BOM and with CRLF line endings', () => {
        const text = '\ufeff---\r\nTheme: modern\r\nStyle: cherry\r\n---\r\n# T\r\n';
        assert.equal(selectPreview(text, INDEX)?.file, 'm/cherry.css');
    });
});

describe('styleElement / MPE hooks', () => {
    it('keeps a stylesheet from closing its own element', () => {
        assert.ok(!styleElement('a::after { content: "</style><script>" }').includes('</style><script>'));
    });

    it('marks at the end, so no earlier source line moves', () => {
        const text = doc('Mode: pdf', '# One\n\nTwo');
        const marked = markPreview(text, { theme: 'default', file: 'd/_base.css' });
        assert.ok(marked.startsWith(text));
        assert.match(marked, /<div data-pme-preview="d\/_base\.css"><\/div>\n$/);
        assert.equal(markPreview(text, null), text);
    });

    it('replaces the last marker with wrapper and a trailing style, removing every marker', () => {
        const html = '<h1>T</h1><div data-pme-preview="a.css"></div><p>x</p>' +
            '<div data-source-line="9" data-pme-preview="b.css"></div>';
        const out = applyPreview(html, file => `/* ${file} */`);
        assert.ok(out.startsWith(PREVIEW_OPEN));
        assert.ok(!out.includes('data-pme-preview'));
        assert.ok(out.includes(`${PREVIEW_CLOSE}<style>`));
        assert.ok(out.endsWith('</style>'), 'a leading <style> would be dropped by DOMPurify');
        assert.ok(out.includes('/* b.css */'));
    });

    it('boxes each outermost table so only the table scrolls sideways', () => {
        assert.equal(containWideContent('<p>a</p><table class="x"><tr><td>1</td></tr></table><p>b</p>'),
            '<p>a</p><div class="pme-scroll"><table class="x"><tr><td>1</td></tr></table></div><p>b</p>');
        assert.equal(containWideContent('<table><tr><td><table><tr><td>in</td></tr></table></td></tr></table>'),
            '<div class="pme-scroll"><table><tr><td><table><tr><td>in</td></tr></table></td></tr></table></div>');
        assert.equal(containWideContent('<table><tr><td>a</td></tr></table><TABLE></TABLE>'),
            '<div class="pme-scroll"><table><tr><td>a</td></tr></table></div><div class="pme-scroll"><TABLE></TABLE></div>');
        assert.equal(containWideContent('<p>tables only in prose: &lt;table&gt;</p><tablet>'), '<p>tables only in prose: &lt;table&gt;</p><tablet>');
        assert.equal(containWideContent('<table><tr><td>still typing'), '<div class="pme-scroll"><table><tr><td>still typing</div>');
    });

    it('boxes tables in the MPE output too', () => {
        const out = applyPreview('<table><tr><td>1</td></tr></table><div data-pme-preview="a.css"></div>', () => '');
        assert.ok(out.includes('<div class="pme-scroll"><table>'), out);
    });

    it('leaves HTML without a marker untouched', () => {
        assert.equal(applyPreview('<p>x</p>', () => 'css'), '<p>x</p>');
    });
});

describe('planPreviewKit — built-in themes', () => {
    it('covers every shipped theme, each with base, unknown and its styles', () => {
        const themes = Object.keys(plan.index.themes);
        assert.ok(themes.includes('default') && themes.includes('modern'), themes.join(', '));
        for (const t of Object.values(plan.index.themes)) {
            for (const file of [t.base, t.unknown, ...Object.values(t.styles)]) {
                assert.ok(plan.files[file], `${t.name}: ${file} is not in the plan`);
            }
        }
    });

    it('resolves every theme by its folder and its manifest name', () => {
        for (const [key, t] of Object.entries(plan.index.themes)) {
            assert.equal(plan.index.aliases[t.name.toLowerCase()], key);
            assert.equal(plan.index.aliases[t.displayName.toLowerCase()], key);
        }
    });

    it('leaves no body.html-export selector in any stylesheet', () => {
        for (const [file, { css }] of Object.entries(plan.files)) {
            assert.ok(!/body\.html-export/.test(joinPreviewCss(css)), file);
        }
    });

    it('puts every @import before the first rule of every stylesheet', () => {
        for (const [file, { css }] of Object.entries(plan.files)) {
            const whole = joinPreviewCss(css);
            const afterImports = whole.slice(css.imports.length);
            assert.ok(!/@import\s/.test(afterImports), `${file} has an @import after its first rule`);
        }
    });

    it('gives a named style its brand colour and the base sheet none', () => {
        const modern = plan.index.themes.modern;
        const base = joinPreviewCss(plan.files[modern.base].css);
        const styled = joinPreviewCss(plan.files[modern.styles.cherry].css);
        assert.ok(!base.includes('--brand-main:'), 'base must not carry a style override');
        assert.match(styled, /--brand-main:\s*#[0-9a-f]{3,8}/i);
    });

    it('tints an unknown style with the default palette, as the export does', () => {
        const t = plan.index.themes.default;
        assert.match(joinPreviewCss(plan.files[t.unknown].css), /--brand-main:/);
    });

    it('builds every style exactly as a fresh process would — no font leaks between styles', () => {
        // applyStyleOverrides edits the active theme in place; jasonm23 and mixu
        // styles each carry their own fontFamily/background, so a missing reload
        // would bleed one style's font into the next style built.
        for (const key of ['jasonm23', 'mixu', 'solarized']) {
            const t = plan.index.themes[key];
            // The theme's own spelling: the override block's comment names the style.
            for (const name of Object.keys(setActiveTheme(t.name).styles)) {
                const file = t.styles[name.toLowerCase()];
                const theme = setActiveTheme(t.name);
                const sheet = readLocalStylesheet(theme.stylesheetFile, { keepIconImports: true }) ?? '';
                applyStyleOverrides(name);
                assert.equal(joinPreviewCss(buildPreviewCss(sheet, name)), joinPreviewCss(plan.files[file].css), `${key}/${name}`);
            }
        }
    });
});

describe('scopeSelector / scopeForPreview', () => {
    const cases: Array<[string, string]> = [
        ['table th', '#pme-preview table th'],
        ['body', '#pme-preview'],
        [':root', '#pme-preview'],
        ['html body p', '#pme-preview p'],
        ['body.html-export nav.toc a', '#pme-preview nav.toc a'],
        ['body.code-line-numbers pre.hljs .code-line', '#pme-preview.code-line-numbers pre.hljs .code-line'],
        ['.github-markdown-body h1', '#pme-preview .pme-body h1'],
        ['.markdown-body', '#pme-preview .pme-body'],
        ['.github-markdown-content img', '#pme-preview .pme-content img'],
        // VS Code marks every block element .code-line; the export only writes it inside <pre>.
        ['.code-line', '#pme-preview pre .code-line'],
        ['bodyguard', '#pme-preview bodyguard'],
    ];
    for (const [input, expected] of cases) {
        it(`${input} → ${expected}`, () => assert.equal(scopeSelector(input), expected));
    }

    it('splits selector lists only on top-level commas', () => {
        assert.deepEqual(splitSelectors('a, :is(b, c) d, [title="x,y"]'), ['a', ':is(b, c) d', '[title="x,y"]']);
    });

    it('recurses into @media, keeps @font-face and @keyframes, drops @page and dark blocks, unwraps light ones', () => {
        const { imports, rules } = scopeForPreview(`
            @import url("https://fonts.example/css?family=A;B");
            /* a comment with { a brace */
            @page { margin: 2cm }
            @font-face { font-family: X; src: url(x.woff2) }
            @keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }
            @media print { .page-break { page-break-before: always } }
            @media (prefers-color-scheme: dark) { body { background: black } }
            @media (prefers-color-scheme: light) { p { color: #111 } }
            a::after { content: "}{"; }
        `);
        assert.deepEqual(imports, ['@import url("https://fonts.example/css?family=A;B");']);
        assert.ok(!rules.includes('@page') && !rules.includes('black') && !rules.includes('comment'));
        assert.match(rules, /@font-face \{ font-family: X; src: url\(x\.woff2\) \}/);
        assert.match(rules, /@keyframes spin \{ from \{ transform: rotate\(0\) \}/);
        assert.match(rules, /@media print \{\n#pme-preview \.page-break \{/);
        assert.match(rules, /^#pme-preview p \{ color: #111 \}$/m);
        assert.match(rules, /#pme-preview a::after \{ content: "\}\{"; \}/);
    });
});

describe('every generated stylesheet is confined to the preview wrapper', () => {
    /** Every style-rule selector in a stylesheet, at-rule preludes excluded. */
    function selectorsOf(css: string): string[] {
        const found: string[] = [];
        const noStrings = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
        for (const m of noStrings.matchAll(/(?:^|[{};])([^{};]*)\{/g)) {
            const prelude = m[1].trim();
            // At-rule preludes and keyframe steps are not selectors.
            if (!prelude || prelude.startsWith('@')) continue;
            if (/^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/.test(prelude)) continue;
            found.push(...splitSelectors(prelude));
        }
        return found;
    }

    it('scopes every rule under #pme-preview (the page background rule aside)', () => {
        for (const [file, { css }] of Object.entries(plan.files)) {
            for (const sel of selectorsOf(joinPreviewCss(css))) {
                assert.ok(sel.startsWith(PREVIEW_SCOPE) || sel === ':has(#pme-preview)', `${file}: unscoped selector "${sel}"`);
            }
        }
    });

    it('never lets .code-line reach outside a code block', () => {
        for (const [file, { css }] of Object.entries(plan.files)) {
            for (const sel of selectorsOf(joinPreviewCss(css)).filter(s => /\.code-line(?![\w-])/.test(s))) {
                assert.match(sel, /\bpre\b/, `${file}: "${sel}" would match VS Code's scroll-sync .code-line on tables`);
            }
        }
    });

    it('opens every stylesheet with the reset, ahead of all theme rules', () => {
        for (const [file, { css }] of Object.entries(plan.files)) {
            const whole = joinPreviewCss(css);
            const firstRule = whole.slice(css.imports.length).trimStart();
            assert.ok(firstRule.startsWith(PREVIEW_RESET_CSS), file);
        }
    });

    it('lets a boxed table scroll on its own', () => {
        const css = joinPreviewCss(plan.files[plan.index.themes.default.base].css);
        assert.match(css, /#pme-preview \.pme-scroll \{\s*position: relative;\s*overflow-x: auto;/);
        // …and a table that never got a box (added by another extension later) contains itself.
        assert.match(css, /#pme-preview \.pme-content > table \{\s*position: relative;\s*display: block;\s*overflow-x: auto;/);
        assert.match(css, /#pme-preview \.katex-display \{\s*position: relative;\s*overflow-x: auto;/);
    });

    it('gives the page, and any wrapper around the preview, the theme\'s own background', () => {
        const css = joinPreviewCss(plan.files[plan.index.themes.default.base].css);
        assert.match(css, /:has\(#pme-preview\) \{\s*background-color: #ffffff !important;/);
    });
});

describe('writePreviewKit (css format)', () => {
    let kit: string;
    before(() => {
        kit = path.join(dir, 'kit');
        writePreviewKit(kit, plan);
    });

    it('writes index.json naming only files that exist', () => {
        const index = JSON.parse(fs.readFileSync(path.join(kit, 'index.json'), 'utf8')) as PreviewKitIndex;
        for (const t of Object.values(index.themes)) {
            for (const file of [t.base, t.unknown, ...Object.values(t.styles)]) {
                assert.ok(fs.existsSync(path.join(kit, file)), file);
            }
        }
    });

    it('ships a preview-plugin.js that runs with no require, module or process', () => {
        const source = fs.readFileSync(path.join(kit, 'preview-plugin.js'), 'utf8');
        const sandbox: Record<string, unknown> = { exports: {} };
        vm.runInNewContext(source, sandbox);
        const mod = sandbox.exports as { selectPreview: typeof selectPreview };
        // JSON round trip: an object from another realm never deep-equals one from this one.
        const pick = JSON.parse(JSON.stringify(mod.selectPreview(doc('Theme: modern\nStyle: cherry'), INDEX))) as unknown;
        assert.deepEqual(pick, { theme: 'modern', file: 'm/cherry.css' });
    });
});

describe('MPE parser.js', () => {
    type Hooks = { onWillParseMarkdown(md: string): Promise<string>; onDidParseMarkdown(html: string): Promise<string> };

    /** Evaluates parser.js the way crossnote does: one expression, no host globals. */
    function evaluate(source: string): Hooks {
        const expression = `(${source.trim().replace(/[;,]+$/, '')})`;
        return vm.runInNewContext(expression, {}) as Hooks;
    }

    it('evaluates as a single expression with no require, module or process', () => {
        const hooks = evaluate(buildMpeParser(plan, {}));
        assert.equal(typeof hooks.onWillParseMarkdown, 'function');
        assert.equal(typeof hooks.onDidParseMarkdown, 'function');
    });

    it('produces the same CSS the css-format kit writes for that document', async () => {
        const hooks = evaluate(buildMpeParser(plan, {}));
        const markdown = doc('Theme: modern\nStyle: cherry', '# Hello');
        const marked = await hooks.onWillParseMarkdown(markdown);
        // What MPE would render: the heading, then the marker as a raw HTML block.
        const html = '<h1>Hello</h1>\n' + marked.slice(marked.lastIndexOf('<div data-pme-preview'));
        const out = await hooks.onDidParseMarkdown(html);

        const expected = joinPreviewCss(plan.files[plan.index.themes.modern.styles.cherry].css);
        assert.equal(out, `${PREVIEW_OPEN}<h1>Hello</h1>\n\n${PREVIEW_CLOSE}${styleElement(expected)}`);
    });

    it('bakes --theme in ahead of the document', async () => {
        const hooks = evaluate(buildMpeParser(plan, { forcedTheme: 'github' }));
        const marked = await hooks.onWillParseMarkdown(doc('Theme: modern'));
        assert.match(marked, /data-pme-preview="css\/github\/_base\.css"/);
    });

    it('leaves a plain Markdown file exactly as it was', async () => {
        const hooks = evaluate(buildMpeParser(plan, {}));
        assert.equal(await hooks.onWillParseMarkdown('# README\n'), '# README\n');
        assert.equal(await hooks.onDidParseMarkdown('<h1>README</h1>'), '<h1>README</h1>');
    });

    it('recognises its own file and MPE\'s untouched template as replaceable', () => {
        const mpeDefault = `({
  // Please visit the URL below for more information:
  // https://shd101wyy.github.io/markdown-preview-enhanced/#/extend-parser

  onWillParseMarkdown: async function(markdown) {
    return markdown;
  },

  onDidParseMarkdown: async function(html) {
    return html;
  },
})`;
        assert.ok(isReplaceableParser(mpeDefault));
        assert.ok(isReplaceableParser(`// ${MPE_PARSER_MARKER}\n(function(){})()`));
        assert.ok(!isReplaceableParser(mpeDefault.replace('return markdown;', 'return markdown.toUpperCase();')));
    });

    it('replaces MPE\'s template and its own file, and refuses anything else (exit 2)', () => {
        const crossnote = path.join(dir, '.crossnote');
        fs.mkdirSync(crossnote, { recursive: true });
        const target = path.join(crossnote, 'parser.js');

        fs.writeFileSync(target, '({ onWillParseMarkdown: async function(markdown) { return markdown; } })');
        writeMpeParser(crossnote, plan, {});
        assert.ok(fs.readFileSync(target, 'utf8').includes(MPE_PARSER_MARKER));

        writeMpeParser(crossnote, plan, {});   // its own file: replaced again without complaint

        const mine = '({ onDidParseMarkdown: async function(html) { return html + "<!-- mine -->"; } })';
        fs.writeFileSync(target, mine);
        assert.throws(() => writeMpeParser(crossnote, plan, {}),
            (err: unknown) => err instanceof ExitError && err.exitCode === 2);
        assert.equal(fs.readFileSync(target, 'utf8'), mine, 'a refused write must leave the file alone');
    });
});

describe('--preview-kit / --preview-format flags', () => {
    function exitOf(...argv: string[]): ExitError {
        try {
            parseArgs(argv);
        } catch (err) {
            assert.ok(err instanceof ExitError, `expected ExitError, got ${String(err)}`);
            return err;
        }
        assert.fail('parseArgs did not throw');
    }

    it('writes a kit and exits 0, whatever the argument order', () => {
        const kit = path.join(dir, 'flag-kit');
        const e = exitOf('--preview-format', 'css', `--preview-kit=${kit}`);
        assert.equal(e.exitCode, 0);
        assert.ok(fs.existsSync(path.join(kit, 'index.json')));
    });

    it('rejects --preview-format without --preview-kit, and an unknown format', () => {
        assert.equal(exitOf('--preview-format', 'mpe').exitCode, 2);
        assert.equal(exitOf('--preview-kit', path.join(dir, 'x'), '--preview-format', 'pdf').exitCode, 2);
    });
});
