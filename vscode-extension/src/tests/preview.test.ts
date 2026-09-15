import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    loadPreviewKit, previewMarkdownItPlugin, OPEN_TOKEN, CLOSE_TOKEN, SCROLL_OPEN_TOKEN, SCROLL_CLOSE_TOKEN, PREVIEW_KIT_SCHEMA,
    type CoreState, type MarkdownItLike, type PreviewHost, type PreviewKit,
} from '../preview';

/**
 * The built-in preview's side of the preview kit.
 *
 * Which stylesheet a document gets is the kit's decision (`preview-plugin.js`,
 * tested with the CLI), so the module written here is a stand-in that records
 * what it was asked. What is tested is the editor's part: loading a kit safely,
 * picking up a regenerated one, and bracketing the token stream only when there
 * is something to apply.
 */

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-ext-preview-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Writes a kit whose selectPreview answers `file` for any document containing `pick-me`. */
function writeKit(name: string, opts: { schema?: number; file?: string; marker?: string } = {}): string {
    const kit = path.join(dir, name);
    fs.mkdirSync(path.join(kit, 'css'), { recursive: true });
    fs.writeFileSync(path.join(kit, 'index.json'), JSON.stringify({ schema: opts.schema ?? PREVIEW_KIT_SCHEMA, generator: 'test' }));
    fs.writeFileSync(path.join(kit, 'css', 'a.css'), 'h1 { color: red }');
    const file = JSON.stringify(opts.file ?? 'css/a.css');
    const marker = JSON.stringify(opts.marker ?? 'v1');
    fs.writeFileSync(path.join(kit, 'preview-plugin.js'), `
exports.calls = [];
exports.selectPreview = function (markdown, index, options) {
    exports.calls.push(options);
    return markdown.indexOf('pick-me') >= 0 ? { theme: 't', file: ${file} } : null;
};
exports.styleElement = function (css) { return '<style>' + css + '</style>'; };
exports.PREVIEW_OPEN = '<div class="open ' + ${marker} + '">';
exports.PREVIEW_CLOSE = '</div>';
`);
    return kit;
}

describe('loadPreviewKit', () => {
    it('returns null for a missing kit or one written for another schema', () => {
        assert.equal(loadPreviewKit(path.join(dir, 'nowhere')), null);
        assert.equal(loadPreviewKit(writeKit('old', { schema: 99 })), null);
    });

    it('reads stylesheets inside the kit and nothing outside it', () => {
        const kit = loadPreviewKit(writeKit('ok'));
        assert.ok(kit);
        assert.equal(kit.css('css/a.css'), 'h1 { color: red }');
        assert.equal(kit.css('css/missing.css'), null);
        assert.equal(kit.css('../nowhere/css/a.css'), null);
        assert.equal(kit.css(path.join('..', '..', 'etc', 'passwd')), null);
    });

    it('picks up a regenerated preview-plugin.js instead of a cached one', () => {
        const kitDir = writeKit('regen', { marker: 'v1' });
        assert.match(loadPreviewKit(kitDir)!.module.PREVIEW_OPEN, /v1/);
        writeKit('regen', { marker: 'v2' });
        assert.match(loadPreviewKit(kitDir)!.module.PREVIEW_OPEN, /v2/);
    });
});

// ── A markdown-it stand-in: just the parts the plugin touches ─────────────────

class Token {
    meta: unknown = null;
    block = false;
    constructor(public type: string, public tag: string, public nesting: number) {}
}

function fakeMarkdownIt() {
    const coreRules: Array<(state: CoreState) => void> = [];
    const md: MarkdownItLike = {
        core: { ruler: { push: (_name, rule) => { coreRules.push(rule); } } },
        renderer: { rules: {} },
    };
    const parse = (src: string, body: Token[] = [new Token('paragraph_open', 'p', 1)]): CoreState['tokens'] => {
        const state: CoreState = { src, tokens: body, Token };
        for (const rule of coreRules) rule(state);
        return state.tokens;
    };
    const render = (tokens: CoreState['tokens']): string =>
        tokens.map((t, i) => md.renderer.rules[t.type]?.(tokens, i) ?? `<${t.type}>`).join('');
    return { md, parse, render };
}

