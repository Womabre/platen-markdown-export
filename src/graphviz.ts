/**
 * Graphviz diagram pre-rendering for WeasyPrint.
 *
 * WeasyPrint doesn't run JavaScript, so Graphviz diagrams must be converted to
 * a static image before the HTML is handed to WeasyPrint. Unlike Mermaid,
 * Graphviz's own layout engine ships as a WASM module (@hpcc-js/wasm-graphviz)
 * that runs synchronously in Node — no headless browser, no network, no
 * external binary to install. We still follow the same two-step shape as
 * mermaid.ts so the pipeline has one pattern for "diagram source in a fence":
 *
 *   1. The markdown `highlight()` hook emits a placeholder element for every
 *      ```dot / ```graphviz code block, with the diagram source base64-encoded
 *      into a data attribute so it survives HTML processing untouched.
 *
 *   2. `renderGraphvizDiagrams()` (called after markdown→HTML conversion) finds
 *      those placeholders, lays each one out via the WASM engine, strips
 *      emoji (the same Pango/librsvg crash Mermaid diagrams can hit — see
 *      mermaid.ts), base64-encodes the SVG as a data: URI, and replaces the
 *      placeholder with an <img> element.
 *
 * No foreignObject handling is needed here: Graphviz's own SVG backend
 * renders every label — including HTML-like `<TABLE>` labels — with plain
 * <text>/<polygon> elements, never <foreignObject>. That's a librsvg
 * incompatibility specific to Mermaid's browser-based renderer.
 */

import { log } from './logger';
import { escHtml } from './frontmatter';
import { stripSvgEmoji } from './mermaid';

// ── Placeholder format ────────────────────────────────────────────────────────

export const GRAPHVIZ_PLACEHOLDER_CLASS = 'graphviz-block';

/**
 * Returns the placeholder HTML that the markdown highlight hook emits.
 *
 * Mirrors {@link import('./mermaid').mermaidPlaceholder}: a `<pre>` so
 * markdown-it's fence renderer uses the value verbatim instead of double-
 * wrapping it, and base64 so HTML entities in the DOT source can't interfere
 * with later string processing.
 */
export function graphvizPlaceholder(diagramSource: string): string {
    const b64 = Buffer.from(diagramSource).toString('base64');
    return `<pre class="${GRAPHVIZ_PLACEHOLDER_CLASS}" data-src="${b64}"></pre>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────────

/** CSS injected into <head> when at least one Graphviz diagram is present. */
export const GRAPHVIZ_CSS = `
/* ── Graphviz diagram styles ─────────────────── */
.graphviz-figure {
    display: block;
    margin: 1.5em auto;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
}
.graphviz-figure > img {
    display: block;
    margin: 0 auto;
    max-width: 100%;
}
.graphviz-error {
    border: 1px solid #c00;
    border-radius: 4px;
    padding: 0.75em 1em;
    color: #c00;
    font-size: 0.9em;
}
`;

const PLACEHOLDER_RE = new RegExp(
    `<pre class="${GRAPHVIZ_PLACEHOLDER_CLASS}" data-src="([^"]+)"></pre>`,
    'g',
);

/**
 * Whether the rendered document still holds unrendered Graphviz placeholders.
 *
 * `lastIndex` is reset first for the same reason as
 * {@link import('./mermaid').hasMermaidPlaceholders}: `PLACEHOLDER_RE` is
 * global, and `.test()` advances it, so a shared global regex answers
 * differently on alternate calls.
 */
export function hasGraphvizPlaceholders(html: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(html);
}

/**
 * What a diagram that failed to render leaves in the document — and the
 * warning that failure raises. Mirrors
 * {@link import('./mermaid').mermaidErrorReplacement}: the log line must start
 * with `WARNING:` at column zero for `logger.ts` to count it, which is what
 * lets `--strict` refuse a document with a broken diagram instead of silently
 * shipping a red error box.
 *
 * Both interpolations are escaped — a DOT syntax error quotes the line it
 * choked on, and an unescaped `<` in that quote would close the block early.
 */
export function graphvizErrorReplacement(index: number, code: string, message: string): string {
    log(`WARNING: Graphviz diagram ${index} failed to render — ${message}`);
    return (
        `<div class="graphviz-error">` +
        `<p><strong>Graphviz render error:</strong> ${escHtml(message)}</p>` +
        `<pre><code>${escHtml(code)}</code></pre>` +
        `</div>`
    );
}

/** One rendered diagram: the placeholder it came from and what replaces it. */
export interface GraphvizReplacement {
    placeholder: string;
    replacement: string;
}

/**
 * Substitutes rendered diagrams back into the document in a single pass.
 *
 * Same shape as {@link import('./mermaid').applyMermaidReplacements}, for the
 * same reason: a `.replace` per diagram re-scans a document these SVG data
 * URIs have just made large, and two identical diagrams share a placeholder
 * byte-for-byte (keyed on source), so a plain map would hand both occurrences
 * the same replacement instead of one each in document order.
 */
