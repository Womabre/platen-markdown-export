# Infographics

AntV Infographic rendering. Modules: `infographic.ts`, `infographic-worker.ts`, `infographic-svg.ts`, `infographic-icons.ts`, `infographic-fonts.ts`. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## The library runs in a worker thread

Its SSR DOM shim assigns `window`, `document` and forty-odd DOM constructors onto `globalThis` and never removes them. In the main process every other library would believe it runs in a browser for the rest of the export, and for a whole `--watch` session.

`src/tests/infographic.test.ts` asserts the main thread stays clean.

## Its raw SVG does not survive WeasyPrint

All text is HTML inside `<foreignObject>`, which WeasyPrint does not draw. `infographic-svg.ts` rebuilds each as native `<text>`: pure string work, with the measurer injected (`src/tests/infographic-svg.test.ts`).

## Every request the library makes is proxied to the main thread

The worker replaces `globalThis.fetch` **before** importing the library, which captures it at import time. `decideIconRequest` then decides each request under `--infographic-icons` (`iconify` default, `weavefox`, `none`).

- **That setting is machine-level only**: the flag, `EXPORT_INFOGRAPHIC_ICONS`, or the machine-scoped VS Code setting. It must never become a frontmatter key. A received document must not be able to opt the machine into sending its text to Ant Group's servers. No test enforces this; it is held by review. `decideIconRequest` itself is tested in `src/tests/infographic-icons.test.ts`.
- Iconify icons are cached in memory only. Their URLs are not versioned, so the disk-cache rule for unpinned remote assets applies.

## A theme font the library names is bundled, not fetched

`infographic-fonts.ts` and `assets/fonts/` carry the `hand-drawn` theme's `851tegakizatsu`, which would otherwise come from Ant Group's CDN.

- Its `@font-face` goes **inside the SVG**. A browser renders an `<img>` SVG as its own document, so the page's CSS never reaches it. WeasyPrint accepts either.
- The family is **quoted** in every `font-family`. A CSS identifier may not start with a digit, and unquoted `851tegakizatsu` invalidates the whole declaration; Chrome then falls back to its default serif.
- Wrapping is measured with that font's own measury metrics.
- Tests: `src/tests/infographic-fonts.test.ts`.

## Checking rendered output

Rasterise PDFs with macOS Quartz (`sips -s format png`), not poppler. Poppler's `pdftoppm` fails to draw WeasyPrint 70's SVG gradients, so every bar of a column chart vanishes, while Preview and Quartz render them correctly.