function host(kit: PreviewKit | null, overrides: Partial<PreviewHost> = {}): PreviewHost {
    return {
        kit: () => kit,
        enabled: () => true,
        forcedTheme: () => null,
        envTheme: () => null,
        ...overrides,
    };
}

describe('previewMarkdownItPlugin', () => {
    it('brackets a themed document and renders the wrapper with a trailing style', () => {
        const kit = loadPreviewKit(writeKit('plugin'))!;
        const { md, parse, render } = fakeMarkdownIt();
        previewMarkdownItPlugin(host(kit))(md);

        const tokens = parse('pick-me');
        assert.deepEqual(tokens.map(t => t.type), [OPEN_TOKEN, 'paragraph_open', CLOSE_TOKEN]);
        assert.equal(render(tokens), '<div class="open v1"><paragraph_open></div><style>h1 { color: red }</style>');
    });

    it('leaves the token stream alone when disabled, kitless, unpicked or missing its stylesheet', () => {
        const kit = loadPreviewKit(writeKit('plain'))!;
        const broken = loadPreviewKit(writeKit('broken', { file: 'css/gone.css' }))!;
        const cases: Array<[string, PreviewHost, string]> = [
            ['disabled', host(kit, { enabled: () => false }), 'pick-me'],
            ['no kit', host(null), 'pick-me'],
            ['not an export document', host(kit), '# README'],
            ['stylesheet missing', host(broken), 'pick-me'],
        ];
        for (const [label, h, src] of cases) {
            const { md, parse } = fakeMarkdownIt();
            previewMarkdownItPlugin(h)(md);
            assert.deepEqual(parse(src).map(t => t.type), ['paragraph_open'], label);
        }
    });

    it('passes the theme setting and EXPORT_THEME through to the kit', () => {
        const kit = loadPreviewKit(writeKit('opts'))!;
        const { md, parse } = fakeMarkdownIt();
        previewMarkdownItPlugin(host(kit, { forcedTheme: () => 'modern', envTheme: () => 'github' }))(md);
        parse('pick-me');
        const calls = (kit.module as unknown as { calls: unknown[] }).calls;
        assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { forcedTheme: 'modern', envTheme: 'github' });
    });

    it('boxes each outermost table of a themed document, and nothing in any other', () => {
        const kit = loadPreviewKit(writeKit('boxes'))!;
        const tables = () => ['table_open', 'table_open', 'table_close', 'table_close', 'paragraph_open', 'table_open', 'table_close']
            .map(type => new Token(type, '', type.endsWith('_open') ? 1 : -1));

        const themed = fakeMarkdownIt();
        previewMarkdownItPlugin(host(kit))(themed.md);
        assert.deepEqual(themed.parse('pick-me', tables()).map(t => t.type), [
            OPEN_TOKEN,
            SCROLL_OPEN_TOKEN, 'table_open', 'table_open', 'table_close', 'table_close', SCROLL_CLOSE_TOKEN,
            'paragraph_open',
            SCROLL_OPEN_TOKEN, 'table_open', 'table_close', SCROLL_CLOSE_TOKEN,
            CLOSE_TOKEN,
        ]);
        assert.match(themed.render(themed.parse('pick-me', tables())), /^<div class="open v1"><div class="pme-scroll"><table_open>/);

        const plain = fakeMarkdownIt();
        previewMarkdownItPlugin(host(kit))(plain.md);
        assert.ok(!plain.parse('# README', tables()).some(t => t.type === SCROLL_OPEN_TOKEN));
    });

    it('renders nothing extra from cached tokens once the kit is gone', () => {
        let current: PreviewKit | null = loadPreviewKit(writeKit('gone'))!;
        const { md, parse, render } = fakeMarkdownIt();
        previewMarkdownItPlugin(host(null, { kit: () => current }))(md);
        const tokens = parse('pick-me');
        current = null;
        assert.equal(render(tokens), '<paragraph_open>');
    });
});
