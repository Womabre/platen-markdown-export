/**
 * draw.io diagram rendering.
 *
 * Converts `<img src="*.drawio">` references to inline data URLs. Two targets:
 *
 *   - 'png'  (PDF pipeline): a high-resolution PNG. WeasyPrint can render the
 *            draw.io SVG via its `<switch>`/`<image>` fallbacks, but one label
 *            type has no raster fallback (prints "Text is not SVG") and the
 *            fallback text is only 1×, so PNG (rendered at scale 3 ≈ 300 DPI)
 *            stays the crisp, complete choice for print.
 *   - 'svg'  (HTML pipeline): a self-contained `<picture>` with a light SVG and
 *            a native dark SVG (`--svg-theme dark`), swapped by
 *            `prefers-color-scheme`. Vector + proper dark mode in the browser.
 *
 * Both targets tag the result with a `drawio-diagram` class so draw.io images
 * are identifiable in the output (mirroring Mermaid's `.mermaid-figure`).
 *
 * Requires the draw.io desktop app (available from https://www.diagrams.net/).
 *
 * Syntax in Markdown:
 *   ![Caption](path/to/diagram.drawio)          — first page
 *   ![Caption](path/to/diagram.drawio#page=2)   — specific page (1-based)
 *
 * draw.io CLI discovery order:
 *   1. `drawio` in PATH (e.g. installed via Homebrew or apt)
 *   2. /Applications/draw.io.app/Contents/MacOS/draw.io  (macOS .app bundle)
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';
import { attrOf, setAttr, tagWithAttrValue } from './attributes';
import { windowsAppDir } from './fsutil';
import { createLimiter } from './concurrency';
import { CONFIG } from './config';

const execFileAsync = promisify(execFile);

/**
 * Gate on the draw.io CLI itself, not on the callers.
 *
 * Each invocation launches a full Electron instance — an order of magnitude
 * heavier than a Chromium page — and a single SVG-mode diagram already needs
 * two (light + dark). Limiting at the spawn covers every caller shape and the
 * export cache alike. Capped well below the general concurrency budget for
 * that reason; two is enough to keep the light/dark pair overlapping.
 */
const runDrawio = createLimiter(Math.min(CONFIG.concurrency, 2));

// ── CLI discovery ─────────────────────────────────────────────────────────────

const DRAWIO_LOCAL_APP_DATA = windowsAppDir('Local');

const DRAWIO_CANDIDATES = [
    'drawio',
    '/Applications/draw.io.app/Contents/MacOS/draw.io',                                  // macOS .app bundle
    'C:\\Program Files\\draw.io\\draw.io.exe',                                           // Windows system-wide
    // Dropped rather than degraded: joining an empty %LOCALAPPDATA% produced the
    // relative `Programs/draw.io/draw.io.exe`, probed against whatever directory
    // the export was running in. See `windowsAppDir`.
    DRAWIO_LOCAL_APP_DATA && path.join(DRAWIO_LOCAL_APP_DATA, 'Programs', 'draw.io', 'draw.io.exe'),
].filter((c): c is string => Boolean(c));

let _cli: string | null | undefined = undefined;

/**
 * `drawio` (no separator) is resolved through PATH and so has to be probed by
 * running it; the rest are absolute paths that can be ruled out with a cheap
 * stat first. Each probe launches a whole Electron app, so skipping the ones
 * that cannot possibly exist is worth the check.
 */
export function isProbablyInstalled(bin: string): boolean {
    // A bare command name (no separator) is the PATH lookup — only running it
    // can answer. Anything with a separator names a file that must exist. It
    // keys on the separator rather than on `path.isAbsolute` because a Windows
    // path is not absolute to a POSIX `isAbsolute`, and the suite asserts both.
    const isBareCommand = !bin.includes('/') && !bin.includes('\\');
    return isBareCommand || fs.existsSync(bin);
}

/** @param force  Bypass the memoized result — used right after an install attempt. */
export function findDrawioCli(force = false): string | null {
    if (!force && _cli !== undefined) return _cli;
    for (const bin of DRAWIO_CANDIDATES) {
        if (!isProbablyInstalled(bin)) continue;
        try {
            // Still verified by running it: an existing path can be a broken or
            // partial install, and that must not be reported as available.
            execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 5_000 });
            log(`draw.io CLI: ${bin}`);
            _cli = bin;
            return bin;
        } catch { /* try next */ }
    }
    _cli = null;
    return null;
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface DrawioExportOptions {
    /** Output format. */
    format: 'png' | 'svg';
    /** SVG color theme (svg only). Omit for the default. */
    theme?: 'light' | 'dark';
}

/**
 * Exports a single page of a .drawio file via the CLI.
 *
 * @param drawioPath  Absolute path to the .drawio file.
 * @param pageIndex   0-based page index.
 * @param opts        Output format (and SVG theme).
 * @returns The exported file buffer, or null on failure.
 */
