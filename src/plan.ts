import * as fs   from 'fs';
import * as path from 'path';
import { ExitError } from './errors';
import { parseModes } from './cli';
import { CONFIG, type InfographicIconProvider } from './config';
import { DEFAULT_THEME } from './theme';

/**
 * Resolution of *what to export where*, separated from the doing of it.
 *
 * This is the part of `main()` that is all decisions and no I/O: which theme
 * wins, which stylesheet, which modes, and — the sharp end — which output paths,
 * including the guard that stops an export from writing over the user's own
 * source document. It lives here rather than inline in `main()` so it can be
 * tested directly; the overwrite guard in particular is a data-loss guard that
 * had no coverage while it was a closure inside a 230-line function.
 */

export interface ExportPlanInput {
    /** The file named on the command line. */
    inputFile: string;
    /** `inputFile` with a `.html` extension — the base for derived output names. */
    htmlFile: string;
    /** `Revision` from frontmatter; becomes the `_RevN` output suffix. */
    revision: string | null;
    cliTheme: string | null;
    fmTheme: string | null;
    cliStylesheet: string | null;
    /** The active theme's own stylesheet, used when the CLI names none. */
    themeStylesheetFile: string | null;
    cliMode: string | null;
    fmMode: string | null;
    cliOutput: string | null;
    cliDpi: number | null;
    cliPdfVariant: string | null;
    /** `PDF Variant` frontmatter field. */
    fmPdfVariant: string | null;
    /** `--infographic-icons`; there is deliberately no frontmatter counterpart. */
    cliInfographicIcons?: InfographicIconProvider | null;
    /** Overrides the EXPORT_THEME lookup; defaults to the real environment. */
    env?: NodeJS.ProcessEnv;
    /** Overrides the theme-stylesheet existence check; for tests. */
    fileExists?: (p: string) => boolean;
    /** Overrides the output-directory existence check; for tests. */
    dirExists?: (p: string) => boolean;
}

export interface ExportPlan {
    stylesheetPath: string | null;
    /** How the stylesheet choice is described in the startup summary. */
    stylesheetLabel: string;
    modes: string[];
    /** Mode values that are not modes — always from frontmatter, never the CLI. */
    unknownModes: string[];
    hasPdf: boolean;
    hasHtml: boolean;
    /** Which of `pdf`/`debug` drives the PDF run; `debug` keeps the temp file. */
    pdfMode: string;
    dpi: number;
    /**
     * `--pdf-variant` → `PDF Variant` frontmatter → `EXPORT_PDF_VARIANT`; null
     * produces an ordinary PDF.
     */
    pdfVariant: string | null;
    /** `--infographic-icons` → `EXPORT_INFOGRAPHIC_ICONS` → `iconify`. */
    infographicIcons: InfographicIconProvider;
    htmlOutputFile: string | null;
    pdfOutputFile: string | null;
}

/** Precedence: `--theme` → `Theme` frontmatter → `EXPORT_THEME` → the default theme. */
export function resolveThemeName(
    cliTheme: string | null,
    fmTheme: string | null,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return cliTheme ?? fmTheme ?? env.EXPORT_THEME ?? DEFAULT_THEME;
}

/**
 * Picks the stylesheet and the label describing that choice.
 *
 * Defaulting to the theme's own stylesheet matters: without it the cover still
 * renders branded while the body silently falls back to WeasyPrint's default
 * serif, which looks like a theme bug rather than a missing flag. `-s none`
 * opts out explicitly.
 */
export function resolveStylesheet(
    cliStylesheet: string | null,
    themeStylesheetFile: string | null,
    fileExists: (p: string) => boolean = fs.existsSync,
): { path: string | null; label: string } {
    if (cliStylesheet === 'none') return { path: null, label: 'disabled (-s none)' };
    if (cliStylesheet)            return { path: cliStylesheet, label: cliStylesheet };
    if (themeStylesheetFile && fileExists(themeStylesheetFile))
        return { path: themeStylesheetFile, label: `${themeStylesheetFile} (theme default)` };
    return { path: null, label: 'not provided' };
}

/**
 * Derives the output path for one mode, refusing to write over the input.
 *
 * That collision is reachable in normal use — an `.html` input exported in html
 * mode with no frontmatter revision derives the input's own name — and silently
 * replacing the user's source with the processed document is never what anyone
 * meant, so it is a usage error rather than a warning.
 */
