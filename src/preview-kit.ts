/**
 * The preview kit: live-preview stylesheets built from the exporter's own CSS.
 *
 * An export is the only place a document is seen in its theme. While writing,
 * the preview is VS Code's built-in one or Markdown Preview Enhanced, each in its
 * own look. This module generates, for every discoverable theme and every style
 * it offers, the stylesheet an HTML export of such a document would carry — from
 * the very functions the export calls, never from a copy — and packages it for
 * the two previewers:
 *
 * - **css** (`--preview-kit <dir>`): `index.json`, one `.css` file per theme and
 *   style, and `preview-plugin.js`. The VS Code extension regenerates this in its
 *   own storage and reads it from a markdown-it plugin.
 * - **mpe** (`--preview-format mpe`): a single `parser.js` for a `.crossnote`
 *   folder, stylesheets embedded. MPE runs that file in a sandbox with no
 *   filesystem, and ignores `@import "x.css"` unless script execution is on, so
 *   the CSS has to travel inside it.
 *
 * Which stylesheet a document gets is decided at preview time by
 * `preview-plugin.ts`, which both formats carry verbatim.
 *
 * What a preview cannot show is not attempted: pages, the cover, running
 * headers, and anything the export draws rather than styles (diagrams, captions,
 * includes). Layer 1 is the look of the text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildHljsStyleBlock, buildThemeVarsCss, HTML_BODY_CSS } from './css';
import { ExitError } from './errors';
import { writeFileAtomic } from './fsutil';
import { EMOJI_CSS, HEADING_ICON_CSS, TABLE_FIT_CSS, TASK_LIST_CSS } from './html';
import { log } from './logger';
import { PREVIEW_KIT_SCHEMA, SCROLL_CLASS, type PreviewKitIndex, type PreviewSelectOptions } from './preview-plugin';
import { PREVIEW_RESET_CSS, PREVIEW_SCOPE, scopeForPreview } from './preview-css';
import { readLocalStylesheet } from './stylesheets';
import { applyStyleOverrides, buildStyleOverrideCss, DEFAULT_THEME, getActiveTheme, listThemeEntries, setActiveTheme } from './theme';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

/** The values `--preview-format` accepts. */
export const PREVIEW_FORMATS = ['css', 'mpe'] as const;
export type PreviewFormat = typeof PREVIEW_FORMATS[number];

/**
 * A style name no theme can hold, standing for "a name the theme does not know".
 *
 * The exporter treats an unknown `Style` differently from none — it tints
 * headings with the default palette — so that case gets its own stylesheet,
 * built by asking for a style that cannot exist.
 */
const UNKNOWN_STYLE = '*';

/**
 * Rules the preview adds on top of the export's CSS, deliberately unscoped.
 *
 * The preview stands in for the printed page, so every element the wrapper sits
 * inside — the editor's body, and any wrapper another extension adds, such as
 * GitHub-styles' dark one — takes the page's background, whatever the editor
 * theme. `:has()` reaches exactly those ancestors and nothing else; `!important`
 * because those wrappers set their own backgrounds with it.
 */
export function previewPageCss(background: string): string {
    const bg = background.trim() || '#ffffff';
    return `
/* ── Preview kit: the preview is the printed page ───────────────────────── */
:has(${PREVIEW_SCOPE}) {
    background-color: ${bg} !important;
    color-scheme: light;
}
${PREVIEW_SCOPE} {
    background-color: ${bg};
    color-scheme: light;
}
/* A table wider than the pane scrolls in its own box, never the whole page.
   Each box is positioned: KaTeX's hidden MathML copy is absolutely positioned,
   and without a positioned box around it a formula in a table cell escapes the
   box's clipping and widens the page all the same. */
${PREVIEW_SCOPE} .${SCROLL_CLASS} {
    position: relative;
    overflow-x: auto;
    max-width: 100%;
}
/* A table another extension adds after the boxes were placed (a frontmatter
   table, say) sits unboxed in the content: it scrolls by itself instead. */
${PREVIEW_SCOPE} .pme-content > table {
    position: relative;
    display: block;
    overflow-x: auto;
    max-width: 100%;
}
/* Display maths cannot wrap either; the formula scrolls, not the page. */
${PREVIEW_SCOPE} .katex-display {
    position: relative;
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
}`;
}