export async function exportDrawioPage(
    drawioPath: string,
    pageIndex: number,
    opts: DrawioExportOptions,
): Promise<Buffer | null> {
    const cli = findDrawioCli();
    if (!cli) return null;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-drawio-'));
    const tmpOut = path.join(tmpDir, `out.${opts.format}`);
    try {
        const args = [
            '--export',
            '--format',     opts.format,
            // --page-index is 1-based in draw.io CLI (unlike most zero-based APIs)
            '--page-index', String(pageIndex + 1),
            '--output',     tmpOut,
        ];
        if (opts.format === 'png')
            args.push('--scale', '3');                 // ~300 DPI equivalent — crisp at print resolution
        if (opts.format === 'svg' && opts.theme)
            args.push('--svg-theme', opts.theme);
        args.push(drawioPath);

        await runDrawio(() => execFileAsync(cli, args, { timeout: 60_000 }));

        if (!fs.existsSync(tmpOut)) return null;
        return fs.readFileSync(tmpOut);
    } catch (err: unknown) {
        log(`WARNING: draw.io export failed for ${path.basename(drawioPath)}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ── HTML pre-processor ────────────────────────────────────────────────────────

/**
 * Any `<img>` whose `src` names a .drawio file — in all three HTML attribute
 * spellings, not just the double-quoted one markdown emits.
 *
 * `html: true` is on, so a document may hand-write `<img src='arch.drawio'>` or
 * `<img src=arch.drawio>`. Those matched nothing here and nothing in
 * `inlineImages` either, so the reference survived into the output pointing at a
 * `.drawio` file the PDF cannot open — a broken image, with no warning, because
 * as far as both passes were concerned there was no diagram there.
 *
 * The tag is matched whole rather than split into before/after-src halves: the
 * `src` and `class` attributes are then found within it by `attributes.ts`,
 * which is what lets each carry its own quoting and appear in any order.
 *
 * Value-filtered rather than "every `<img>`" on purpose. In the PDF pipeline
 * this runs after image inlining, so most tags in the document already carry a
 * multi-megabyte data URI; a pattern that matched all of them would key the
 * replacement map on those strings and hash a megabyte per image to learn there
 * was nothing to do.
 */
const DRAWIO_IMG_RE = tagWithAttrValue('img', 'src', String.raw`\.drawio(?:\.xml)?(?:#page=\d+)?`);

/**
 * Every `<img>` in the document that references a .drawio file.
 *
 * Exported so the matcher itself is testable: whether a tag is recognised is not
 * visible in the output — an unrecognised reference and one whose file is
 * missing both leave the html untouched — which is exactly how the two spellings
 * this used to miss went unnoticed.
 */
export function findDrawioImages(html: string): string[] {
    return [...html.matchAll(DRAWIO_IMG_RE)].map(m => m[0]);
}

/** The `src` value of a tag, whichever way it was quoted, or null. */
export function srcOf(tag: string): string | null {
    return attrOf(tag, 'src');
}

/**
 * Splits a drawio `src` into the file it names and the page to export.
 *
 * The fragment is 1-based for a human (`#page=2` is the second page) and the
 * exported index is 0-based — `exportDrawioPage` adds the 1 back for the CLI,
 * which is 1-based again. Exported for testing.
 */
export function parseDrawioSrc(src: string): { file: string; pageIndex: number } {
    const m = /^(.+?)(?:#page=(\d+))?$/.exec(src);
    if (!m) return { file: src, pageIndex: 0 };
    return { file: m[1], pageIndex: m[2] ? parseInt(m[2], 10) - 1 : 0 };
}

/**
 * Rewrites one `<img>` tag onto the rendered data URL, carrying the marker class.
 *
 * Works on the whole tag rather than on attribute fragments, so an attribute
 * order or quoting style this code did not choose survives it. Both rewrites are
 * quoting-agnostic and normalise to double quotes: the class merge in particular
 * used to look for `class="` only, so a hand-written `class='figure'` produced a
 * tag with TWO class attributes.
 */
export function drawioImgTag(tag: string, dataUrl: string): string {
    const withSrc  = setAttr(tag, 'src', dataUrl);
    const existing = attrOf(withSrc, 'class');
    // `setAttr` inserts the attribute after the tag name when it is absent, so
    // the "no class at all" case needs no branch of its own here.
    return setAttr(withSrc, 'class', `drawio-diagram${existing ? ` ${existing}` : ''}`);
}

export type DrawioRenderMode = 'png' | 'svg';

/**
 * Finds every `<img src="*.drawio">` in the HTML and replaces it with an inline
 * data URL rendered via the draw.io CLI.
 *
 *   - mode 'png': a single high-res PNG `<img class="drawio-diagram">` (PDF).
 *   - mode 'svg': a `<picture>` pairing a light SVG with a native dark SVG,
 *     swapped by `prefers-color-scheme`; the `<img>` carries the marker class.
 *     `<picture>` is phrasing content, so it stays valid inside the `<p>` that
 *     markdown wraps the image in (a `<div>` wrapper would not).
 *
 * When draw.io is not installed all .drawio images are left as-is and a single
 * warning is emitted so the rest of the export succeeds.
 */
/**
 * The warning raised when a diagram is dropped from the document.
 *
 * Phrased as the consequence rather than the cause on purpose. `exportDrawioPage`
 * returns null three ways — no CLI, a thrown error, or draw.io exiting cleanly
 * having written no file — and only the middle one warned. So a diagram could
 * disappear from the export with the run reporting nothing and exiting 0, even
 * under `--strict`. Warning here, where the tag is actually discarded, covers all
 * three: whatever the reason, a diagram that leaves the document says so.
 *
 * The thrown-error path now reports twice — once for why it failed, once for what
 * happened to the document. That is the intended reading, not a duplicate.
 */
function omittedWarning(matchIndex: number, src: string, pageIndex: number): string {
    return `WARNING: draw.io produced no output for ${path.basename(src)} p${pageIndex} — ` +
           `diagram ${matchIndex + 1} omitted from the document`;
}

export async function renderDrawioDiagrams(
    html: string,
    baseDir: string,
    mode: DrawioRenderMode = 'png',
    deps?: Set<string>,
): Promise<string> {
    const matches = findDrawioImages(html);
    if (matches.length === 0) return html;

    if (!findDrawioCli()) {
        log('WARNING: .drawio diagram(s) found but draw.io CLI not installed. ' +
            'Download from https://www.diagrams.net/ to render them.');
        return html;
    }

    log(`Rendering ${matches.length} draw.io diagram(s) as ${mode.toUpperCase()}...`);

    // Deduplicate exports by file path + page + format + theme so multi-use of
    // the same diagram (and the two SVG themes) only triggers one CLI run each.
    const cache = new Map<string, Promise<string | null>>();

    const dataUrlFor = (drawioPath: string, pageIndex: number, opts: DrawioExportOptions): Promise<string | null> => {
        const key = `${drawioPath}#${pageIndex}#${opts.format}#${opts.theme ?? ''}`;
        let pending = cache.get(key);
        if (!pending) {
            const mime = opts.format === 'svg' ? 'image/svg+xml' : 'image/png';
            pending = exportDrawioPage(drawioPath, pageIndex, opts)
                .then(buf => (buf ? `data:${mime};base64,${buf.toString('base64')}` : null));
            cache.set(key, pending);
        }
        return pending;
    };

    const replacements = await Promise.all(
        matches.map(async (tag, i) => {
            const raw = srcOf(tag);
            if (raw === null) return null;    // matched the fence but has no readable src
            const { file: src, pageIndex } = parseDrawioSrc(raw);

            const drawioPath = path.resolve(baseDir, decodeURIComponent(src));
            deps?.add(drawioPath);

            // No leading whitespace. `logger.ts` counts a warning only when the
            // line starts with `WARNING:` at column zero, so the two spaces this
            // used to carry meant it was not counted for `--strict`, went to
            // stdout instead of stderr, and was suppressed entirely by `--quiet`.
            if (!fs.existsSync(drawioPath)) {
                log(`WARNING: draw.io file not found: ${drawioPath}`);
                return null;
            }

            if (mode === 'svg') {
                const [light, dark] = await Promise.all([
                    dataUrlFor(drawioPath, pageIndex, { format: 'svg', theme: 'light' }),
                    dataUrlFor(drawioPath, pageIndex, { format: 'svg', theme: 'dark'  }),
                ]);
                if (!light) {
                    log(omittedWarning(i, src, pageIndex));
                    return null;
                }
                log(`  diagram ${i + 1}: ${path.basename(src)} p${pageIndex} (light ${(light.length / 1024).toFixed(0)} KB${dark ? ` + dark ${(dark.length / 1024).toFixed(0)} KB` : ''})`);
                const img = drawioImgTag(tag, light);
                const replacement = dark
                    ? `<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}">${img}</picture>`
                    : img;
                return { original: tag, replacement };
            }

            const png = await dataUrlFor(drawioPath, pageIndex, { format: 'png' });
            if (!png) {
                log(omittedWarning(i, src, pageIndex));
                return null;
            }
            log(`  diagram ${i + 1}: ${path.basename(src)} p${pageIndex} (${(png.length / 1024).toFixed(0)} KB)`);
            return { original: tag, replacement: drawioImgTag(tag, png) };
        }),
    );

    // One pass, for the same reason as inlineImages: a replaceAll per match is a
    // full scan of a document these data URIs have just made large, and a
    // single pass cannot re-match a replacement it just inserted.
    const byTag = new Map<string, string>();
    for (const r of replacements) {
        if (r) byTag.set(r.original, r.replacement);
    }
    return html.replace(DRAWIO_IMG_RE, tag => byTag.get(tag) ?? tag);
}
