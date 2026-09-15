/**
 * Mermaid diagram pre-rendering for WeasyPrint.
 *
 * WeasyPrint doesn't run JavaScript, so mermaid diagrams must be converted to
 * a static image before the HTML is handed to WeasyPrint.  We do this by:
 *
 *   1. The markdown `highlight()` hook emits a placeholder element for every
 *      ```mermaid code block, with the diagram source base64-encoded into a
 *      data attribute so it survives HTML processing untouched.
 *
 *   2. `renderMermaidDiagrams()` (called after markdown→HTML conversion) finds
 *      those placeholders, renders each diagram by loading the real mermaid.js
 *      bundle in a headless Chromium browser (Playwright), post-processes the
 *      SVG for WeasyPrint/librsvg compatibility, base64-encodes it as a
 *      data: URI, and replaces the placeholder with an <img> element.
 *
 * Using a real browser gives us:
 *   • Correct getBBox() → proper node sizing and dagre layout
 *   • No NaN coordinates in edge labels
 *   • Accurate viewBox set by mermaid itself
 *
 * SVG post-processing (WeasyPrint/librsvg compatibility):
 *   • <foreignObject> labels are replaced with SVG <text> elements — librsvg
 *     does not support <foreignObject>.  We compute the correct text position
 *     from the foreignObject's actual x/y/width/height attributes so labels are
 *     perfectly centred inside their node boxes.
 *   • Emoji characters are stripped globally to prevent Pango/librsvg from
 *     querying fontconfig for "emoji Not-Rotated With-Color", which crashes on
 *     macOS because Apple Color Emoji (SBIX format) is unsupported by
 *     Homebrew's FreeType build.
 *   • width/height are set from the viewBox so WeasyPrint knows the intrinsic
 *     size; CSS max-width:100% scales the diagram down to fit the content area.
 *   • Embedding as a data: URI (rather than inline SVG) avoids ID conflicts
 *     when multiple diagrams share the same Mermaid-generated anchor names.
 */

import * as fs   from 'fs';
// Type-only: the runtime import is deferred to renderMermaidDiagrams (see there).
import type { Browser, Page } from 'playwright';
import { log } from './logger';
import { escHtml } from './frontmatter';
import { mapPool } from './concurrency';
import { jsonForScript } from './strings';
import { CONFIG } from './config';
import { ExitError } from './errors';

// Mermaid browser bundle — read once and reused for every diagram.
// require.resolve follows the actual node_modules layout (hoisted or not),
// unlike a hardcoded ../node_modules path.
let _mermaidBundle: string | null = null;

function getMermaidBundle(): string {
    if (!_mermaidBundle) {
        const bundlePath = require.resolve('mermaid/dist/mermaid.min.js', { paths: [__dirname] });
        _mermaidBundle = fs.readFileSync(bundlePath, 'utf8');
    }
    return _mermaidBundle;
}

// ── Placeholder format ────────────────────────────────────────────────────────

export const MERMAID_PLACEHOLDER_CLASS = 'mermaid-block';

/**
 * Returns the placeholder HTML that the markdown highlight hook emits.
 *
 * We use a `<pre>` element because markdown-it's fence renderer checks whether
 * the `highlight()` return value starts with `<pre` — if it does, the value is
 * used verbatim; otherwise markdown-it wraps it in its own `<pre><code>`.
 * Using `<pre>` here prevents that double-wrapping.
 *
 * The diagram source is base64-encoded so that HTML entities and special
 * characters don't interfere with later processing.
 */
export function mermaidPlaceholder(diagramSource: string): string {
    const b64 = Buffer.from(diagramSource).toString('base64');
    return `<pre class="${MERMAID_PLACEHOLDER_CLASS}" data-src="${b64}"></pre>`;
}

// ── Browser-based SVG rendering ───────────────────────────────────────────────

/**
 * The self-contained page a diagram is rendered in.
 *
 * Extracted and exported so the two security properties below are locked by a
 * test rather than by a comment. Both are one careless edit from reverting, and
 * neither failure is visible in the output: a diagram renders identically
 * whether or not it just beaconed.
 *
 *  - `securityLevel: 'strict'` is mermaid's default. It was `'loose'`, which
 *    buys click-handler binding — meaningless for a static SVG destined for a
 *    PDF. Measured across eight diagram types, strict renders pixel-identically
 *    (the only textual differences are class-attribute whitespace and a
 *    `text-height` attribute no browser has ever implemented).
 *  - Every interpolated value goes through {@link jsonForScript}, so a node
 *    label containing `</script>` cannot end the element early.
 *
 * The page needs no network at all — the bundle is inlined here and the content
 * arrives via `setContent` — which is what lets the caller abort every request.
 */