/** One stylesheet, split so the MPE format can store a theme's sheet once. */
export interface PreviewCss {
    /** Every `@import` statement, in order — CSS only honours them first. */
    imports: string;
    /** The theme stylesheet (identical for every style of a theme). */
    sheet: string;
    /** Everything the export adds after the theme stylesheet. */
    after: string;
}

/** A whole stylesheet from its parts. */
export function joinPreviewCss(css: PreviewCss): string {
    return [css.imports, css.sheet, css.after].filter(Boolean).join('\n');
}

/** The text of a `<style>` block, without the element. */
export function styleText(block: string): string {
    return block.replace(/^\s*<style[^>]*>/i, '').replace(/<\/style>\s*$/i, '');
}

/**
 * The export's CSS for the active theme and `style`, minus what a preview has no
 * use for (cover banner, diagram and dark-mode CSS), scoped by `preview-css.ts`, plus
 * {@link previewPageCss}.
 *
 * The order is the export's `<head>` order, because later rules win ties. The
 * theme must already be active with the style's overrides applied; `sheet` is
 * passed in because it does not depend on the style.
 */
export function buildPreviewCss(sheet: string, style: string | null): PreviewCss {
    const after = [
        styleText(buildThemeVarsCss()),
        HTML_BODY_CSS,
        styleText(buildHljsStyleBlock()),
        TASK_LIST_CSS,
        HEADING_ICON_CSS,
        EMOJI_CSS,
        TABLE_FIT_CSS,
        styleText(buildStyleOverrideCss(style)),
    ].filter(Boolean).join('\n');

    const fromSheet = scopeForPreview(sheet);
    const fromAfter = scopeForPreview(after);
    return {
        imports: [...fromSheet.imports, ...fromAfter.imports].join('\n'),
        // The reset leads the shared sheet, so it precedes every theme rule in both formats.
        sheet: `${PREVIEW_RESET_CSS}\n${fromSheet.rules.trim()}`,
        after: `${fromAfter.rules.trim()}\n${previewPageCss(getActiveTheme().background)}`,
    };
}

/** A file-name-safe form of a style name. */
function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'style';
}

/** Everything a writer needs, computed once. */
export interface PreviewKitPlan {
    index: PreviewKitIndex;
    /** Theme key → its stylesheet (the shared part). */
    sheets: Record<string, string>;
    /** Kit-relative path → that file's parts, and whose sheet it uses. */
    files: Record<string, { theme: string; css: PreviewCss }>;
}

/**
 * Builds the kit for every theme discoverable on the current search path.
 *
 * Aliases are assigned in `listThemeEntries()` order — external roots first —
 * and a name already taken is not reassigned, which is exactly how
 * `resolveThemeDir` picks among matches. A theme no name reaches (a built-in
 * shadowed under both its names) is left out.
 *
 * Each style reloads its theme: `applyStyleOverrides` edits the active theme in
 * place, and a style's font or background must not leak into the next one.
 */
