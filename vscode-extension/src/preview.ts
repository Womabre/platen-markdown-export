import * as fs from 'fs';
import * as path from 'path';

/**
 * Theming for VS Code's built-in Markdown preview.
 *
 * The CLI writes a preview kit (`--preview-kit <dir>`): one stylesheet per theme
 * and style, built from the export's own CSS, plus `preview-plugin.js`, the
 * module that decides which stylesheet a document gets. This file is the thin
 * part that lives in the editor: it loads that kit, and registers a markdown-it
 * plugin that wraps a themed document in the markup the stylesheet targets.
 *
 * The decision itself is deliberately *not* made here. `selectPreview` comes
 * from the kit, so the preview picks a theme with exactly the code the CLI ships
 * — the same code Markdown Preview Enhanced runs — rather than a second
 * implementation in the extension that could quietly disagree with the export.
 *
 * No `vscode` import, so `node --test` can load it.
 */

/** The subset of the kit's `index.json` this file reads. */
export interface PreviewKitIndex {
    schema: number;
    generator: string;
}

/** What `preview-plugin.js` exports that the extension uses. */
export interface PreviewKitModule {
    selectPreview(markdown: string, index: unknown, options: { forcedTheme?: string | null; envTheme?: string | null }):
        { theme: string; file: string } | null;
    styleElement(css: string): string;
    PREVIEW_OPEN: string;
    PREVIEW_CLOSE: string;
}

/** The kit schema this extension understands. */
export const PREVIEW_KIT_SCHEMA = 1;

/** A kit loaded from disk. */
export interface PreviewKit {
    dir: string;
    index: PreviewKitIndex;
    module: PreviewKitModule;
    /** A stylesheet's text, or null when the kit has no such file. Cached. */
    css(file: string): string | null;
}

/**
 * Loads the kit in `dir`, or returns null when there is none usable.
 *
 * The module is required fresh every time — dropping Node's cache entry first —
 * because a regenerated kit writes a new `preview-plugin.js` over the old one,
 * and a cached copy would keep choosing stylesheets with the previous CLI's rules.
 */
export function loadPreviewKit(dir: string): PreviewKit | null {
    const indexFile = path.join(dir, 'index.json');
    const moduleFile = path.join(dir, 'preview-plugin.js');
    let index: PreviewKitIndex;
    try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as PreviewKitIndex;
    } catch {
        return null;
    }
    if (index.schema !== PREVIEW_KIT_SCHEMA || !fs.existsSync(moduleFile)) return null;

    let module: PreviewKitModule;
    try {
        const resolved = require.resolve(moduleFile);
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        module = require(resolved) as PreviewKitModule;
    } catch {
        return null;
    }
    if (typeof module.selectPreview !== 'function') return null;

    const root = path.resolve(dir);
    const cache = new Map<string, string | null>();
    const css = (file: string): string | null => {
        if (cache.has(file)) return cache.get(file) ?? null;
        const target = path.resolve(root, file);
        // The kit names its own files; one that points outside the kit is not one.
        let text: string | null = null;
        if (target.startsWith(root + path.sep)) {
            try { text = fs.readFileSync(target, 'utf8'); } catch { text = null; }
        }
        cache.set(file, text);
        return text;
    };
    return { dir, index, module, css };
}

/** What the plugin asks the editor at render time. */
export interface PreviewHost {
    /** The current kit, or null while none has been generated. */
    kit(): PreviewKit | null;
    /** `platenMarkdownExport.preview.enabled`. */
    enabled(): boolean;
    /** The `theme` setting — beats the document, as `--theme` does. */
    forcedTheme(): string | null;
    /** `EXPORT_THEME` as an export would see it. */
    envTheme(): string | null;
}

/** Token types the plugin adds. */
export const OPEN_TOKEN = 'platen_markdown_export_preview_open';
export const CLOSE_TOKEN = 'platen_markdown_export_preview_close';
export const SCROLL_OPEN_TOKEN = 'platen_markdown_export_preview_scroll_open';
export const SCROLL_CLOSE_TOKEN = 'platen_markdown_export_preview_scroll_close';