export function buildMermaidPage(bundle: string, id: string, code: string): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:white;">
<div id="container"></div>
<script>
${bundle}
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
mermaid.render(${jsonForScript(id)}, ${jsonForScript(code)})
    .then(function(r) {
        document.getElementById('container').innerHTML = r.svg;
        document.documentElement.setAttribute('data-ready', '1');
    })
    .catch(function(e) {
        document.documentElement.setAttribute('data-error', e.message || String(e));
    });
</script>
</body>
</html>`;
}

/**
 * Renders a mermaid diagram to SVG using an existing Chromium browser instance.
 *
 * Accepts a browser created by the caller so a single browser can be reused
 * across all diagrams in a document. Each call creates and closes its own page.
 */
async function renderSvgWithBrowser(browser: Browser, code: string, id: string): Promise<string> {
    const html = buildMermaidPage(getMermaidBundle(), id, code);

    let page: Page | undefined;
    try {
        page = await browser.newPage();

        // The render page has no business touching the network, so it is not
        // allowed to.
        //
        // Everything it needs is already in the string above: the mermaid bundle
        // is inlined and the content arrives via setContent. Any request it does
        // make therefore came from the DOCUMENT — and a diagram label is allowed
        // to contain HTML, so `A["<img src='https://attacker/?x=1'>"]` is a
        // perfectly ordinary-looking node that Chromium will dutifully fetch.
        // Mermaid's own sanitiser does not stop this and is not meant to: it
        // strips `onerror` and `<script>` (verified at every securityLevel), but
        // an <img> with a remote src is a legitimate label. Measured before this
        // guard: two requests to the attacker's URL per render.
        //
        // With the VS Code extension exporting on save, that is a beacon fired by
        // opening someone else's repository and pressing save. Aborting every
        // request closes it without depending on mermaid's sanitiser at all.
        await page.route('**', route => route.abort());

        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        await page.waitForFunction(
            () => document.documentElement.hasAttribute('data-ready') ||
                  document.documentElement.hasAttribute('data-error'),
            { timeout: 20000 },
        );

        const error = await page.evaluate(
            () => document.documentElement.getAttribute('data-error'),
        );
        if (error) throw new Error(`Mermaid render error: ${error}`);

        const svgHtml = await page.evaluate(
            () => document.querySelector('#container svg')?.outerHTML ?? null,
        );
        if (!svgHtml) throw new Error('No SVG element produced by mermaid');

        return svgHtml;
    } finally {
        await page?.close();
    }
}

// ── SVG post-processing ───────────────────────────────────────────────────────

/**
 * Removes emoji and their modifier/variation sequences from a string.
 *
 * When librsvg renders `<text>` elements via Pango, it queries fontconfig for
 * the generic "emoji" family to handle pictographic characters.  On macOS,
 * Apple Color Emoji uses the SBIX colour-font format, which Homebrew's FreeType
 * build does not support — so Pango fails to load it and crashes with
 * "Could not load fallback font, bailing out".
 *
 * Stripping emoji from SVG text before rasterisation prevents this lookup
 * entirely.  The emoji would not be visible in the diagram anyway (librsvg has
 * no colour emoji support), so nothing useful is lost.
 */
const SVG_EMOJI_RE = /\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}\u{20E3}]*/gu;

export function stripSvgEmoji(s: string): string {
    return s.replace(SVG_EMOJI_RE, '');
}

/**
 * Replaces every `<foreignObject>` with an SVG `<text>` element.
 *
 * WeasyPrint/librsvg do not support `<foreignObject>`.  Mermaid uses it for
 * node labels.  We replace each one with a `<text>` whose position is derived
 * from the foreignObject's own x/y/width/height attributes, so the label is
 * centred exactly where the foreignObject was.
 *
 * Structure produced by mermaid for each node:
 *
 *   <g class="node" transform="translate(Nx, Ny)">          ← node centre
 *     <rect …/>                                              ← node box
 *     <g class="label" transform="translate(Lx, Ly)">       ← label origin
 *       <foreignObject width="W" height="H" [x=X] [y=Y]>   ← label area
 *         <div>…text…</div>
 *       </foreignObject>
 *     </g>
 *   </g>
 *
 * The foreignObject's centre in label-group coordinates is (X+W/2, Y+H/2).
 * Placing `<text x="cx" y="cy" text-anchor="middle" dominant-baseline="middle">`
 * in the same `<g class="label">` correctly centres the label inside the node.
 */
export function replaceForeignObjects(svg: string): string {
    const FONT_SIZE = 14;
    const LINE_H    = 18;   // line-height in SVG user units

    return svg.replace(
        /<foreignObject([^>]*)>([\s\S]*?)<\/foreignObject>/g,
        (_match: string, attrs: string, inner: string) => {
            // Read foreignObject geometry (x/y default to 0 if absent)
            const foX = parseFloat(attrs.match(/\bx="([-\d.]+)"/)?.[1]  ?? '0');
            const foY = parseFloat(attrs.match(/\by="([-\d.]+)"/)?.[1]  ?? '0');
            const foW = parseFloat(attrs.match(/\bwidth="([-\d.]+)"/)?.[1]  ?? '100');
            const foH = parseFloat(attrs.match(/\bheight="([-\d.]+)"/)?.[1] ?? '40');

            // Centre of the foreignObject in its parent-group coordinate system
            const cx = foX + foW / 2;
            const cy = foY + foH / 2;

            // Extract plain text from the HTML inside the foreignObject.
            // Emoji are stripped to prevent Pango/librsvg from trying to load a
            // colour-emoji font (Apple Color Emoji uses SBIX, unsupported by
            // Homebrew's FreeType) which would crash with "Could not load
            // fallback font, bailing out".
            const text = stripSvgEmoji(
                inner
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&amp;/g,  '&')
                    .replace(/&lt;/g,   '<')
                    .replace(/&gt;/g,   '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g,  "'")
                    .trim(),
            );

            if (!text) return '';

            const lines = text.split('\n').filter(Boolean);
            if (lines.length === 0) return '';

            // For multi-line labels stack tspans around the vertical centre (cy).
            // First tspan uses dy to shift up from cy so the whole block is
            // centred; subsequent tspans use dy=LINE_H to step down.
            const startOffset = -((lines.length - 1) * LINE_H) / 2;

            const tspans = lines.map((line, i) => {
                const escaped = line
                    .replace(/&/g,  '&amp;')
                    .replace(/</g,  '&lt;')
                    .replace(/>/g,  '&gt;');
                // First tspan: dy shifts up from cy; rest step down by LINE_H
                const dy = i === 0 ? startOffset : LINE_H;
                return `<tspan x="${cx}" dy="${dy}">${escaped}</tspan>`;
            }).join('');

            return (
                `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" ` +
                `font-family="sans-serif" font-size="${FONT_SIZE}" fill="#333">` +
                tspans +
                `</text>`
            );
        },
    );
}

