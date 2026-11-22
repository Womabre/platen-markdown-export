# Preview kit

Live-preview stylesheets for VS Code and Markdown Preview Enhanced (MPE), and the one plugin file that runs in three hosts. Modules: `preview-kit.ts`, `preview-css.ts`, `preview-plugin.ts`. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

`--preview-kit <dir>` writes a stylesheet for every theme and style, plus `_base` (no `Style`) and `_unknown` (a name the theme lacks, which the export tints with the default palette). `--preview-format mpe` also writes a `.crossnote/parser.js` for MPE.

## The CSS is the export's own

`buildPreviewCss` calls the same builders `buildHtmlExportPipeline` does, in its `<head>` order. `readLocalStylesheet` is the export's stylesheet reader, shared with `inlineLocalStylesheet`; the preview passes `keepIconImports`, since it has no document to scan for icons.

Never add a hand-written preview stylesheet.

## It is scoped, because a preview is someone else's page

`preview-css.ts` rewrites every rule under `#pme-preview`:

- `html`, `body`, `:root` and `body.html-export` become the wrapper.
- `.github-markdown-body`, `.markdown-body` and `.github-markdown-content` become `.pme-body` / `.pme-content`.
- A selector starting `.code-line` is confined to `pre`.
- `PREVIEW_RESET_CSS` (`all: revert` inside the wrapper, SVG and KaTeX excepted) goes first.

Why both halves are needed:

- VS Code puts `class="code-line"` on every block element, including `table`, `tr` and `td`. A bare `.code-line { display: inline-block; width: 100% }` from a theme stacks every table cell.
- The GitHub-styles extension scopes its dark CSS to `.github-markdown-body`, the export's own wrapper class, so its table rules outrank the theme's.
- The id outranks class-only third-party rules for properties the theme sets. The reset covers the properties it does not set.

Also: `@import`s are lifted to the front, `@page` is dropped, dark `prefers-color-scheme` blocks are dropped and light ones unwrapped, and `previewPageCss` paints every ancestor of the wrapper (`:has(#pme-preview)`) with the page background.

## Nothing may widen the page

A preview pane is narrow. Each outermost table is boxed in a `.pme-scroll` that scrolls on its own.

- **VS Code**: by `SCROLL_OPEN` / `SCROLL_CLOSE` tokens inserted in the core rule. Never by post-processing `renderer.render`: Mermaid, Marp and GitHub-styles all replace `render`, and one of them does not call the one it replaced, so a wrapper added there vanishes in the real editor.
- **MPE**: by `containWideContent` on the HTML string.
- A table another extension inserts after our core rule (YAML Preamble's frontmatter table) is caught by `.pme-content > table { display: block; overflow-x: auto }`. `.katex-display` gets the same.
- Every such box is `position: relative`. KaTeX's hidden MathML copy is absolutely positioned; in an unpositioned box a formula inside a table cell escapes the clipping and widens the page.

## Reproducing a preview bug

Use the user's **real** preview extensions: `markdown.api.render` in an extension host, plus their `markdown.previewStyles` in a dark-scheme browser page. Plain markdown-it has neither the scroll-sync classes nor the competing CSS.

## Each style reloads its theme

`applyStyleOverrides` mutates the theme singleton, so the kit reloads the theme before applying each style. `src/tests/preview-kit.test.ts` compares every `jasonm23`, `mixu` and `solarized` style against a fresh build.

## `preview-plugin.ts` has zero imports

The one compiled file runs in three hosts:

- The CLI copies it into the kit.
- The VS Code extension `require`s that copy, so the extension has no second implementation of theme selection.
- It is inlined into MPE's `parser.js`, which crossnote evaluates as a single expression inside a QuickJS WASM sandbox with no `require`, `process` or fs.

Selection mirrors `resolveThemeName` and `resolveThemeDir` aliasing. It themes only documents with a top-level `Mode`, `Theme` or `Style`.

## MPE specifics (each verified in crossnote's source)

- `@import "x.css"` is dropped unless `enableScriptExecution`, so the CSS is embedded.
- The marker naming the stylesheet is appended at the **end** of the markdown. An earlier line would shift MPE's scroll-sync line numbers.
- The `<style>` is appended **after** the content. DOMPurify hoists a leading `<style>` into a discarded head.
- `writeMpeParser` replaces only its own file or MPE's inert default template, and exits 2 otherwise.

## The extension side (`vscode-extension/src/preview.ts`)

- Contributes `markdown.markdownItPlugins`.
- Regenerates the kit in `globalStorage` on activation and when the theme-path, CLI or env settings change.
- Re-resolves the stylesheet at render time, because VS Code caches tokens per document. `markdown.preview.refresh` clears that cache.
