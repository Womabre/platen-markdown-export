# Pipeline and CLI flow

How one export runs, from argv to the written output, and the modules that own each stage. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## Overview

The whole program is one async `main()` in `src/index.ts` that orchestrates a linear pipeline of string transformations on an HTML document. Each `src/*.ts` module owns one stage and exposes pure-ish functions plus the CSS it injects (modules export both their logic and their `*_CSS` constants, which `index.ts` assembles into `<head>`).

## Pipeline shape

**Pipeline shape** (`index.ts`):

1. **Markdown → HTML** — `markdown.ts` configures markdown-it with all the plugins (katex, anchor, attrs, container, footnote, github-alerts, task-lists, abbr) plus custom rules for includes, admonitions, draw.io image syntax, and hex color chips.
2. **Frontmatter** — `frontmatter.ts` parses YAML frontmatter (case-insensitive keys). The *source file* itself is edited only by the source write-back (`source-writeback.ts`, below): unless `--no-bump`, it stamps revision dates, and on `--release` it cuts the release. This source write-back is the main reason `--no-bump` exists for CI.
3. **Shared heavy preprocessing** (`renderDiagramsAndImages`) — runs **once** even when both PDF and HTML are requested: Mermaid rendering (`mermaid.ts`, headless Chromium), Graphviz rendering (`graphviz.ts`, a WASM build of Graphviz — `@hpcc-js/wasm-graphviz` — with no browser, no network, and no external binary), infographic rendering (`infographic.ts`, AntV Infographic's own SSR entry point — see below), and image inlining (`images.ts`, which converts/raster-compresses via `sharp`). draw.io is *not* done here — it's rendered per-mode because PDF wants PNG and HTML wants dual-theme SVG (`drawio.ts`).
4. **Two divergent finishing pipelines**, both ending in TOC injection + rebuild (`html.ts`):
   - `buildHtmlPipeline` → PDF: full cover page, page CSS with running header/footer, fallback fonts, then handed to WeasyPrint.
   - `buildHtmlExportPipeline` → standalone HTML: a lighter banner instead of a cover, dark-mode CSS, body marked `class="html-export"` so layout CSS can scope to it.
5. **WeasyPrint export** (`weasyprint.ts`) — the processed HTML is served **from memory** over an ephemeral **localhost HTTP server** (not file://) rooted at the document's directory, so relative asset references still resolve; `execFile`s the WeasyPrint binary against `http://127.0.0.1:<port>/<token>/...`. Nothing is written next to the user's document — `--mode debug` is the sole exception, writing an inspectable copy on purpose.

## Performance-shaped ordering matters

**Performance-shaped ordering matters**: the cover page and fallback-font fetches are kicked off as promises *before* the heavy diagram work so they overlap with Mermaid rendering. The shared preprocessing exists specifically to avoid doing Mermaid/image work twice in `--mode pdf,html`. Preserve this overlap when editing `main()`.

## Standalone commands

**Standalone commands** (`commands.ts`) — `--setup`, `--check-setup` and `--clear-cache` read no document. `standaloneCommand` returns the command to run, or null, with its side effects injected so precedence and `--check-setup --json`'s quiet stdout are tested without installing anything. It returns a thunk rather than running it because `main()` must not `await` before it reads the source document: the mid-export-edit tests in `main.test.ts` write the file right after calling `main()` and depend on that read having already happened.

## Export plan

**Export plan** (`plan.ts`) — the decision half of `main()`, with no I/O: theme-name precedence (`--theme` → `Theme` → `EXPORT_THEME` → default), stylesheet choice and its summary label, mode resolution, DPI, and the output paths. `resolveExportPlan` throws `ExitError` for usage errors and resolves both output paths **up front**, so a bad path fails before the expensive diagram work rather than after it. It is a separate module because the overwrite guard in `outputPathFor` — which stops an export writing over the user's own source document, reachable with an `.html` input in html mode and no revision — is a data-loss guard that had no test while it was a closure inside `main()`.

## Export execution

**Export execution** (`executeExport` in `index.ts`) — the doing half, split from `main()` for the same reason `plan.ts` and `watch.ts` were. `main()` now parses, resolves and validates, then hands a resolved `ExportPlan` to `executeExport`, which renders once and writes each requested output. The rules that live there had no direct coverage while they sat at the bottom of a 264-line function behind a `parseArgs` call: the shared render happens **once** even when both modes are requested; the source stamp is earned by the **first** output that lands (so a WeasyPrint failure in `--mode pdf,html` cannot leave the exported HTML and its own source disagreeing about the document's date); the revision *bump* waits for **every** output, so both artifacts carry the same pre-bump revision; and `--strict` is judged after the output is written, never instead of it.

## Watch loop

**Watch loop** (`watch.ts`) — `--watch`, extracted from `main()`'s file for the same reason `plan.ts` was: it was a closure nothing could reach. `startWatch(inputFile, deps)` takes the export itself, the directory watcher and the file read as injected dependencies and returns a handle, so the four rules that make it work are testable without a disk or a WeasyPrint run — the **self-write guard** (the export stamps the document it watches, so `main()` returns exactly what it wrote and a change matching that byte-for-byte is ours, never a reason to re-run; a timing-based guard would instead drop the edit you made *during* an export), the debounce that collapses an editor's multi-step save, the queue that runs a mid-export change once *after* it rather than concurrently or not at all, and the promise that a failed run never ends the watch. It watches the **directory**, not the file: `writeFileAtomic` and most editors replace a file by renaming a new one over it, which silently detaches an inode-bound watcher. What stays in `index.ts` is only what cannot be tested — the real export, the signal handlers, and blocking the process.

## PDF summary

**PDF summary** (`pdfinfo.ts`) — `countPdfPages` reads the page-tree root's `/Count`, falling back to counting `/Type /Page` dictionaries, and returns **null** when neither can be found. WeasyPrint Flate-compresses its object streams, so on its own output *none* of those markers exist as plain bytes — the scan inflates every deflate stream first (bounded, best-effort, non-deflate streams skipped), which is the only reason a page count appears at all. `summarizePdf` then omits the page count rather than printing a wrong one. The earlier version scanned only the last 512 KB and always returned a number, so long documents silently under-reported.

## Config

**Config** (`config.ts`) — tool-level `CONFIG` only (DPI, timeout, JPEG quality, render concurrency, MIME/raster/alert-color tables). Env vars `EXPORT_PDF_DPI`, `EXPORT_PDF_TIMEOUT_MS`, `EXPORT_PDF_IMAGE_QUALITY`, `EXPORT_PDF_CONCURRENCY` override it via `applyEnvOverrides`. No brand data lives here anymore.

## Error/exit conventions

**Error/exit conventions** — throw `ExitError(message, code)` from `errors.ts` for controlled exits; `main().catch` maps it to the documented exit codes (0 ok · 1 unexpected · 2 CLI usage · 3 file/asset not found · 4 WeasyPrint · 5 network). Use `log()` / `logResult()` from `logger.ts` (respects `--quiet`) rather than bare `console.log` for pipeline progress.