/**
 * Post-processes a browser-rendered Mermaid SVG and returns it as a
 * base64-encoded SVG data URL suitable for use in an <img> element.
 *
 * Using a data URL rather than an inline <svg> element avoids ID conflicts
 * when multiple diagrams share the same Mermaid-generated anchor names (e.g.
 * flowchart-Start-0).  Each <img> document is isolated.
 *
 * Steps:
 *   1. Replace <foreignObject> labels with SVG <text> (librsvg compatibility).
 *   2. Strip emoji globally to prevent the Pango/librsvg crash on macOS.
 *   3. Remove Mermaid's max-width inline style (conflicts with explicit size).
 *   4. Set width/height from the viewBox so WeasyPrint knows intrinsic size.
 *   5. Darken neutral-grey node borders for print legibility.
 *   6. Base64-encode → data:image/svg+xml URI.
 *
 * @param stripEmoji Whether to run step 2 at all. Defaults to true — the safe,
 *   historical behaviour — so every existing caller keeps stripping unless it
 *   explicitly knows the target WeasyPrint can render colour emoji (see
 *   `colorEmojiRenderingSupported` in weasyprint.ts).
 */
export function svgToDataUrl(rawSvg: string, stripEmoji: boolean = true): string {
    // 1. Replace <foreignObject> with <text>
    let svg = replaceForeignObjects(rawSvg);

    // 2. Strip emoji globally, unless the caller has confirmed the target
    //    WeasyPrint can render them.
    //     A global string-level strip is used deliberately: regex-based XML
    //     processing (targeting <text>/<tspan> tags) is fragile against
    //     Mermaid's varied SVG structure and risks producing mismatched tags.
    //     Emoji characters never appear in SVG structural content (IDs, tag
    //     names, attribute names, URLs, base64 data) so a global strip is safe.
    if (stripEmoji) svg = stripSvgEmoji(svg);

    // 3. Strip Mermaid's max-width inline style
    svg = svg.replace(/(<svg\b[^>]*)\sstyle="[^"]*max-width\s*:[^"]*"/, '$1');

    // 4. Set width/height from the viewBox
    const vbMatch = svg.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/);
    if (vbMatch) {
        const vbW = parseFloat(vbMatch[3]);
        const vbH = parseFloat(vbMatch[4]);

        svg = svg
            .replace(/(<svg\b[^>]*)\swidth="[^"]*"/,  `$1 width="${vbW}"`)
            .replace(/(<svg\b[^>]*)\sheight="[^"]*"/, `$1 height="${vbH}"`);

        // Ensure height attribute is present even if Mermaid omitted it
        if (!/\bheight="/.test(svg.slice(0, svg.indexOf('>')))) {
            svg = svg.replace(/(<svg\b[^>]*)>/, `$1 height="${vbH}">`);
        }

        // 5. Darken neutral-grey node borders for print legibility
        svg = svg.replace(/\bstroke:#999\b/g, 'stroke:#555');
    }

    // 6. Base64-encode → data URI
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** CSS injected into <head> when at least one mermaid diagram is present. */
export const MERMAID_CSS = `
/* ── Mermaid diagram styles ─────────────────── */
.mermaid-figure {
    display: block;
    margin: 1.5em auto;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
}
.mermaid-figure > img {
    display: block;
    margin: 0 auto;
    max-width: 100%;
}
.mermaid-error {
    border: 1px solid #c00;
    border-radius: 4px;
    padding: 0.75em 1em;
    color: #c00;
    font-size: 0.9em;
}
`;

const PLACEHOLDER_RE = new RegExp(
    `<pre class="${MERMAID_PLACEHOLDER_CLASS}" data-src="([^"]+)"></pre>`,
    'g',
);

/** The one wording for a missing Chromium, so the two callers cannot drift. */
export const CHROMIUM_MISSING_MESSAGE =
    'Chromium for Playwright is not installed (required for Mermaid rendering).\n' +
    'Run "platen-markdown-export --setup" or "npx playwright install chromium" and try again.';

/**
 * The other way Mermaid rendering can be unavailable: no playwright at all.
 *
 * Playwright is an optionalDependency — a whole browser-automation library, and
 * a browser binary behind it, carried for one feature most documents never use.
 * An install without it (a registry that could not serve it, a platform with no
 * build, or someone who removed it deliberately) is a supported state, so it
 * gets a sentence rather than the MODULE_NOT_FOUND stack trace it used to
 * produce.
 *
 * The message does NOT suggest `--omit=optional` as the way to opt out, though
 * it would work: that flag is not package-scoped, and sharp ships its own
 * platform binaries as optional dependencies, so omitting them breaks image
 * handling entirely with a much worse error than this one. Verified, not
 * assumed — it is exactly what happened while testing this path.
 */
export const PLAYWRIGHT_MISSING_MESSAGE =
    'Playwright is not installed (required for Mermaid rendering).\n' +
    'It is an optional dependency, so an install may legitimately not have it.\n' +
    'Run "npm install playwright && platen-markdown-export --setup", or remove the\n' +
    'Mermaid diagrams from this document to export without it.';

/**
 * Whether `err` is "the module could not be resolved" for `moduleName`.
 *
 * Matched on the error CODE rather than on message text, and confirmed to name
 * the module we tried to load — a MODULE_NOT_FOUND raised from *inside*
 * playwright (a broken install missing one of its own files) is a different
 * problem and must not be reported as "playwright is not installed".
 *
 * Exported for testing: the branch is unreachable on a machine where the install
 * succeeded, which is every machine that runs this suite.
 */
export function isModuleNotFound(err: unknown, moduleName: string): boolean {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;
    const msg = err instanceof Error ? err.message : String(err);
    return new RegExp(`'${moduleName}'|"${moduleName}"`).test(msg);
}

/**
 * Whether the rendered document still holds unrendered Mermaid placeholders.
 *
 * `lastIndex` is reset first: `PLACEHOLDER_RE` is global and `.test()` advances
 * it, so a shared global regex answers differently on alternate calls. That is
 * a genuinely nasty bug to chase, and this is the only predicate that calls
 * `.test()` on it.
 */
export function hasMermaidPlaceholders(html: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(html);
}

/**
 * Every Mermaid placeholder in `html`, from the start.
 *
 * `matchAll` copies the pattern's *current* `lastIndex` onto its clone — unlike
 * `.replace()`, which resets a global regex itself — so after a
 * {@link hasMermaidPlaceholders} call the scan began just past the first
 * diagram. Once `main()` started asking "does this document have a diagram?"
 * before rendering, every export lost its first Mermaid diagram, silently: the
 * placeholder stayed an empty `<pre>` and nothing was logged.
 */
export function findMermaidPlaceholders(html: string): RegExpExecArray[] {
    PLACEHOLDER_RE.lastIndex = 0;
    return [...html.matchAll(PLACEHOLDER_RE)];
}

/**
 * Whether the Chromium a Mermaid render needs is actually on disk.
 *
 * Resolves the path rather than launching a browser — the launch is what the
 * render does, and costs seconds; this is for `--dry-run`, which is supposed to
 * be cheap. Playwright pins the browser to the package version, so a playwright
 * upgrade orphans a perfectly good install and this starts returning false with
 * nothing else having changed.
 */
export async function chromiumInstalled(): Promise<boolean> {
    return (await mermaidUnavailableReason()) === null;
}

/**
 * Why a Mermaid render could not happen, or null when it can.
 *
 * `chromiumInstalled` answers the same question as a boolean, which meant a dry
 * run reported the missing *browser* even when what was actually absent was the
 * playwright *package* — two different absences with two different remedies, and
 * since playwright became an optionalDependency the second is a supported state
 * rather than a broken install.
 */
export async function mermaidUnavailableReason(): Promise<string | null> {
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch (err: unknown) {
        return isModuleNotFound(err, 'playwright') ? PLAYWRIGHT_MISSING_MESSAGE : CHROMIUM_MISSING_MESSAGE;
    }
    try {
        const exe = chromium.executablePath();
        return Boolean(exe) && fs.existsSync(exe) ? null : CHROMIUM_MISSING_MESSAGE;
    } catch {
        // playwright is present but refuses to name a path — a render still
        // cannot happen, and the browser is the thing to go and install.
        return CHROMIUM_MISSING_MESSAGE;
    }
}

/** One rendered diagram: the placeholder it came from and what replaces it. */
export interface MermaidReplacement {
    placeholder: string;
    replacement: string;
}

/**
 * What a diagram that failed to render leaves in the document — and the warning
 * that failure raises.
 *
 * The warning is the point. This used to log `  diagram 3: ERROR — …`, which is
 * not a warning as far as `logger.ts` is concerned: it counts a line only when
 * it starts with `WARNING:` at column zero, and that string starts with two
 * spaces. So a diagram that failed to render produced a red error box in the
 * exported PDF, printed nothing at all under `--quiet` (which suppresses
 * everything except warnings), sent its one line to stdout instead of stderr,
 * and **exited 0 under `--strict`** — the flag whose entire job is to refuse a
 * document with a broken reference. A missing *image* failed the same run
 * correctly; a missing *diagram* did not.
 *
 * Extracted and exported so that property is locked by a test rather than by a
 * comment: the render path itself needs a Chromium, and the suite must pass on a
 * cold runner without one.
 *
 * Both interpolations are escaped. The message is not a safe string — a Mermaid
 * parse error quotes the line it choked on, so a label containing `<` used to
 * close the block early and spill the rest of the report into the document as
 * markup.
 */
export function mermaidErrorReplacement(index: number, code: string, message: string): string {
    log(`WARNING: Mermaid diagram ${index} failed to render — ${message}`);
    return (
        `<div class="mermaid-error">` +
        `<p><strong>Mermaid render error:</strong> ${escHtml(message)}</p>` +
        `<pre><code>${escHtml(code)}</code></pre>` +
        `</div>`
    );
}

/**
 * Substitutes rendered diagrams back into the document in a single pass.
 *
 * One pass, for the same reason as `inlineImages` and `renderDrawioDiagrams`: a
 * `.replace` per diagram is a full scan of a document these SVG data URIs have
 * just made large, so a 30-diagram report scanned a multi-megabyte string 30
 * times, and each scan re-walked the megabytes the previous ones had inserted.
 *
 * A queue per placeholder rather than a plain map, because two identical
 * diagrams share a placeholder byte-for-byte — it is keyed on the diagram source
 * — while their replacements differ in the alt text's index. `mapPool` preserves
 * input order, so shifting one per occurrence lands them in document order,
 * exactly where the per-diagram loop used to put them.
 *
 * Split out from the render so the substitution is testable without Chromium.
 */
export function applyMermaidReplacements(html: string, replacements: readonly MermaidReplacement[]): string {
    const queued = new Map<string, string[]>();
    for (const { placeholder, replacement } of replacements) {
        const list = queued.get(placeholder);
        if (list) list.push(replacement);
        else queued.set(placeholder, [replacement]);
    }
    return html.replace(PLACEHOLDER_RE, ph => queued.get(ph)?.shift() ?? ph);
}

/**
 * Finds every mermaid placeholder in `html`, renders all diagrams in parallel
 * using a single shared Chromium browser, and returns the updated HTML string.
 *
 * If no placeholders are found the original string is returned unchanged.
 *
 * @param stripEmoji Passed through to `svgToDataUrl` for every diagram;
 *   defaults to true. See `colorEmojiRenderingSupported` in weasyprint.ts.
 */
export async function renderMermaidDiagrams(html: string, stripEmoji: boolean = true): Promise<string> {
    const matches = findMermaidPlaceholders(html);
    if (matches.length === 0) return html;

    log(`Rendering ${matches.length} Mermaid diagram(s) via Playwright/Chromium…`);

    let browser: Browser | undefined;
    try {
        try {
            // Loaded here, not at module scope: `index.ts` imports this module on
            // every run, and requiring playwright costs ~120 ms of startup even for
            // the majority of documents that contain no diagram at all. Nothing
            // above this line touches it, and the early return above means a
            // diagram-free export never reaches this point.
            const { chromium } = await import('playwright');
            browser = await chromium.launch({ headless: true });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // Two different absences, two different remedies. Playwright is an
            // OPTIONAL dependency — it is a browser automation library carried
            // for one feature, and most documents have no diagram at all — so
            // the package itself may simply not be installed. That arrives as a
            // module-resolution failure and used to escape as a raw stack trace
            // under the generic exit 1.
            if (isModuleNotFound(err, 'playwright')) {
                throw new ExitError(PLAYWRIGHT_MISSING_MESSAGE, 4);
            }
            if (/executable doesn't exist|playwright install/i.test(msg)) {
                throw new ExitError(CHROMIUM_MISSING_MESSAGE, 4);
            }
            throw err;
        }

        // Bounded: each task opens its own Chromium page inside the shared
        // browser, and a page is not cheap — a 30-diagram document opening 30
        // at once is how this turns into a memory spike or a render timeout.
        const replacements = await mapPool(matches, CONFIG.concurrency, async (match, i) => {
                const b64   = match[1];
                const code  = Buffer.from(b64, 'base64').toString('utf8');
                const index = i + 1;
                const id    = `mermaid-diag-${index}`;

                try {
                    const rawSvg    = await renderSvgWithBrowser(browser!, code, id);
                    const svgDataUrl = svgToDataUrl(rawSvg, stripEmoji);
                    log(`  diagram ${index}: rendered → SVG (${(svgDataUrl.length / 1024).toFixed(0)} KB)`);
                    return { placeholder: match[0], replacement: `<div class="diagram-figure mermaid-figure"><img src="${svgDataUrl}" alt="Mermaid diagram ${index}"></div>` };
                } catch (err: unknown) {
                    return {
                        placeholder: match[0],
                        replacement: mermaidErrorReplacement(
                            index, code, err instanceof Error ? err.message : String(err)),
                    };
                }
        });

        return applyMermaidReplacements(html, replacements);
    } finally {
        await browser?.close();
    }
}