export function planPreviewKit(): PreviewKitPlan {
    const index: PreviewKitIndex = {
        schema: PREVIEW_KIT_SCHEMA,
        generator: `platen-markdown-export ${version}`,
        defaultTheme: DEFAULT_THEME,
        aliases: {},
        themes: {},
    };
    const sheets: Record<string, string> = {};
    const files: PreviewKitPlan['files'] = {};

    for (const entry of listThemeEntries()) {
        const names = [entry.name, entry.displayName].map(n => n.toLowerCase());
        if (names.every(n => Object.prototype.hasOwnProperty.call(index.aliases, n))) continue;

        let key = entry.name.toLowerCase();
        for (let n = 2; Object.prototype.hasOwnProperty.call(index.themes, key); n++) key = `${entry.name.toLowerCase()}-${n}`;
        for (const n of names) {
            if (!Object.prototype.hasOwnProperty.call(index.aliases, n)) index.aliases[n] = key;
        }

        const theme = setActiveTheme(entry.dir);
        const rawSheet = readLocalStylesheet(theme.stylesheetFile, { keepIconImports: true }) ?? '';

        // Style names first, then palette names a style does not already claim:
        // the exporter resolves `Style: <palette>` to that palette's colour.
        const styleNames = [
            ...Object.keys(theme.styles),
            ...Object.keys(theme.palettes).filter(p =>
                !Object.keys(theme.styles).some(s => s.toLowerCase() === p.toLowerCase())),
        ];

        const used = new Set<string>();
        // `_base` / `_unknown` keep their underscore, which no slug of a style
        // name can produce — so a style called `Base` never shares their file.
        const fileFor = (name: string): string => {
            const stem = name.startsWith('_') ? name : slug(name);
            let base = stem;
            for (let n = 2; used.has(base); n++) base = `${stem}-${n}`;
            used.add(base);
            return `css/${key}/${base}.css`;
        };

        const build = (style: string | null, file: string): void => {
            setActiveTheme(entry.dir);
            applyStyleOverrides(style);
            files[file] = { theme: key, css: buildPreviewCss(rawSheet, style) };
        };

        const baseFile = fileFor('_base');
        build(null, baseFile);
        // Processed (reset first, imports lifted, selectors scoped) — the part every style shares.
        sheets[key] = files[baseFile].css.sheet;
        const unknownFile = fileFor('_unknown');
        build(UNKNOWN_STYLE, unknownFile);

        const styles: Record<string, string> = {};
        for (const name of styleNames) {
            const lower = name.toLowerCase();
            if (Object.prototype.hasOwnProperty.call(styles, lower)) continue;
            const file = fileFor(name);
            build(name, file);
            styles[lower] = file;
        }

        index.themes[key] = { name: entry.name, displayName: entry.displayName, base: baseFile, unknown: unknownFile, styles };
    }

    return { index, sheets, files };
}

/** The compiled selection module, as it ships beside this file. */
function previewPluginSource(): string {
    const file = path.join(__dirname, 'preview-plugin.js');
    return fs.readFileSync(file, 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
}

/**
 * Writes the css-format kit into `dir`.
 *
 * `index.json` is written last, so a reader that finds it can rely on every file
 * it names being there. Nothing is deleted: stylesheets from an earlier run that
 * the new index no longer names are simply unreachable, and this never removes a
 * file from a directory a person typed.
 */
export function writePreviewKit(dir: string, plan: PreviewKitPlan): string[] {
    const written: string[] = [];
    for (const [file, { css }] of Object.entries(plan.files)) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeFileAtomic(target, joinPreviewCss(css) + '\n');
        written.push(target);
    }
    const plugin = path.join(dir, 'preview-plugin.js');
    writeFileAtomic(plugin, previewPluginSource());
    written.push(plugin);

    const indexFile = path.join(dir, 'index.json');
    writeFileAtomic(indexFile, JSON.stringify(plan.index, null, 2) + '\n');
    written.push(indexFile);
    return written;
}

/** Marks a `parser.js` as this tool's, so a later run may replace it. */
export const MPE_PARSER_MARKER = 'platen-markdown-export: generated preview parser';

/**
 * True when an existing `parser.js` may be replaced: one this tool wrote, or one
 * whose hooks all return their input unchanged — the template MPE creates on its
 * own the first time it looks for the file, which is almost always what is there.
 */
