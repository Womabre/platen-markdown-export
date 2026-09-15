#!/usr/bin/env node
'use strict';

import { findWeasyprint, runBootstrap } from './bootstrap';
import * as fs                      from 'fs';
import * as path                    from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../package.json') as { version: string };
import { parseArgs, resolveThemeRoots } from './cli';
import { resolveExportPlan, resolveThemeName, type ExportPlan } from './plan';
import { log, logResult }            from './logger';
import { extractFrontmatter, bumpRevisionAfterExport, isReleasedStatus } from './frontmatter';
import { convertMarkdownToHtml, prepareSourceUpdates, type PendingSourceUpdate } from './markdown';
import { inlineImages, injectLogoElements, checkLocalImages, type PageGeometry } from './images';
import { buildCoverPage, buildHtmlBanner, HTML_BANNER_CSS, buildStyleOverrideCss, resolveStyleMainColor, validateDocumentColors } from './cover';
import { setActiveTheme, applyStyleOverrides, applyLogoOverride, setThemeRoots } from './theme';
import { buildPageCss, buildPageMetricsCss, buildFallbackFontStyles, buildHljsStyleBlock, buildThemeVarsCss, HTML_BODY_CSS, buildHtmlDarkModeCss } from './css';
import { buildIconStyles, inlineRemoteStylesheets, inlineLocalStylesheet, clearCssImportCache } from './stylesheets';
import { injectTocWrapper, rebuildToc, inlineAlertIconColors, inlineAdmonitionIconColors, inlineHexColorCode, replaceTaskListInputs, wrapEmoji, numberHeadings, buildCaptionIndex, injectCaptionIndexes, buildWatermark, buildClassificationHeader, injectPageChrome, addBodyClasses, injectDocumentMetadata, injectCodeFontDefaults, TASK_LIST_CSS, HEADING_ICON_CSS, EMOJI_CSS, TABLE_FIT_CSS } from './html';
import { renderMermaidDiagrams, MERMAID_CSS, hasMermaidPlaceholders, mermaidUnavailableReason } from './mermaid';
import { renderGraphvizDiagrams, GRAPHVIZ_CSS, hasGraphvizPlaceholders } from './graphviz';
import { renderInfographicDiagrams, INFOGRAPHIC_CSS, hasInfographicPlaceholders } from './infographic';
import type { InfographicIconProvider } from './config';
import { renderDrawioDiagrams } from './drawio';
import { applyCaptions, markDenseTables } from './markdown-extras';
import { startServer, exportPdf, colorEmojiRenderingSupported } from './weasyprint';
import { startWatch }             from './watch';
import { spawn } from 'child_process';
import { validate }                 from './validate';
import { writeFileAtomic }          from './fsutil';
import { summarizePdf }             from './pdfinfo';
import { clearCache }               from './cache';
import { literal }                  from './strings';
import { CONFIG_WARNINGS }           from './config';
import { setQuiet, resetWarnings, warningCount } from './logger';
import { ExitError }                from './errors';
import type { FrontmatterData, CoverPage, ExportResult } from './types';

/**
 * Fails the run when `--strict` was given and anything warned.
 *
 * Checked AFTER the output is written, deliberately. A warning means the
 * document has a problem, not that the export could not happen — and seeing the
 * broken artifact is usually how you work out what the warning meant. So the
 * file is produced and the exit code is what refuses it.
 */
function assertNoWarnings(strict: boolean): void {
    const n = warningCount();
    if (!strict || n === 0) return;
    throw new ExitError(
        `--strict: ${n} warning${n === 1 ? '' : 's'} raised — see the log above.\n` +
        '  The output was still written; the exit code is what refuses it.', 6);
}

/** A run that produced no output and therefore read nothing worth watching. */
const NOTHING_EXPORTED: ExportResult = { sourceWritten: null, dependencies: [] };

// ── Shared heavy preprocessing ────────────────────────────────────────────────

/** How the shared diagram step renders. Every field optional, with safe defaults. */
export interface DiagramOptions {
    /**
     * Whether diagrams strip emoji before embedding. Default true (the safe,
     * historical behaviour); `main()` passes false only once
     * `colorEmojiRenderingSupported` has confirmed the target WeasyPrint can
     * render them — see weasyprint.ts.
     */
    stripDiagramEmoji?: boolean;
    /** Where ```infographic icons come from. Default: CONFIG.infographicIcons. */
    infographicIcons?: InfographicIconProvider;
}

/**
 * Runs the expensive content transformations shared by the PDF and HTML
 * pipelines exactly once: Mermaid rendering (headless Chromium), Graphviz
 * rendering (WASM), infographics (AntV SSR, in a worker thread), draw.io
 * exports, and image inlining. When both modes are requested this halves the
 * heavy work.
 */
export async function renderDiagramsAndImages(
    htmlContent: string,
    htmlFile: string,
    geometry?: PageGeometry,
    deps?: Set<string>,
    opts: DiagramOptions = {},
): Promise<string> {
    const stripDiagramEmoji = opts.stripDiagramEmoji ?? true;

    log('Rendering Mermaid diagrams...');
    htmlContent = await renderMermaidDiagrams(htmlContent, stripDiagramEmoji);

    log('Rendering Graphviz diagrams...');
    htmlContent = await renderGraphvizDiagrams(htmlContent, stripDiagramEmoji);

    htmlContent = await renderInfographicDiagrams(htmlContent, {
        stripEmoji: stripDiagramEmoji,
        iconProvider: opts.infographicIcons,
    });

    // Table/Figure captions run here, not inside markdown.ts's render step: a
    // Mermaid diagram is still an unrendered code fence at that point, not yet
    // the <img> its "Figure: ..." caption needs to attach to.
    htmlContent = applyCaptions(htmlContent);
    htmlContent = markDenseTables(htmlContent);

    // Replace emoji with Twemoji <img>s before inlining so they're embedded as
    // data URIs (baseline-aligned, font-independent) in the same pass.
    htmlContent = wrapEmoji(htmlContent);

    // draw.io is rendered per output mode (PNG for PDF, dual SVG for HTML) in the
    // respective pipelines — inlineImages skips .drawio sources so they survive
    // this shared step untouched.
    log('Inlining images...');
    // The cap an oversized photo is resized to comes from the document's own
    // page, not from a fixed A4 portrait assumption — see `bodyImageCap`.
    return inlineImages(htmlContent, htmlFile, geometry, deps);
}

