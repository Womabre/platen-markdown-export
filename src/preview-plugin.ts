/**
 * Live-preview theming: the half that runs inside the previewer.
 *
 * `preview-kit.ts` builds, for every discoverable theme and style, the CSS an
 * export of that document would carry. This module decides — for one document,
 * at preview time — which of those stylesheets applies, and wraps the rendered
 * HTML in the markup that stylesheet targets.
 *
 * It has **no imports**, and that is load-bearing rather than tidy. The same
 * compiled file runs in three places:
 *
 * - the CLI's own tests, under Node;
 * - the VS Code extension host, which `require`s the copy written into the kit
 *   (so the extension never carries a second implementation of "which theme
 *   does this document use" that could drift from this one);
 * - Markdown Preview Enhanced, inlined into a generated `.crossnote/parser.js`.
 *   MPE evaluates that file inside a QuickJS WebAssembly sandbox where `require`,
 *   `process` and the filesystem do not exist — only strings cross in and out.
 *
 * Anything added here must keep working with nothing but the language itself.
 */

/** Bumped when the kit's file layout or `index.json` shape changes. */
export const PREVIEW_KIT_SCHEMA = 1;

/** One theme in the kit. File paths are relative to the kit directory. */
export interface PreviewKitTheme {
    /** The theme's folder name — the identity `--theme` takes. */
    name: string;
    /** What the theme's manifest calls itself. */
    displayName: string;
    /** The document names no style. */
    base: string;
    /** The document names a style the theme does not know. */
    unknown: string;
    /** Lower-cased style (or palette) name → stylesheet. */
    styles: Record<string, string>;
}

/** The kit's `index.json`. */
export interface PreviewKitIndex {
    schema: number;
    /** `platen-markdown-export <version>` — which CLI wrote the kit. */
    generator: string;
    /** The theme used when nothing else names one. */
    defaultTheme: string;
    /**
     * Lower-cased folder or manifest name → theme key, holding only the theme
     * each name resolves to. Built in the exporter's own search order, so an
     * external theme shadows a built-in of the same name here exactly as it
     * does in an export.
     */
    aliases: Record<string, string>;
    themes: Record<string, PreviewKitTheme>;
}

/** What the host knows that the document does not say. */
export interface PreviewSelectOptions {
    /** `--theme` / the extension's `theme` setting — beats the document. */
    forcedTheme?: string | null;
    /** `EXPORT_THEME` — loses to the document. */
    envTheme?: string | null;
}

/** The stylesheet chosen for one document. */
export interface PreviewPick {
    /** Theme key in the kit. */
    theme: string;
    /** Kit-relative stylesheet path. */
    file: string;
}

/**
 * Opens the wrapper the kit's CSS targets: the export's three levels — body,
 * `.github-markdown-body`, `.github-markdown-content` — under names no other
 * preview extension styles. The id is the scope every kit rule sits under; see
 * `preview-css.ts` for why it cannot share the export's own class names.
 */
export const PREVIEW_OPEN = '<div id="pme-preview"><div class="pme-body"><div class="pme-content">';

/** Closes {@link PREVIEW_OPEN}. */
export const PREVIEW_CLOSE = '</div></div></div>';

/**
 * The document's YAML frontmatter block, or null when it has none.
 *
 * The same regex the VS Code extension uses to decide whether a save exports,
 * so "is this an export document" has one answer across both.
 */
export function frontmatterBlock(markdown: string): string | null {
    const m = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    return m ? m[1] : null;
}

/**
 * A top-level scalar from a frontmatter block, or null.
 *
 * Top-level only (no indentation), matched case-insensitively like the
 * exporter's own keys. Quotes are removed, and so is a trailing ` # comment`
 * outside them. A key whose value continues on the next lines — a mapping, as
 * `Style:` can be — reads as null here: it is not a name.
 */
export function frontmatterScalar(block: string, key: string): string | null {
    const lines = block.split(/\r?\n/);
    const lower = key.toLowerCase();
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0 || /^\s/.test(line)) continue;
        if (line.slice(0, colon).trim().toLowerCase() !== lower) continue;

        let value = line.slice(colon + 1).trim();
        const quote = value.charAt(0);
        if (quote === '"' || quote === "'") {
            const end = value.indexOf(quote, 1);
            value = end > 0 ? value.slice(1, end) : value.slice(1);
        } else {
            const hash = value.search(/\s#/);
            if (hash >= 0) value = value.slice(0, hash);
            if (value.charAt(0) === '#') value = '';
        }
        value = value.trim();
        return value ? value : null;
    }
    return null;
}

/**
 * `record[key]` when it is the record's own entry. The kit's maps are plain JSON
 * objects, and a document is free to write `Style: constructor`.
 */
function own(record: Record<string, string>, key: string): string | null {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
}

function present(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : null;
}