export function isReplaceableParser(source: string): boolean {
    if (source.includes(MPE_PARSER_MARKER)) return true;
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/\s+/g, '');
    return /^\(\{(?:\w+:(?:async)?function\((\w+)\)\{return\1;?\},?)*\}\);?$/.test(code);
}

/** The `parser.js` source for Markdown Preview Enhanced. */
export function buildMpeParser(plan: PreviewKitPlan, options: PreviewSelectOptions): string {
    const files: Record<string, { theme: string; imports: string; after: string }> = {};
    for (const [file, { theme, css }] of Object.entries(plan.files)) {
        files[file] = { theme, imports: css.imports, after: css.after };
    }
    const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
    const indent = (text: string): string => text.split('\n').map(l => (l ? `    ${l}` : l)).join('\n');

    // One expression: MPE wraps the file in parentheses and evaluates it, so a
    // top-level statement would be a syntax error. The IIFE gives the embedded
    // module an `exports` object of its own, which the sandbox does not provide.
    return `// ${MPE_PARSER_MARKER} — do not edit by hand.
// Regenerate with: platen-markdown-export --preview-kit <this folder> --preview-format mpe
// Written by ${plan.index.generator}. Previews an export document (Mode/Theme/Style
// frontmatter) in its theme's CSS; other Markdown files are left untouched.
(function () {
  var exports = {};
  (function (exports) {
${indent(previewPluginSource().trimEnd())}
  })(exports);

  var INDEX = ${json(plan.index)};
  var OPTIONS = ${json({ forcedTheme: options.forcedTheme ?? null, envTheme: options.envTheme ?? null })};
  var SHEETS = ${json(plan.sheets)};
  var FILES = ${json(files)};

  function cssFor(file) {
    var f = Object.prototype.hasOwnProperty.call(FILES, file) ? FILES[file] : null;
    if (!f) return null;
    return [f.imports, SHEETS[f.theme], f.after].filter(Boolean).join('\\n');
  }

  return {
    onWillParseMarkdown: async function (markdown) {
      return exports.markPreview(markdown, exports.selectPreview(markdown, INDEX, OPTIONS));
    },
    onDidParseMarkdown: async function (html) {
      return exports.applyPreview(html, cssFor);
    },
  };
})()
`;
}

/**
 * Writes `parser.js` into `dir` (a `.crossnote` folder).
 *
 * Refuses, with exit code 2, to replace a parser someone wrote: MPE users put
 * their own hooks there, and losing them to a theme preview is not a trade
 * anyone asked for.
 */
export function writeMpeParser(dir: string, plan: PreviewKitPlan, options: PreviewSelectOptions): string {
    const target = path.join(dir, 'parser.js');
    if (fs.existsSync(target) && !isReplaceableParser(fs.readFileSync(target, 'utf8'))) {
        throw new ExitError(
            `Error: ${target} already has hooks of its own — not replacing it.\n` +
            'Move it aside (or merge its hooks by hand) and run this again.\n', 2);
    }
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(target, buildMpeParser(plan, options));
    return target;
}

/**
 * `--preview-kit <dir> [--preview-format css|mpe]`: builds and writes, returning
 * the summary printed on success.
 */
export function runPreviewKit(dir: string, format: PreviewFormat, options: PreviewSelectOptions): string {
    const plan = planPreviewKit();
    const themes = Object.keys(plan.index.themes).length;
    const sheets = Object.keys(plan.files).length;
    const target = path.resolve(dir);

    if (format === 'mpe') {
        const file = writeMpeParser(target, plan, options);
        log(`Wrote ${file}`);
        return `Preview parser for Markdown Preview Enhanced: ${file} (${themes} themes, ${sheets} stylesheets)\n` +
            'Set "markdown-preview-enhanced.previewTheme" to "none.css" so its own theme does not compete.';
    }

    writePreviewKit(target, plan);
    return `Preview kit: ${target} (${themes} themes, ${sheets} stylesheets)`;
}