// ── Shared pipeline stages ────────────────────────────────────────────────────

/**
 * Colour and control passes both output modes need, in an order that matters:
 * the icon-colour passes rewrite class-driven accents into inline styles (which
 * WeasyPrint needs and the HTML export is happy with), and the task-list pass
 * swaps real `<input>` elements for glyphs.
 */
function applyInlineColorPasses(htmlContent: string): string {
    htmlContent = inlineAlertIconColors(htmlContent);
    htmlContent = inlineAdmonitionIconColors(htmlContent);
    htmlContent = inlineHexColorCode(htmlContent);
    return replaceTaskListInputs(htmlContent);
}

/**
 * The tail both pipelines end on: wrap the source TOC, rebuild it from every
 * heading in the merged document, then append the caption indexes.
 *
 * Order is load-bearing. `rebuildToc` reads heading text with tags stripped, so
 * anything that changes heading text (numbering, in particular) must already
 * have run; and the caption indexes are built from the finished document so
 * they cannot disagree with it.
 */
function finishDocument(
    htmlContent: string,
    fm: Pick<FrontmatterData, 'tocDepth' | 'listOfTables' | 'listOfFigures'>,
): string {
    log('Injecting TOC wrapper...');
    htmlContent = injectTocWrapper(htmlContent);

    log('Rebuilding TOC from merged headings...');
    htmlContent = rebuildToc(htmlContent, fm.tocDepth);

    return injectCaptionIndexes(htmlContent, [
        fm.listOfTables  ? buildCaptionIndex(htmlContent, 'table',  'List of Tables')  : '',
        fm.listOfFigures ? buildCaptionIndex(htmlContent, 'figure', 'List of Figures') : '',
    ]);
}

// ── HTML processing pipeline ──────────────────────────────────────────────────

/**
 * Transforms preprocessed HTML (diagrams rendered, images inlined) into a fully
 * self-contained document ready for WeasyPrint: inlines fonts, injects the
 * cover page, icon fonts, page CSS and the TOC wrapper.
 *
 * The cover page and fallback fonts arrive as promises kicked off by the caller
 * before diagram rendering, so they don't add to the critical path on documents
 * that have both.
 */
export async function buildHtmlPipeline(
    htmlContent: string,
    htmlFile: string,
    stylesheetPath: string | null,
    fm: FrontmatterData,
    coverPromise: Promise<CoverPage | null>,
    fallbackFontsPromise: Promise<string>,
    deps?: Set<string>,
): Promise<string> {
    const { title, revisions, revisionsVisible,
            revision, header, footer, date, author, status, style,
            numberedHeadings, runningHeader,
            watermark, codeLineNumbers, classification,
            pageSize, margins, orientation, footerLogo } = fm;

    // Before anything else touches <head>: the document's own title and author,
    // which are what WeasyPrint writes into the PDF's /Title and /Author.
    htmlContent = injectDocumentMetadata(htmlContent, { title, author });
    htmlContent = injectCodeFontDefaults(htmlContent);

    log('Rendering draw.io diagrams (PNG)...');
    htmlContent = await renderDrawioDiagrams(htmlContent, path.dirname(htmlFile), 'png', deps);

    // Before the TOC is rebuilt, so the numbers flow into it automatically.
    if (numberedHeadings) {
        log('Numbering headings...');
        htmlContent = numberHeadings(htmlContent);
    }

    log('Injecting logo elements...');
    htmlContent = await injectLogoElements(htmlContent, footerLogo, deps);

    const cover = await coverPromise;
    if (cover) {
        htmlContent = htmlContent.replace(
            /<body([^>]*)>/,
            (_match: string, attrs: string) => `<body${attrs}>\n${cover.html}`,
        );
        const hasTable = revisionsVisible > 0 && revisions?.length;
        log(`Cover page injected${hasTable ? ` (with ${Math.min(revisionsVisible, revisions!.length)} revision rows)` : ''}`);
    } else {
        log('No style specified, skipping cover page');
    }

    // Page chrome goes in before buildIconStyles() below, which scans the
    // document for icon classes — the classification label carries a Phosphor
    // shield, and a later injection would miss that scan and ship no glyph.
    const classificationHtml = classification ? buildClassificationHeader(classification) : '';
    if (watermark || classificationHtml) {
        log(`Injecting page chrome${watermark ? ` (watermark: ${watermark})` : ''}${classificationHtml ? ` (classification: ${classification})` : ''}...`);
        htmlContent = injectPageChrome(htmlContent, [
            watermark ? buildWatermark(watermark) : '',
            classificationHtml,
        ]);
    }

    if (codeLineNumbers) {
        htmlContent = addBodyClasses(htmlContent, ['code-line-numbers']);
    }

    log('Inlining remote stylesheets...');
    htmlContent = await inlineRemoteStylesheets(htmlContent);

    log('Inlining local stylesheet...');
    htmlContent = inlineLocalStylesheet(htmlContent, stylesheetPath, true, deps);

    log('Inlining alert icon colors...');
    htmlContent = applyInlineColorPasses(htmlContent);

    log('Injecting page CSS, cover CSS, fallback fonts, and icon fonts into <head>...');
    const footerDate          = revisions.at(-1)?.date ?? date;
    const pageCss            = buildPageCss({
        title, header, footer, date: footerDate, revision, status, author,
        runningHeader, classification: Boolean(classificationHtml),
        pageSize, margins, orientation, hasCover: Boolean(cover),
    });
    const fallbackFontStyles = await fallbackFontsPromise;
    const iconStyles         = await buildIconStyles(htmlContent);
    const headStyles = [
        buildThemeVarsCss(),
        buildPageMetricsCss(pageSize, margins, orientation),
        fallbackFontStyles,
        iconStyles,
        buildHljsStyleBlock(),
        cover ? `${pageCss}\n${cover.css}` : pageCss,
        `<style>${MERMAID_CSS}</style>`,
        `<style>${GRAPHVIZ_CSS}</style>`,
        `<style>${INFOGRAPHIC_CSS}</style>`,
        `<style>${TASK_LIST_CSS}</style>`,
        `<style>${HEADING_ICON_CSS}</style>`,
        `<style>${EMOJI_CSS}</style>`,
        `<style>${TABLE_FIT_CSS}</style>`,
        buildStyleOverrideCss(style),
    ].filter(Boolean).join('\n');

    htmlContent = htmlContent.replace('</head>', literal(`${headStyles}\n</head>`));

    return finishDocument(htmlContent, fm);
}

