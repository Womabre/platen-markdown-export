# Pipeline and CLI flow

How one export runs, from argv to the written output, and the modules that own each stage. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## Overview

The program is one async `main()` in `src/index.ts` that runs a linear pipeline of string transformations on an HTML document. Each `src/*.ts` module owns one stage and exports its logic together with the CSS it injects (`*_CSS` constants), which `index.ts` assembles into `<head>`.

## Pipeline shape

1. **Markdown to HTML** - `markdown.ts` configures markdown-it with its plugins (katex, anchor, attrs, container, footnote, github-alerts, task-lists, abbr) plus custom rules for includes, admonitions, draw.io image syntax and hex colour chips.
2. **Frontmatter** - `frontmatter.ts` parses YAML frontmatter with case-insensitive keys. Only the source write-back (`source-writeback.ts`, see [frontmatter-and-source.md](frontmatter-and-source.md)) edits the source file: unless `--no-bump`, it stamps revision dates, and on `--release` it cuts the release. `--no-bump` exists mainly so CI does not mutate sources.
3. **Shared heavy preprocessing** (`renderDiagramsAndImages`) - runs once, also when both PDF and HTML are requested: Mermaid (`mermaid.ts`, headless Chromium), Graphviz (`graphviz.ts`, the WASM build `@hpcc-js/wasm-graphviz`: no browser, network or external binary), infographics (`infographic.ts`, through AntV Infographic's own SSR entry point, see [infographics.md](infographics.md)) and image inlining (`images.ts`, converting and compressing rasters via `sharp`). draw.io is rendered per mode instead, because PDF wants PNG and HTML wants dual-theme SVG (`drawio.ts`).
4. **Two finishing pipelines**, both ending in TOC injection and rebuild (`html.ts`):
   - `buildHtmlPipeline` for PDF: full cover page, page CSS with running header and footer, fallback fonts, then WeasyPrint.
   - `buildHtmlExportPipeline` for standalone HTML: a lighter banner instead of a cover, dark-mode CSS, and `class="html-export"` on the body so layout CSS can scope to it.
5. **WeasyPrint export** (`weasyprint.ts`) - the processed HTML is served from memory by an ephemeral localhost HTTP server (not `file://`) rooted at the document's directory, so relative asset references resolve. WeasyPrint is `execFile`d against `http://127.0.0.1:<port>/<token>/...`. Nothing is written next to the user's document, except by `--mode debug`, which writes an inspectable copy on purpose. The server's security rules are in [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md).

## Ordering that must be kept

In `executeExport`:

- **Overlap.** The cover page and fallback-font fetches start as promises before the heavy diagram work, so they overlap with Mermaid rendering.
- **One shared render.** The shared preprocessing exists so `--mode pdf,html` does the Mermaid and image work once.

In `main()`:

- **Style overrides before the CSS builders.** `applyStyleOverrides(style)` runs right after `setActiveTheme` (see [themes.md](themes.md) § Themes).
- **No `await` before the source document is read, on the export path.** See Standalone commands below.

## Standalone commands (`commands.ts`)

`--setup`, `--check-setup` and `--clear-cache` read no document. `standaloneCommand` returns the command to run, or null, with its side effects injected, so precedence and the quiet stdout of `--check-setup --json` are tested without installing anything (`src/tests/commands.test.ts`).

It returns a thunk and does not run it, because `main()` must not `await` before it reads the source document: the mid-export-edit tests in `main.test.ts` write the file right after calling `main()` and depend on that read having already happened.

## Export plan (`plan.ts`)

The decision half of `main()`, with no I/O: theme-name precedence (`--theme`, then `Theme`, then `EXPORT_THEME`, then default), stylesheet choice and its summary label, mode resolution, DPI and the output paths.

- `resolveExportPlan` throws `ExitError` for usage errors and resolves both output paths up front, so a bad path fails before the diagram work.
- The overwrite guard in `outputPathFor` stops an export writing over the user's own source document (reachable with an `.html` input in html mode and no revision). It is a data-loss guard, tested in `src/tests/plan.test.ts`.

## Export execution (`executeExport` in `index.ts`)

The doing half. `main()` parses, resolves and validates, then hands a resolved `ExportPlan` to `executeExport`, which renders once and writes each requested output. Its rules:

- The shared render happens once, also when both modes are requested.
- The source stamp is earned by the **first** output that lands, so a WeasyPrint failure in `--mode pdf,html` cannot leave the exported HTML and its source disagreeing about the document's date.
- The revision bump waits for **every** output, so both artifacts carry the same pre-bump revision.
- `--strict` is judged after the output is written, never instead of it.

## Watch loop (`watch.ts`)

`startWatch(inputFile, deps)` takes the export, the directory watcher and the file read as injected dependencies and returns a handle, so its rules are tested without a disk or a WeasyPrint run (`src/tests/watch.test.ts`; that `main()` returns what it wrote is in `src/tests/main.test.ts`):

- **Self-write guard.** The export stamps the document it watches, so `main()` returns exactly what it wrote, and a change matching that byte for byte is ours and never a reason to re-run. A timing-based guard would drop the edit made during an export.
- **Debounce** collapses an editor's multi-step save.
- **Queue.** A change during an export runs once after it, never concurrently and never dropped.
- **A failed run never ends the watch.**
- **It watches the directory, not the file.** `writeFileAtomic` and most editors replace a file by renaming a new one over it, which silently detaches an inode-bound watcher.

`index.ts` keeps only what cannot be tested: the real export, the signal handlers, and blocking the process.

## PDF summary (`pdfinfo.ts`)

`countPdfPages` reads the page-tree root's `/Count`, falls back to counting `/Type /Page` dictionaries, and returns **null** when neither is found. `summarizePdf` then omits the page count; it never prints a guessed one.

WeasyPrint Flate-compresses its object streams, so none of those markers exist as plain bytes in its output. The scan therefore inflates every deflate stream first (bounded, best-effort, non-deflate streams skipped) and covers the whole file. Tests: `src/tests/pdfinfo.test.ts`.

## Config (`config.ts`)

Tool-level `CONFIG` only: DPI, timeout, JPEG quality, render concurrency, and the MIME, raster and alert-colour tables. `applyEnvOverrides` reads `EXPORT_PDF_DPI`, `EXPORT_PDF_TIMEOUT_MS`, `EXPORT_PDF_IMAGE_QUALITY` and `EXPORT_PDF_CONCURRENCY`. Brand data lives in themes, never here.

## Errors and exit codes

Throw `ExitError(message, code)` from `errors.ts` for a controlled exit; `main().catch` is the one place that maps it to the process exit code. The codes, as `--help` (`cli.ts`) documents them:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | CLI usage error |
| 3 | Input file or required asset not found |
| 4 | WeasyPrint or Chromium not found or failed |
| 5 | Network or fetch error |
| 6 | Warnings were raised and `--strict` was given |

The extension maps the same codes in `EXIT_MESSAGES` (`vscode-extension/src/core.ts`). `vscode-extension/src/tests/core.test.ts` parses the codes out of the `--help` text and fails when `EXIT_MESSAGES` drifts from it, so a new code is added in both places.

Pipeline progress goes through `log()` / `logResult()` from `logger.ts`. `--quiet` silences `log()` except for WARNING lines; `logResult()`, the final result line, always prints. ESLint does not flag a bare `console.log` (`no-console` is off), so this one is on the author.