/**
 * Which kit stylesheet a document previews with, or null to leave it alone.
 *
 * Only documents that speak to this tool are touched: frontmatter declaring a
 * top-level `Mode`, `Theme` or `Style`. A README open in the same editor keeps
 * the previewer's own look.
 *
 * The theme follows the exporter's precedence — forced → `Theme` → env →
 * default — so the preview never shows a brand the export would not use. A
 * theme the kit does not hold (a typo, or one named by a path) returns null
 * rather than a wrong guess: the export would stop with "Theme not found".
 *
 * `Style` picks that style's stylesheet. A name the theme does not know gets
 * the `unknown` sheet, because that is not the same as naming no style: the
 * exporter then tints headings with the theme's default palette. A mapping
 * (`Style: { Color: … }`) is not generated and falls back to the base sheet.
 */
export function selectPreview(
    markdown: string,
    index: PreviewKitIndex,
    options: PreviewSelectOptions = {},
): PreviewPick | null {
    const block = frontmatterBlock(markdown);
    if (block === null) return null;
    if (declaresNoPreviewKey(block)) return null;

    const wanted = present(options.forcedTheme)
        ?? frontmatterScalar(block, 'Theme')
        ?? present(options.envTheme)
        ?? index.defaultTheme;
    const key = own(index.aliases, wanted.toLowerCase());
    const theme = key && Object.prototype.hasOwnProperty.call(index.themes, key) ? index.themes[key] : null;
    if (!key || !theme) return null;

    const style = frontmatterScalar(block, 'Style');
    if (!style) return { theme: key, file: theme.base };
    return { theme: key, file: own(theme.styles, style.toLowerCase()) ?? theme.unknown };
}

/** True when none of `Mode` / `Theme` / `Style` is a top-level key. */
function declaresNoPreviewKey(block: string): boolean {
    return !/^(?:mode|theme|style)[ \t]*:/im.test(block);
}

/**
 * A `<style>` element holding `css`.
 *
 * `</style` inside the text would end the element early and let the rest of the
 * stylesheet through as markup; a backslash is a no-op in CSS here.
 */
export function styleElement(css: string): string {
    return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
}

/** The attribute the MPE marker carries. */
const MARKER_ATTR = 'data-pme-preview';

/**
 * MPE, before parsing: appends a marker naming the chosen stylesheet.
 *
 * MPE's second hook sees only HTML, so the choice made from the frontmatter has
 * to travel through the render. It goes at the **end** of the document: a line
 * inserted anywhere earlier would shift every source line after it, and MPE's
 * scroll sync maps preview to editor by those line numbers.
 */
export function markPreview(markdown: string, pick: PreviewPick | null): string {
    if (!pick) return markdown;
    const file = pick.file.replace(/[^\w./-]/g, '');
    const newline = /\n$/.test(markdown) ? '' : '\n';
    return `${markdown}${newline}\n<div ${MARKER_ATTR}="${file}"></div>\n`;
}

/**
 * MPE, after parsing: replaces the marker with the wrapper and the stylesheet.
 *
 * The last marker wins — MPE runs the first hook for imported files as well, and
 * the importing document's marker is the one appended last. Every marker is
 * removed either way.
 *
 * The `<style>` goes after the content, never first: MPE sanitises the preview
 * with DOMPurify, which parses a fragment as a document body and hoists a
 * leading `<style>` into the head it then throws away.
 */
export function applyPreview(html: string, cssFor: (file: string) => string | null): string {
    const markerRe = new RegExp(`<div\\b[^>]*\\b${MARKER_ATTR}="([^"]*)"[^>]*>\\s*</div>`, 'g');
    const found: string[] = [];
    const stripped = html.replace(markerRe, (_match: string, file: string) => {
        found.push(file);
        return '';
    });
    if (found.length === 0) return html;
    const css = cssFor(found[found.length - 1]);
    if (css === null) return stripped;
    return `${PREVIEW_OPEN}${containWideContent(stripped)}${PREVIEW_CLOSE}${styleElement(css)}`;
}

/** The class of the box {@link containWideContent} puts around each table. */
export const SCROLL_CLASS = 'pme-scroll';

/**
 * Wraps every outermost `<table>` in a box that scrolls sideways on its own.
 *
 * A preview pane is often half an editor wide, and a table whose words the theme
 * will not break (a nine-column frontmatter table, a sizing table) is wider than
 * that. Left alone it widens the whole page, and the pane grows a horizontal
 * scrollbar that moves every paragraph along with the table. In its own box, only
 * the table scrolls — the way GitHub renders one — and the table keeps its
 * normal layout, which `display: block` on the table itself would not.
 *
 * Depth-counted, so a table inside a table is wrapped once, with its parent.
 */
export function containWideContent(html: string): string {
    const tagRe = /<(\/?)table\b[^>]*>/gi;
    let out = '';
    let last = 0;
    let depth = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
        if (m[1] === '') {
            if (depth++ === 0) {
                out += html.slice(last, m.index) + `<div class="${SCROLL_CLASS}">`;
                last = m.index;
            }
        } else if (depth > 0 && --depth === 0) {
            const end = m.index + m[0].length;
            out += html.slice(last, end) + '</div>';
            last = end;
        }
    }
    // An unclosed table (a document mid-edit) keeps its wrapper open to the end.
    return out + html.slice(last) + (depth > 0 ? '</div>' : '');
}