// ── HTML export pipeline ──────────────────────────────────────────────────────

/**
 * Lighter pipeline for --mode html: skips WeasyPrint-specific steps (page CSS,
 * running header/footer logos, fallback fonts) and injects a banner instead of
 * the full cover page. Expects preprocessed HTML (diagrams rendered, images
 * inlined by renderDiagramsAndImages).
 */
export async function buildHtmlExportPipeline(
    htmlContent: string,
    htmlFile: string,
    stylesheetPath: string | null,
    fm: FrontmatterData,
    deps?: Set<string>,
): Promise<string> {
    const { title, documentInfo, revisions, revisionsVisible, coverLogo, style,
            numberedHeadings, codeLineNumbers,
            classification, coverTitleColor } = fm;

    htmlContent = injectDocumentMetadata(htmlContent, { title, author: fm.author });

    log('Rendering draw.io diagrams (dual-theme SVG)...');
    htmlContent = await renderDrawioDiagrams(htmlContent, path.dirname(htmlFile), 'svg', deps);

    if (numberedHeadings) {
        log('Numbering headings...');
        htmlContent = numberHeadings(htmlContent);
    }

    // Watermark and running headers are paged-media concepts with no meaning in
    // a continuously-scrolling HTML page, so only the classification carries over.
    const classificationHtml = classification ? buildClassificationHeader(classification) : '';
    if (classificationHtml) {
        htmlContent = injectPageChrome(htmlContent, [classificationHtml]);
    }

    log('Building HTML banner...');
    const banner = await buildHtmlBanner({
        title, documentInfo, revisions, revisionsVisible, style, coverLogo,
        baseDir: path.dirname(htmlFile), coverTitleColor, deps,
    });
    htmlContent = htmlContent.replace(/<body([^>]*)>/, (_, attrs) => `<body${attrs}>\n${banner}`);

    log('Inlining local stylesheet...');
    htmlContent = inlineLocalStylesheet(htmlContent, stylesheetPath, false, deps);

    log('Inlining alert icon colors...');
    htmlContent = applyInlineColorPasses(htmlContent);

    log('Injecting styles into <head>...');
    const iconStyles = await buildIconStyles(htmlContent);
    const headStyles = [
        buildThemeVarsCss(),
        `<style>${HTML_BODY_CSS}</style>`,
        iconStyles,
        buildHljsStyleBlock(),
        `<style>${MERMAID_CSS}</style>`,
        `<style>${GRAPHVIZ_CSS}</style>`,
        `<style>${INFOGRAPHIC_CSS}</style>`,
        `<style>${TASK_LIST_CSS}</style>`,
        `<style>${HEADING_ICON_CSS}</style>`,
        `<style>${EMOJI_CSS}</style>`,
        `<style>${TABLE_FIT_CSS}</style>`,
        `<style>${HTML_BANNER_CSS}</style>`,
        buildStyleOverrideCss(style),
        // Last: dark-mode overrides must follow the style override so their
        // !important heading rule wins under prefers-color-scheme: dark.
        buildHtmlDarkModeCss(resolveStyleMainColor(style)),
    ].filter(Boolean).join('\n');
    htmlContent = htmlContent.replace('</head>', literal(`${headStyles}\n</head>`));

    // Mark body so banner + layout CSS can scope to html-export context
    htmlContent = addBodyClasses(htmlContent, ['html-export', codeLineNumbers && 'code-line-numbers']);

    return finishDocument(htmlContent, fm);
}

// ── WeasyPrint export + cleanup ───────────────────────────────────────────────

/**
 * The command that hands a file to the OS's default viewer.
 *
 * Windows needs care: the old `cmd /c start "" <path>` re-parses its arguments
 * through the shell, so `&`, `^` and friends in a filename break it — and a
 * document called `Q1 & Q2.pdf` is an ordinary thing to have. PowerShell's
 * `-LiteralPath` takes the string as-is (no wildcard expansion either); single
 * quotes are escaped by doubling, which is PowerShell's own convention.
 *
 * Exported for testing — the platform branch is otherwise unreachable from the
 * machine running the suite.
 */