/** Must match `SCROLL_CLASS` in the CLI's preview-plugin.ts, which the kit CSS styles. */
export const SCROLL_CLASS = 'pme-scroll';

/* Structural types for the slice of markdown-it this plugin touches, so the
   extension needs no markdown-it dependency of its own — VS Code hands it the
   instance. */
export interface Token { type: string; meta: unknown; block: boolean; nesting: number }
export interface CoreState { src: string; tokens: Token[]; Token: new (type: string, tag: string, nesting: number) => Token }
export interface MarkdownItLike {
    core: { ruler: { push(name: string, rule: (state: CoreState) => void): void } };
    renderer: {
        rules: Record<string, ((tokens: Token[], idx: number) => string) | undefined>;
    };
}

/**
 * The markdown-it plugin VS Code's preview loads through `extendMarkdownIt`.
 *
 * A core rule brackets the whole token stream with an open and a close token
 * when the document should be themed; the renderer turns them into the wrapper
 * and a trailing `<style>`. The stylesheet is resolved again at render time
 * rather than baked into the token, because VS Code caches tokens per document
 * and a regenerated kit has to show up on the next refresh.
 *
 * Registered once and consulted on every render, so turning the setting off or
 * regenerating the kit needs no reload of the preview's engine.
 */
export function previewMarkdownItPlugin(host: PreviewHost): (md: MarkdownItLike) => void {
    return (md) => {
        md.core.ruler.push('platen_markdown_export_preview', (state) => {
            if (!host.enabled()) return;
            const kit = host.kit();
            if (!kit) return;
            const pick = kit.module.selectPreview(state.src, kit.index, {
                forcedTheme: host.forcedTheme(),
                envTheme: host.envTheme(),
            });
            if (!pick || kit.css(pick.file) === null) return;

            const open = new state.Token(OPEN_TOKEN, '', 1);
            open.block = true;
            open.meta = pick.file;
            const close = new state.Token(CLOSE_TOKEN, '', -1);
            close.block = true;
            close.meta = pick.file;
            state.tokens.unshift(open);
            state.tokens.push(close);
            boxTables(state);
        });

        md.renderer.rules[OPEN_TOKEN] = (tokens, idx) => {
            const kit = host.kit();
            const css = kit ? kit.css(String(tokens[idx].meta)) : null;
            return kit && css !== null ? kit.module.PREVIEW_OPEN : '';
        };
        md.renderer.rules[CLOSE_TOKEN] = (tokens, idx) => {
            const kit = host.kit();
            const css = kit ? kit.css(String(tokens[idx].meta)) : null;
            return kit && css !== null ? `${kit.module.PREVIEW_CLOSE}${kit.module.styleElement(css)}` : '';
        };
        md.renderer.rules[SCROLL_OPEN_TOKEN] = () => (host.kit() ? `<div class="${SCROLL_CLASS}">` : '');
        md.renderer.rules[SCROLL_CLOSE_TOKEN] = () => (host.kit() ? '</div>' : '');
    };
}

/**
 * Puts each outermost table of a themed document in a box that scrolls sideways.
 *
 * A table wider than the preview pane otherwise widens the whole page, and the
 * pane scrolls every paragraph along with it. Done with tokens rather than by
 * post-processing the rendered HTML: several preview extensions (Mermaid, Marp,
 * GitHub styles) replace `renderer.render`, and not all of them call the one
 * they replaced — a wrapper there silently vanished in a real editor, while
 * token rules are honoured by every renderer.
 */
function boxTables(state: CoreState): void {
    const out: Token[] = [];
    let depth = 0;
    for (const token of state.tokens) {
        if (token.type === 'table_open' && depth++ === 0) {
            const box = new state.Token(SCROLL_OPEN_TOKEN, 'div', 1);
            box.block = true;
            out.push(box);
        }
        out.push(token);
        if (token.type === 'table_close' && depth > 0 && --depth === 0) {
            const box = new state.Token(SCROLL_CLOSE_TOKEN, 'div', -1);
            box.block = true;
            out.push(box);
        }
    }
    state.tokens.splice(0, state.tokens.length, ...out);
}