export function outputPathFor(
    mode: string,
    opts: Pick<ExportPlanInput, 'inputFile' | 'htmlFile' | 'revision' | 'cliOutput'>,
): string {
    const { inputFile, htmlFile, revision, cliOutput } = opts;

    const out = (() => {
        if (cliOutput) return cliOutput;
        // Both strips are anchored to the end. An unanchored `.replace('.html', '')`
        // removes the FIRST occurrence, so `my.html.notes.md` derived the output name
        // `my.notes.html.pdf` — the extension eaten out of the middle of the name.
        const base = path.basename(htmlFile).replace(/_v[\d.]+\.html$/, '.html').replace(/\.html$/, '');
        const dir  = path.dirname(htmlFile);
        const ext  = mode === 'html' ? 'html' : 'pdf';
        return path.join(dir, `${base}${revision ? `_Rev${revision}` : ''}.${ext}`);
    })();

    if (path.resolve(out) === path.resolve(inputFile))
        throw new ExitError(
            `Error: output path would overwrite the input file: ${out}\n` +
            'Use --output to choose a different path, or add a Revision to the frontmatter.',
            2,
        );

    return out;
}

/**
 * Rejects an output path whose directory does not exist.
 *
 * Only reachable through `--output`: without it the directory is the input
 * document's own, which necessarily exists. That makes it a bad flag value —
 * code 2, like the overwrite guard — and it belongs here rather than at the
 * write, which sits on the far side of Mermaid rendering, draw.io export and
 * image inlining. Failing a minute into the work because of a typo, with the
 * generic exit 1 of an unhandled ENOENT, is a miserable way to learn about it.
 */
function requireOutputDir(outputPath: string, dirExists: (p: string) => boolean): void {
    const dir = path.dirname(path.resolve(outputPath));
    if (dirExists(dir)) return;
    throw new ExitError(
        `Error: output directory does not exist: ${dir}\n` +
        'Create it first, or point --output somewhere that exists.',
        2,
    );
}

/**
 * Builds the whole plan, throwing `ExitError` on any usage error.
 *
 * Output paths are resolved here, up front, so that a bad one fails before the
 * expensive diagram rendering rather than after it.
 */
export function resolveExportPlan(input: ExportPlanInput): ExportPlan {
    const { modes, unknown: unknownModes } = parseModes(input.cliMode ?? input.fmMode);

    const hasPdf  = modes.some(m => m === 'pdf' || m === 'debug');
    const hasHtml = modes.includes('html');

    // One --output cannot name two files; the second export would overwrite the
    // first, which looks like the first mode silently not running.
    if (input.cliOutput && hasPdf && hasHtml)
        throw new ExitError(
            'Error: --output cannot be combined with both "html" and "pdf" modes — ' +
            'the second export would overwrite the first. Run the modes separately or drop --output.',
            2,
        );

    const stylesheet = resolveStylesheet(
        input.cliStylesheet, input.themeStylesheetFile, input.fileExists,
    );
    const pdfMode = modes.find(m => m === 'pdf' || m === 'debug') ?? 'pdf';

    const dirExists      = input.dirExists ?? fs.existsSync;
    const htmlOutputFile = hasHtml ? outputPathFor('html',  input) : null;
    const pdfOutputFile  = hasPdf  ? outputPathFor(pdfMode, input) : null;
    if (htmlOutputFile) requireOutputDir(htmlOutputFile, dirExists);
    if (pdfOutputFile)  requireOutputDir(pdfOutputFile,  dirExists);

    return {
        // No `themeName` here on purpose. The theme has to be loaded before this
        // runs — `themeStylesheetFile` comes off it — so `main()` already called
        // `resolveThemeName`, and a second copy in the plan was a second source
        // of truth that nothing read.
        stylesheetPath:  stylesheet.path,
        stylesheetLabel: stylesheet.label,
        modes,
        unknownModes,
        hasPdf,
        hasHtml,
        pdfMode,
        dpi:             input.cliDpi ?? CONFIG.weasyprintDpi,
        pdfVariant:      input.cliPdfVariant ?? input.fmPdfVariant ?? CONFIG.pdfVariant,
        infographicIcons: input.cliInfographicIcons ?? CONFIG.infographicIcons,
        htmlOutputFile,
        pdfOutputFile,
    };
}