export function openCommand(platform: NodeJS.Platform, filePath: string): [string, string[]] {
    if (platform === 'win32') {
        const escaped = filePath.replace(/'/g, "''");
        return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -LiteralPath '${escaped}'`]];
    }
    return platform === 'darwin' ? ['open', [filePath]] : ['xdg-open', [filePath]];
}

/** Hands a finished output — PDF or HTML — to the OS's default application. */
function openFile(filePath: string): void {
    const [cmd, args] = openCommand(process.platform, filePath);
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

interface ExportOptions {
    weasyprintPath: string;
    htmlFile: string;
    pdfFile: string;
    dpi: number;
    pdfVariant: string | null;
    mode: string;
    startMs: number;
    open: boolean;
}

async function runExport(htmlContent: string, opts: ExportOptions): Promise<void> {
    const { weasyprintPath, htmlFile, pdfFile, dpi, pdfVariant, mode, open } = opts;

    // The processed document never needs to exist on disk: it is served from
    // memory, under the document's own directory so its relative asset
    // references still resolve. `--mode debug` additionally writes a copy for
    // the human to inspect — the only case that touches the filesystem.
    const servedName = `${path.basename(htmlFile).replace(/\.html$/, '')}_tmp.html`;

    if (mode === 'debug') {
        // The served name needs no disambiguation — memory is per-process — but
        // this one lands on a shared filesystem, so it keeps the pid suffix that
        // stops two concurrent debug exports of the same document colliding.
        const debugFile = path.join(path.dirname(htmlFile), `${servedName.replace(/\.html$/, '')}-${process.pid}.html`);
        writeFileAtomic(debugFile, htmlContent);
        log(`Temp file kept for inspection: ${debugFile}`);
    }

    const { server, urlFor } = await startServer(htmlFile, { files: { [servedName]: htmlContent } });
    try {
        await exportPdf(weasyprintPath, urlFor(servedName), pdfFile, dpi, pdfVariant);
        const elapsedS = ((Date.now() - opts.startMs) / 1000).toFixed(1);
        logResult(`${summarizePdf(pdfFile)} in ${elapsedS} s`);
        if (open) openFile(pdfFile);
    } finally {
        server.close();
        log('=== Export finished ===');
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Writes the deferred source edits, once an export has actually produced a file.
 *
 * Called after every output, and safe to call more than once: `commit()` writes
 * at most once and reports whether it did. The invariant is that the source is
 * stamped as soon as ANY output exists — an exported file and the document it
 * came from must not disagree about the document's own revision date.
 *
 * Runs before `bumpRevisionAfterExport`, which re-reads the document from disk:
 * the bump has to see the stamped date, not the content it replaced.
 */
function commitSourceUpdates(pending: PendingSourceUpdate | null): string | null {
    // `commit()` reports whether it actually wrote, so calling this after each
    // output — as `--mode pdf,html` does — writes and logs exactly once.
    if (!pending?.commit()) return null;
    const what = [
        pending.dateStamped ? 'revision date' : '',
        pending.tocCleaned  ? 'TOC link attributes' : '',
    ].filter(Boolean).join(' + ');
    log(`Updated source document (${what})`);
    // Returned so `--watch` can tell this write apart from a real edit.
    return pending.content;
}


/**
 * The block of `Key : value` lines a run opens with.
 *
 * Eighteen `log()` calls that only read what `main()` had already resolved, so
 * they were eighteen lines of `main()` that could never do anything else. Out
 * here they are also a single place to add a field to.
 */
function logStartupSummary(o: {
    inputFile: string;
    markdownFile: string | null;
    modes: string[];
    stylesheetLabel: string;
    fm: FrontmatterData;
    themeName: string;
    /** null when the run produces no PDF, so the line is omitted. */
    dpi: number | null;
    /** null for an ordinary PDF, so the line is omitted. */
    pdfVariant: string | null;
}): void {
    const { fm } = o;
    log('=== Export started ===');
    log(`Version    : platen-markdown-export v${APP_VERSION}`);
    log(`Input      : ${o.inputFile}`);
    log(`Mode       : ${o.modes.length ? o.modes.join(', ') : 'none (dry-run)'}`);
    log(`Markdown   : ${o.markdownFile}`);
    log(`Stylesheet : ${o.stylesheetLabel}`);
    log(`Title      : ${fm.title || 'not found'}`);
    log(`Revision   : ${fm.revision ?? 'not found'}`);
    log(`Revisions  : ${fm.revisions?.length ?? 0} entries`);
    log(`Author     : ${fm.author ?? 'not found'}`);
    log(`Status     : ${fm.status ?? 'not found'}`);
    log(`Date       : ${fm.date ?? 'not found'}`);
    log(`Header     : ${fm.header ?? 'default'}`);
    log(`Footer     : ${fm.footer ?? 'default'}`);
    log(`Lang       : ${fm.lang}`);
    log(`Theme      : ${o.themeName}`);
    log(`Style      : ${fm.style !== null ? JSON.stringify(fm.style) : 'none'}`);
    if (o.dpi !== null) log(`DPI        : ${o.dpi}`);
    if (o.pdfVariant !== null) log(`PDF Variant: ${o.pdfVariant}`);
}

/**
 * What `--dry-run` does: check, report, write nothing.
 *
 * Everything before this in `main()` is already validation — the theme loaded,
 * the colour keys parsed, the output paths resolved, WeasyPrint located. What is
 * left is the half a dry run has to do for itself: render the markdown, because
 * resolving the includes is what makes an unresolved `[!include]` visible, and
 * scan the result for local images, because that is the other problem people
 * actually hit. Neither costs a diagram render, a network fetch or a byte on
 * disk, which is the whole point.
 */
async function reportDryRun(o: {
    isMarkdownInput: boolean;
    inputFile: string;
    htmlFile: string;
    markdownFile: string | null;
    fm: FrontmatterData;
    pending: PendingSourceUpdate | null;
    modes: string[];
    htmlOutputFile: string | null;
    pdfOutputFile: string | null;
}): Promise<void> {
    log('Dry run     : nothing will be rendered or written');

    if (o.isMarkdownInput && o.markdownFile) {
        // No dependency accumulator: a dry run reports nothing to watch.
        const rendered = await convertMarkdownToHtml(o.inputFile, o.pending?.content, o.fm);
        checkLocalImages(rendered, o.htmlFile);

        // The external binary a Mermaid document needs, checked the way
        // WeasyPrint already is for a pdf mode — by asking whether it is there,
        // not by running it. Playwright pins its browser to the package
        // version, so an ordinary `playwright` upgrade orphans a working
        // install and the next export dies partway through. Nothing else can
        // catch that: every CI job installs the browser fresh, so none of them
        // ever has an existing one to invalidate.
        if (hasMermaidPlaceholders(rendered)) {
            // The reason, not just the fact: a missing playwright package and a
            // missing Chromium binary need different commands to fix.
            const reason = await mermaidUnavailableReason();
            if (reason) throw new ExitError(reason, 4);
        }
    }

    if (o.modes.length === 0) log('Would export: nothing — no Mode set');
    else                      log(`Would export: ${o.modes.join(', ')}`);

    for (const out of [o.htmlOutputFile, o.pdfOutputFile])
        if (out) log(`Would write : ${out}${fs.existsSync(out) ? ' (overwriting)' : ''}`);

    logResult(`✔ Dry run OK — ${o.modes.length ? o.modes.join(', ') : 'no mode set'}`);
}

/**
 * One export.
 *
 * @param opts.inWatch Set by the watch loop for each re-run, so `--watch` does
 *                     not recurse into itself and the environment warnings are
 *                     printed once rather than on every change.
 * @param opts.argv    Arguments to parse, without the node/script prefix.
 *                     Defaults to the real process arguments; passed explicitly
 *                     by the watch loop (so a re-run keeps the flags it started
 *                     with) and by tests (so one export can be driven in-process
 *                     rather than only through a spawned CLI).
 * @returns What the run wrote back to the source document (or null), and every
 *          file it read besides the document itself. `--watch` uses the first to
 *          recognise its own write and the second to know what to watch.
 */
export async function main(opts: { inWatch?: boolean; argv?: string[] } = {}): Promise<ExportResult> {
    const { inputFile, stylesheetPath: cliStylesheet, theme: cliTheme, mode: cliMode, output: cliOutput, dpi: cliDpi, pdfVariant: cliPdfVariant, infographicIcons: cliInfographicIcons, quiet, open, noBump, release, noRevisionBump, setup, watch, dryRun, clearCache: clearCacheFlag, strict, inspect, releaseNote, themePaths } = parseArgs(opts.argv);
    setQuiet(quiet);
    // Per run, so a --watch loop judges each export on its own rather than
    // failing every export after the first one that warned.
    resetWarnings();
    // Likewise per run. The in-memory CSS import map is a within-export
    // deduplicator, not a cache with a lifetime — and `--watch` re-enters this
    // function in the same process, so left alone it carried REJECTED promises
    // between exports and replayed one transient failure forever.
    clearCssImportCache();

    // Raised while reading env vars at module load, before the logger knew
    // whether to be quiet — surfaced here so they read like any other warning.
    if (!opts.inWatch) for (const w of CONFIG_WARNINGS) log(w);

    // `--setup` installs the external binaries and stops — no document is read.
    if (setup) { runBootstrap(); return NOTHING_EXPORTED; }

    // Likewise `--clear-cache`: it empties the asset cache and stops. Nothing in
    // there is authored by anyone — every entry is a re-fetchable remote asset —
    // so this needs no confirmation and loses nothing but the next export's speed.
    if (clearCacheFlag) {
        const { dir, existed } = clearCache();
        logResult(existed ? `✔ Cache cleared: ${dir}` : `Nothing to clear — no cache at ${dir}`);
        return NOTHING_EXPORTED;
    }

    // `--watch` drives repeated calls back into this function with `inWatch`
    // set, so everything below runs per change exactly as a single export does.
    if (watch && !opts.inWatch) { await watchDocument(inputFile, opts.argv); return NOTHING_EXPORTED; }

    // ── Resolve files ─────────────────────────────────────────────────────────

    // Path resolution only — the Markdown → HTML conversion itself is deferred
    // until after the mode check below.
    //
    // That conversion resolves includes, runs markdown-it over the whole
    // document and inlines the KaTeX stylesheet; it used to run here, seventy
    // lines before `main()` discovers there is no `Mode` set and returns having
    // done nothing. With the VS Code extension exporting on save, that render
    // ran on every save of every .md in the workspace — READMEs and scratch
    // notes included — and was thrown away every time.
    const isMarkdownInput = inputFile.endsWith('.md');
    let htmlFile      = inputFile;
    let markdownFile: string | null = inputFile;

    if (isMarkdownInput) {
        htmlFile = inputFile.replace(/\.md$/, '.html');
    } else {
        const possibleMd = inputFile.replace(/\.html$/, '.md');
        markdownFile = fs.existsSync(possibleMd) ? possibleMd : null;
    }

    // ── Frontmatter ───────────────────────────────────────────────────────────

    // Computed now — the export needs today's stamped revision date — but NOT
    // written until an export has actually succeeded (see `commitSourceUpdates`
    // below). The source document is the principal's, and a run that dies on a
    // missing asset, or never exports at all because `Mode` is unset, must leave
    // it exactly as it found it.
    // The `existsSync` guard is what lets a missing document reach `validate`
    // below and exit 3 ("Markdown file not found") instead of dying here on a
    // raw ENOENT with the generic exit 1. It used to be unreachable, because
    // the conversion above read the file first.
    const pendingSource = markdownFile && !noBump && fs.existsSync(markdownFile)
        ? prepareSourceUpdates(markdownFile)
        : null;

    // Cutting a release is a deliberate act, so it takes a deliberate flag.
    //
    // This used to happen on ANY export of a document whose Status was Released:
    // the revisions row appended, every Revision scalar bumped, the status reset.
    // Correct for the export you meant as a release; wrong for the other three
    // ways an export happens — the extension firing on save, a CI run, a
    // colleague re-exporting to read it — and defending against those took three
    // separate flags (`--no-bump`, `--no-revision-bump`, `Export On Save: false`).
    // A default nobody wants, with machinery to switch it off, is the wrong way
    // round: now nothing cuts a release except `--release`.
    //
    // `Status: Released` still guards it. The two say different things — the
    // status is the document declaring it is final, the flag is you saying cut it
    // now — and a Revisions row recording a release that never happened would be
    // a lie in the document's own history.
    const bumpRevisions = Boolean(markdownFile) && !noBump && release;
    const fm = extractFrontmatter(markdownFile, pendingSource?.content);
    // Only what `main()` itself still reads: `logStartupSummary` takes the whole
    // frontmatter, so the fields that existed purely to be printed went with it.
    const { revision, status, theme, style, logo } = fm;

    // Both notes need the parsed frontmatter, so they sit here rather than beside
    // the `bumpRevisions` decision above.
    if (noRevisionBump)
        log('Note: --no-revision-bump does nothing now — only --release cuts a release');
    if (release && !noBump && !isReleasedStatus(status))
        log(`WARNING: --release given, but Status is ${status ? `"${status}"` : 'not set'} — ` +
            'nothing to release. Set Status: Released (or Vrijgegeven) first.');

    // `--inspect` answers questions ABOUT the document and stops. It sits here,
    // after the frontmatter is parsed and before the theme is loaded, because
    // everything below writes, renders or resolves assets and none of that is
    // wanted — a caller asking what a document says must not be able to change
    // it. `pendingSource` is computed above but never committed on this path.
    if (inspect) {
        logResult(JSON.stringify(describeDocument(fm, markdownFile), null, 2));
        return NOTHING_EXPORTED;
    }

    // Re-resolved from the DOCUMENT's directory, now that one is known.
    //
    // `parseArgs` could only walk up from the working directory, which is
    // wherever the command was run — not necessarily anywhere near the document.
    // A project config beside the document is the one that should decide its
    // theme, so it gets the final say. Flags and the environment still win, and
    // `setThemeRoots` de-duplicates, so this is additive rather than a reset.
    setThemeRoots(resolveThemeRoots(themePaths, process.env,
                                    path.dirname(path.resolve(markdownFile ?? inputFile))));

    // ── Theme (brand package) ───────────────────────────────────────────────────
    const activeTheme = setActiveTheme(resolveThemeName(cliTheme, theme));

    // Overlay the chosen named style's typography/background onto the theme
    // before any CSS is built (these are baked into @page rules, so a late
    // override can't reach them). No-op for custom styles and single-style themes.
    applyStyleOverrides(style);

    // Brand mark override (`Logo:` frontmatter), applied before the cover build
    // reads theme.logo/logoWhite. Independent of the style above by design.
    applyLogoOverride(logo);

    // Colour keys need the active theme (a palette name resolves against it) but
    // nothing else, so they are checked here — before the plan, before any
    // rendering. Same reasoning as `resolveExportPlan` resolving output paths up
    // front: a typo should cost a second, not a full export.
    validateDocumentColors(fm);

    // Everything from here to the output paths is decision-making with no I/O,
    // so it lives in plan.ts where it can be tested on its own.
    const plan = resolveExportPlan({
        inputFile, htmlFile, revision,
        cliTheme, fmTheme: theme,
        cliStylesheet, themeStylesheetFile: activeTheme.stylesheetFile,
        cliMode, fmMode: fm.mode,
        cliOutput, cliDpi, cliPdfVariant, fmPdfVariant: fm.pdfVariant, cliInfographicIcons,
    });
    // Only the fields `main()` still reads for itself — the rest of the plan
    // travels to `executeExport` whole.
    const { stylesheetPath, stylesheetLabel, modes, hasPdf, dpi, pdfVariant,
            htmlOutputFile, pdfOutputFile } = plan;

    // CLI mode values are validated in parseArgs, so anything unknown here came
    // from the Mode frontmatter field — warn instead of silently no-oping.
    if (plan.unknownModes.length)
        log(`WARNING: Ignoring unknown Mode value(s) in frontmatter: ${plan.unknownModes.join(', ')} (valid: pdf, html, debug)`);

    // ── Startup summary ───────────────────────────────────────────────────────

    const weasyprintPath = hasPdf ? findWeasyprint() : null;

    logStartupSummary({ inputFile, markdownFile, modes, stylesheetLabel, fm,
                        themeName: activeTheme.name, dpi: hasPdf ? dpi : null,
                        pdfVariant: hasPdf ? pdfVariant : null });

    validate(weasyprintPath, isMarkdownInput ? null : htmlFile, markdownFile, stylesheetPath, !hasPdf);

    // Everything above is validation: the theme loaded, the style and colour keys
    // parsed, the output paths resolved, the assets and WeasyPrint checked. A
    // dry run is exactly that work and then a report — the point being that a
    // document with `Mode:` set had no way to be checked without also producing a
    // file, since `--mode ''` and `--mode none` are both usage errors.
    //
    // It stops before `prepareSourceUpdates` is committed, so the source document
    // is left byte-for-byte as it was found.
    if (dryRun) {
        await reportDryRun({
            isMarkdownInput, inputFile, htmlFile, markdownFile, fm,
            pending: pendingSource, modes, htmlOutputFile, pdfOutputFile,
        });
        assertNoWarnings(strict);
        log('=== Export finished ===');
        return NOTHING_EXPORTED;
    }

    if (modes.length === 0) {
        log('Mode not set — nothing to do');
        log('=== Export finished ===');
        return NOTHING_EXPORTED;
    }

    return executeExport({
        inputFile, htmlFile, markdownFile, isMarkdownInput, fm, pendingSource,
        stylesheetPath, plan, weasyprintPath, bumpRevisions, open, strict, releaseNote,
    });
}

/** Everything {@link executeExport} needs, once `main()` has finished deciding. */
interface ExecuteOptions {
    inputFile: string;
    htmlFile: string;
    markdownFile: string | null;
    isMarkdownInput: boolean;
    fm: FrontmatterData;
    pendingSource: PendingSourceUpdate | null;
    stylesheetPath: string | null;
    plan: ExportPlan;
    /** Non-null whenever the plan includes a PDF mode. */
    weasyprintPath: string | null;
    bumpRevisions: boolean;
    open: boolean;
    strict: boolean;
    /** `--release-note`: the Remarks for the revision being released. */
    releaseNote: string | null;
}

/**
 * Whether diagrams should strip emoji before embedding — decided once per
 * export, not once per diagram.
 *
 * False (skip stripping, the fast path) whenever there is no reason to pay
 * for a probe: no PDF pipeline in play — a real browser renders colour emoji
 * fine on its own, so an HTML-only export never needs to ask — or no
 * Mermaid/Graphviz diagram in the document at all, so there is nothing that
 * could contain one. `checkSupport` (in practice `colorEmojiRenderingSupported`
 * from weasyprint.ts, which launches the real binary) is called in the one
 * remaining case, and only there — that is what keeps this off the critical
 * path for the overwhelming majority of documents, which have no diagram.
 *
 * `checkSupport` is injected so this branch logic is testable without
 * launching anything.
 */
export async function shouldStripDiagramEmoji(
    hasPdf: boolean,
    weasyprintPath: string | null,
    hasDiagram: boolean,
    checkSupport: (weasyprintPath: string) => Promise<boolean>,
): Promise<boolean> {
    if (!hasPdf || !weasyprintPath || !hasDiagram) return false;
    return !(await checkSupport(weasyprintPath));
}

/**
 * The doing half of an export: render once, write each requested output, then
 * commit the deferred source edits.
 *
 * Split from `main()` for the same reason `plan.ts` and `watch.ts` were. What is
 * left above this line is parsing, resolution and validation — all of it already
 * reachable from a test. This part was not: it sat at the bottom of a 264-line
 * function behind a `parseArgs` call, so the rules that live here could only be
 * exercised by driving a whole CLI run, and the subtlest of them had no direct
 * coverage at all:
 *
 *  - the shared render happens ONCE even when both modes are requested;
 *  - the source stamp is earned by the FIRST output that lands, so a WeasyPrint
 *    failure in `--mode pdf,html` cannot leave the exported HTML and its own
 *    source disagreeing about the document's date;
 *  - the revision *bump* waits for EVERY output, so both artifacts carry the
 *    same pre-bump revision;
 *  - `--strict` is judged after the output is written, never instead of it.
 *
 * Exported for testing.
 */
export async function executeExport(o: ExecuteOptions): Promise<ExportResult> {
    const { inputFile, htmlFile, markdownFile, isMarkdownInput, fm, pendingSource,
            stylesheetPath, plan, weasyprintPath, bumpRevisions, open, strict, releaseNote } = o;
    const { hasPdf, hasHtml, pdfMode, dpi, pdfVariant, htmlOutputFile, pdfOutputFile } = plan;
    const { title, style } = fm;

    const startMs = Date.now();

    // Every file this export reads besides the document itself: includes, local
    // images, draw.io sources, the stylesheet. `--watch` subscribes to them, so
    // editing a chapter re-exports the book it belongs to.
    const dependencies = new Set<string>();
    if (stylesheetPath) dependencies.add(path.resolve(stylesheetPath));

    // Kick off cover page and fallback font fetch (PDF only) before the heavy
    // diagram work — neither needs the HTML content, so they overlap with
    // Mermaid rendering (1–3 s) instead of extending the critical path.
    let coverPromise:         Promise<CoverPage | null> = Promise.resolve(null);
    let fallbackFontsPromise: Promise<string>           = Promise.resolve('');
    if (hasPdf) {
        // `Cover Page: false` suppresses the cover while leaving `Style` in
        // place, so the document keeps its brand colours — omitting `Style`
        // would drop those too.
        if (!fm.coverPage) {
            log('Cover page suppressed (Cover Page: false)');
        } else {
            log('Building cover page + fetching fallback fonts...');
            coverPromise = buildCoverPage({
                title, documentInfo: fm.documentInfo, revisions: fm.revisions,
                revisionsVisible: fm.revisionsVisible, coverLogo: fm.coverLogo,
                style, baseDir: path.dirname(htmlFile),
                coverSlogan: fm.coverSlogan, coverAddress: fm.coverAddress,
                coverFooterLogo: fm.coverFooterLogo, coverTitleColor: fm.coverTitleColor,
                deps: dependencies,
            });
        }
        fallbackFontsPromise = buildFallbackFontStyles();
    }

    // Deferred from "Resolve files" above: a run with no mode set has already
    // returned by now, so it never pays for a render it would throw away.
    // Started after the cover/font promises so it overlaps them.
    if (isMarkdownInput) log(`Converting Markdown → HTML: ${path.basename(inputFile)}`);
    // The content and frontmatter are handed over rather than re-read: they were
    // computed above, and this is the only reason the document had to be read
    // three times per export.
    const rawHtmlContent = isMarkdownInput
        ? await convertMarkdownToHtml(inputFile, pendingSource?.content, fm, dependencies)
        : null;

    const preRenderContent = rawHtmlContent ?? fs.readFileSync(htmlFile, 'utf8');
    const hasDiagram = hasMermaidPlaceholders(preRenderContent)
        || hasGraphvizPlaceholders(preRenderContent)
        || hasInfographicPlaceholders(preRenderContent);
    const stripDiagramEmoji = await shouldStripDiagramEmoji(
        hasPdf, weasyprintPath, hasDiagram,
        async wpPath => {
            log('Checking whether WeasyPrint can render colour emoji...');
            return colorEmojiRenderingSupported(wpPath);
        },
    );

    // Heavy transformations shared by both output modes run exactly once.
    const htmlContent = await renderDiagramsAndImages(
        preRenderContent,
        htmlFile,
        { pageSize: fm.pageSize, margins: fm.margins, orientation: fm.orientation },
        dependencies,
        { stripDiagramEmoji, infographicIcons: plan.infographicIcons },
    );

    // What this run wrote back to the source document, if anything — the
    // revision-date stamp and then, on a release, the bump. `--watch` compares
    // it against the file to tell its own writes apart from a real edit.
    let sourceWritten: string | null = null;

    // ── HTML export (no WeasyPrint) ───────────────────────────────────────────

    if (hasHtml) {
        const outputFile = htmlOutputFile!;
        if (fs.existsSync(outputFile))
            log(`Overwriting existing output: ${path.basename(outputFile)}`);
        log(`Output     : ${outputFile}`);

        const processed = await buildHtmlExportPipeline(htmlContent, htmlFile, stylesheetPath, fm, dependencies);
        writeFileAtomic(outputFile, processed);
        const sizeKb = (Buffer.byteLength(processed, 'utf8') / 1024).toFixed(0);
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        logResult(`✔ ${path.basename(outputFile)} — ${sizeKb} KB in ${elapsed} s`);

        // The stamp is earned by the FIRST output that lands, not by the last.
        // This file already carries today's revision date; deferring the source
        // write until after the PDF meant that in `--mode pdf,html` a WeasyPrint
        // failure left an exported document and its own source disagreeing about
        // the document's date. The revision *bump* still waits for every output,
        // so both artifacts carry the same pre-bump revision.
        sourceWritten = commitSourceUpdates(pendingSource) ?? sourceWritten;

        if (open) openFile(outputFile);
    }

    // ── PDF pipeline → WeasyPrint ─────────────────────────────────────────────

    if (hasPdf) {
        const outputFile = pdfOutputFile!;
        if (fs.existsSync(outputFile))
            log(`Overwriting existing output: ${path.basename(outputFile)}`);
        log(`Output     : ${outputFile}`);

        const processed = await buildHtmlPipeline(htmlContent, htmlFile, stylesheetPath, fm, coverPromise, fallbackFontsPromise, dependencies);
        await runExport(processed, { weasyprintPath: weasyprintPath!, htmlFile, pdfFile: outputFile, dpi, pdfVariant, mode: pdfMode, startMs, open });
        sourceWritten = commitSourceUpdates(pendingSource) ?? sourceWritten;
        if (bumpRevisions) sourceWritten = bumpRevisionAfterExport(markdownFile!, fm, pendingSource?.content, releaseNote) ?? sourceWritten;
        assertNoWarnings(strict);
        return { sourceWritten, dependencies: [...dependencies] }; // runExport logged the finish line
    }

    sourceWritten = commitSourceUpdates(pendingSource) ?? sourceWritten;
    if (bumpRevisions) sourceWritten = bumpRevisionAfterExport(markdownFile!, fm, pendingSource?.content, releaseNote) ?? sourceWritten;
    log('=== Export finished ===');
    assertNoWarnings(strict);
    return { sourceWritten, dependencies: [...dependencies] };
}

/**
 * What `--inspect` prints: the document as the exporter understands it.
 *
 * A read-only question-answering surface, added because tooling has to know
 * things about a document *before* acting on it — the VS Code extension asks
 * whether the revision it is about to release already carries a note, and only
 * prompts when it does not. Without this the editor would need its own YAML
 * reader, which is a second answer to "what does this document say" living one
 * refactor away from disagreeing with the first.
 *
 * Deliberately the resolved view, not the raw YAML: `Mode: pdf, html` comes back
 * normalised, the revision follows `resolveRevision`'s precedence, and `released`
 * applies `isReleasedStatus` (so `Vrijgegeven` counts). A caller reading the file
 * itself would have to re-implement all three.
 */
export function describeDocument(fm: FrontmatterData, file: string | null): Record<string, unknown> {
    const last = fm.revisions.at(-1) ?? null;
    return {
        file,
        title:    fm.title,
        author:   fm.author,
        date:     fm.date,
        revision: fm.revision,
        status:   fm.status,
        released: isReleasedStatus(fm.status),
        mode:     fm.mode,
        theme:    fm.theme,
        style:    fm.style,
        revisionsVisible: fm.revisionsVisible,
        revisions: fm.revisions,
        // Hoisted out of `revisions` because it is the one a release acts on, and
        // a caller should not have to know that "last" means "outgoing".
        lastRevision: last,
        lastRemarks:  last?.remarks ?? null,
        /** True when the release would append a row whose predecessor says nothing. */
        needsReleaseNote: isReleasedStatus(fm.status) && !(last?.remarks ?? '').trim(),
    };
}

/**
 * Maps a thrown value onto the text to print and the exit code to use.
 *
 * Shared by the process's top-level handler and by `--watch`, which reports a
 * failed run the same way but keeps going instead of exiting.
 */
export function describeError(err: unknown): { text: string; code: number } {
    if (err instanceof ExitError) return { text: err.message, code: err.exitCode };
    const msg: string = (err instanceof Error ? err.message : String(err));
    if (/timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(msg))
        return { text: `Network error: ${msg}`, code: 5 };
    return { text: (err instanceof Error ? err.stack : null) ?? msg, code: 1 };
}

// ── Watch mode ────────────────────────────────────────────────────────────────

/**
 * Runs the watch loop until a signal stops it.
 *
 * The loop itself — debounce, self-write suppression, queueing a change that
 * lands mid-export, and subscribing to the files the export read — lives in
 * `watch.ts` with its dependencies injected, so it is testable. What stays here
 * is the part that cannot be: the real export, the signal handlers, and blocking
 * the process.
 *
 * @param argv Passed through to each re-run, so `--watch` re-exports with the
 *             same flags it was started with.
 */
async function watchDocument(inputFile: string, argv?: string[]): Promise<void> {
    const handle = startWatch(inputFile, {
        run:     () => main({ inWatch: true, argv }),
        onError: (err: unknown) => console.error(describeError(err).text),
    });

    const stop = (): void => {
        handle.close();
        log('Stopped watching');
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    await new Promise<never>(() => { /* runs until a signal stops it */ });
}

/**
 * Only run when executed as the CLI, so the pipeline builders above can be
 * imported by a test without the process trying to export a document.
 */
if (require.main === module) main().catch(err => {
    const { text, code } = describeError(err);
    // Exit code 0 is a successful run whose whole output is text (--help,
    // --version, --list-*), so it belongs on stdout, not stderr.
    (code === 0 ? console.log : console.error)(text);
    process.exit(code);
});