export function applyGraphvizReplacements(html: string, replacements: readonly GraphvizReplacement[]): string {
    const queued = new Map<string, string[]>();
    for (const { placeholder, replacement } of replacements) {
        const list = queued.get(placeholder);
        if (list) list.push(replacement);
        else queued.set(placeholder, [replacement]);
    }
    return html.replace(PLACEHOLDER_RE, ph => queued.get(ph)?.shift() ?? ph);
}

/**
 * Post-processes a WASM-rendered Graphviz SVG and returns it as a base64
 * data URL, mirroring {@link import('./mermaid').svgToDataUrl}'s output shape
 * so both diagram types embed into the document the same way.
 *
 * Graphviz's SVG backend already sets correct width/height/viewBox and never
 * emits <foreignObject>, so the only shared post-processing step with Mermaid
 * is the emoji strip — Pango (via librsvg) crashes trying to load Apple Color
 * Emoji's SBIX glyphs on macOS, the same failure `stripSvgEmoji` exists for.
 *
 * @param stripEmoji Defaults to true — the safe, historical behaviour — so
 *   every existing caller keeps stripping unless it explicitly knows the
 *   target WeasyPrint can render colour emoji (see
 *   `colorEmojiRenderingSupported` in weasyprint.ts).
 */
export function graphvizSvgToDataUrl(rawSvg: string, stripEmoji: boolean = true): string {
    const svg = stripEmoji ? stripSvgEmoji(rawSvg) : rawSvg;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Loaded lazily and cached: instantiating the WASM module has a real cost,
// and most documents contain no Graphviz diagram at all. One instance is
// reused across every diagram in a document (and across renderGraphvizDiagrams
// calls within the same process, e.g. --mode pdf,html or --watch).
let _graphvizPromise: Promise<import('@hpcc-js/wasm-graphviz').Graphviz> | null = null;

function getGraphviz(): Promise<import('@hpcc-js/wasm-graphviz').Graphviz> {
    if (!_graphvizPromise) {
        _graphvizPromise = import('@hpcc-js/wasm-graphviz').then(({ Graphviz }) => Graphviz.load());
    }
    return _graphvizPromise;
}

/**
 * Finds every Graphviz placeholder in `html`, lays out each diagram via the
 * WASM engine, and returns the updated HTML string.
 *
 * If no placeholders are found the original string is returned unchanged —
 * `getGraphviz()` is never called, so a document with no Graphviz diagram
 * never pays the WASM instantiation cost.
 *
 * Unlike `renderMermaidDiagrams`, rendering is synchronous CPU work with no
 * I/O, so diagrams are laid out in a plain sequential loop rather than a
 * bounded `mapPool` — there is no concurrent work to bound.
 *
 * @param stripEmoji Passed through to `graphvizSvgToDataUrl` for every
 *   diagram; defaults to true. See `colorEmojiRenderingSupported` in
 *   weasyprint.ts.
 */
export async function renderGraphvizDiagrams(html: string, stripEmoji: boolean = true): Promise<string> {
    // matchAll clones PLACEHOLDER_RE but copies its CURRENT lastIndex onto the
    // clone (unlike .replace(), which resets a global regex's lastIndex to 0
    // itself) — so a prior hasGraphvizPlaceholders() call elsewhere in the same
    // process, which advances lastIndex via .test(), would make this silently
    // start scanning mid-string and miss placeholders. Reset defensively.
    PLACEHOLDER_RE.lastIndex = 0;
    const matches = [...html.matchAll(PLACEHOLDER_RE)];
    if (matches.length === 0) return html;

    log(`Rendering ${matches.length} Graphviz diagram(s)...`);
    const graphviz = await getGraphviz();

    const replacements: GraphvizReplacement[] = matches.map((match, i) => {
        const b64   = match[1];
        const code  = Buffer.from(b64, 'base64').toString('utf8');
        const index = i + 1;

        try {
            const rawSvg     = graphviz.dot(code);
            const svgDataUrl = graphvizSvgToDataUrl(rawSvg, stripEmoji);
            log(`  diagram ${index}: rendered → SVG (${(svgDataUrl.length / 1024).toFixed(0)} KB)`);
            return {
                placeholder: match[0],
                replacement: `<div class="diagram-figure graphviz-figure"><img src="${svgDataUrl}" alt="Graphviz diagram ${index}"></div>`,
            };
        } catch (err: unknown) {
            return {
                placeholder: match[0],
                replacement: graphvizErrorReplacement(
                    index, code, err instanceof Error ? err.message : String(err)),
            };
        }
    });

    return applyGraphvizReplacements(html, replacements);
}
