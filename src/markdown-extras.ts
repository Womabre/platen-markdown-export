import type MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';
import { log } from './logger';

// ── Frontmatter variables ─────────────────────────────────────────────────────

/**
 * Substitutes `{{Name}}` (spaces around the name allowed) from the frontmatter
 * `Variables:` map. Applied to the raw markdown before parsing, so a value can
 * be anything — a word, a URL, a whole sentence.
 *
 * Unknown placeholders are left verbatim and warned about once each: silently
 * blanking them would let a typo'd `{{Cutsomer}}` ship as an invisible hole in
 * a customer deliverable.
 */
export function applyVariables(body: string, variables: Record<string, string>): string {
    const unknown = new Set<string>();

    // Code regions are matched by the same pass and passed through untouched:
    // a document explaining this very feature writes `{{Name}}` as an example,
    // and substituting (or warning about) it would be wrong.
    const CODE_OR_VAR =
        /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\{\{\s*([\w.-]+)\s*\}\}/g;

    const out = body.replace(CODE_OR_VAR, (match, code: string | undefined, name: string | undefined) => {
        if (code !== undefined) return code;
        if (Object.prototype.hasOwnProperty.call(variables, name!)) return variables[name!]!;
        unknown.add(name!);
        return match;
    });

    for (const name of unknown) {
        log(`WARNING: No Variables entry for "{{${name}}}" — left as-is`);
    }
    return out;
}

// ── Fenced code-block line highlighting (`lang:2,4-6` in the fence info string) ─
//
// A `{2,4-6}` suffix collides with markdown-it-attrs, which already owns `{...}`
// on fence info strings (e.g. `{.some-class}`) and silently swallows it before
// any highlight() callback would see it — so line ranges use a colon suffix
// instead: ```typescript:2,4-6.

/** Splits a fence lang token like `typescript:2,4-6` into `["typescript", "2,4-6"]`. */
export function splitLangSpec(rawLang: string): [lang: string, rangeSpec: string] {
    const i = rawLang.indexOf(':');
    return i === -1 ? [rawLang, ''] : [rawLang.slice(0, i), rawLang.slice(i + 1)];
}

/** Parses a `2,4-6` line-range spec into the set of 1-indexed line numbers it covers. */
export function extractHighlightLines(rangeSpec: string): Set<number> {
    const lines = new Set<number>();
    if (!rangeSpec) return lines;
    for (const part of rangeSpec.split(',')) {
        const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
        if (!m) continue;
        const start = parseInt(m[1]!, 10);
        const end   = m[2] ? parseInt(m[2], 10) : start;
        for (let n = start; n <= end; n++) lines.add(n);
    }
    return lines;
}

/**
 * Wraps every line of already-highlighted code HTML in a `.code-line` span,
 * adding `.hljs-line-highlight` to the 1-indexed lines named by `highlightLines`.
 *
 * Every line is wrapped (not just highlighted ones) so the optional
 * `Code Line Numbers` frontmatter switch has a per-line element to hang a CSS
 * counter off — the wrapping is inert until one of the two features styles it.
 *
 * highlight.js emits only `<span class="...">` and `</span>` tags, so a syntax
 * span can straddle a line break (e.g. a multi-line comment); this re-opens and
 * re-closes any span still open at each line boundary so every line stays
 * independently well-formed once wrapped.
 *
 * The trailing newline that fences always carry would otherwise become a final
 * empty line — and a phantom extra line number — so it is preserved outside the
 * wrapping rather than wrapped.
 *
 * That newline is not always the last character: when a construct is still open
 * at end of input (an XML `<!DOCTYPE …[`, an unterminated comment) highlight.js
 * closes its span *after* it, leaving `…\n</span>`. Matching the newline plus
 * any trailing closers — rather than testing the last character — catches both
 * shapes. The dangling closers are safe to drop because every emitted line is
 * re-balanced independently below.
 */
export function wrapCodeLines(html: string, highlightLines: Set<number>): string {
    const trailing        = /\n(?:<\/span>)*$/.exec(html);
    const trailingNewline = trailing !== null;
    const source          = trailingNewline ? html.slice(0, trailing.index) : html;

    const spanTagRe = /<span class="[^"]*">|<\/span>/g;
    const openStack: string[] = [];

    const outputLines = source.split('\n').map((line, i) => {
        const prefix = openStack.join('');

        spanTagRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = spanTagRe.exec(line)) !== null) {
            if (m[0] === '</span>') openStack.pop();
            else openStack.push(m[0]);
        }

        const suffix  = '</span>'.repeat(openStack.length);
        const classes = highlightLines.has(i + 1)
            ? 'code-line hljs-line-highlight'
            : 'code-line';
        return `<span class="${classes}">${prefix}${line}${suffix}</span>`;
    });

    return outputLines.join('\n') + (trailingNewline ? '\n' : '');
}

// ── Auto-numbered table/figure captions ────────────────────────────────────────

/**
 * Converts a `Table: caption` / `Figure: caption` paragraph immediately after
 * a table or a standalone image into a numbered caption, e.g. "Table 2. caption".
 * Tables and figures are numbered independently, in document order.
 *
 * A figure's image can be a plain markdown image (`<p><img></p>`) or a
 * rendered diagram — any `<div class="diagram-figure …"><img></div>`, the
 * shared class every renderer (Mermaid, Graphviz, infographic) emits beside its
 * own. Matching the shared class rather than one renderer's is the point: this
 * matched only `mermaid-figure`, so a Graphviz figure's caption was never
 * numbered. Call this AFTER the diagram renderers, so every figure already
 * exists as a real `<img>`; on raw markdown-it output each diagram is still an
 * unrendered code fence.
 *
 * Each caption gets a stable `id` (`table-1`, `figure-1`, …) so the optional
 * List of Tables / List of Figures indexes can link to it and resolve its page
 * number via `target-counter`.
 */
export function applyCaptions(html: string): string {
    let tableN  = 0;
    let figureN = 0;

    html = html.replace(
        /(<\/table>\s*)<p>Table:\s*([\s\S]*?)<\/p>/g,
        (_match, prefix: string, caption: string) => {
            tableN++;
            return `${prefix}<p class="caption caption-table" id="table-${tableN}">`
                 + `<span class="caption-label">Table ${tableN}.</span> ${caption.trim()}</p>`;
        },
    );

    html = html.replace(
        /(<p>\s*<img[^>]*>\s*<\/p>\s*|<div class="diagram-figure[^"]*">\s*<img[^>]*>\s*<\/div>\s*)<p>Figure:\s*([\s\S]*?)<\/p>/g,
        (_match, prefix: string, caption: string) => {
            figureN++;
            return `${prefix}<p class="caption caption-figure" id="figure-${figureN}">`
                 + `<span class="caption-label">Figure ${figureN}.</span> ${caption.trim()}</p>`;
        },
    );

    return html;
}

// ── Wide-table auto-fit ─────────────────────────────────────────────────────────

/** Header-row column count (colspan-aware) at which a table gets the aggressive wrap treatment. */
const DENSE_TABLE_COLUMN_THRESHOLD = 10;

/**
 * Tags a table `class="table-dense"` when its header row has
 * {@link DENSE_TABLE_COLUMN_THRESHOLD} or more columns (summing `colspan`),
 * so `TABLE_FIT_CSS` (html.ts) opts it into `overflow-wrap: anywhere`
 * instead of the gentler default `break-word`.
 *
 * Column count is a proxy, not a measurement — this runs before layout, so
 * there's no way to know a table's actual rendered width. It's a deliberately
 * conservative one: empirically, a 9-column table of short cells still wraps
 * onto the page under `break-word`, a 10-column one doesn't (WeasyPrint has no
 * built-in table-shrink; `break-word` wraps at spaces but never below a
 * word's own width, so a wide enough table still bleeds off the page edge).
 * Tables under the threshold are left on the gentle default, which is what
 * keeps ordinary tables from fragmenting short header words like "Comments".
 */
export function markDenseTables(html: string): string {
    return html.replace(
        /<table\b([^>]*)>([\s\S]*?)<\/table>/g,
        (match: string, attrs: string, body: string) => {
            const headerRow = /<tr\b[^>]*>([\s\S]*?)<\/tr>/.exec(body);
            if (!headerRow) return match;

            let columns = 0;
            const cellRe = /<th\b([^>]*)>/g;
            let cell: RegExpExecArray | null;
            while ((cell = cellRe.exec(headerRow[1])) !== null) {
                const colspan = /colspan=["']?(\d+)/.exec(cell[1]);
                columns += colspan ? parseInt(colspan[1], 10) : 1;
            }
            if (columns < DENSE_TABLE_COLUMN_THRESHOLD) return match;

            const newAttrs = /\bclass=["']/.test(attrs)
                ? attrs.replace(/\bclass=(["'])/, 'class=$1table-dense ')
                : `${attrs} class="table-dense"`;
            return `<table${newAttrs}>${body}</table>`;
        },
    );
}

// ── Layout containers: ::: columns / ::: column / ::: landscape ────────────────

/** Registers one `::: name` container rendering as `<div class="cssClass">`. */
function registerDivContainer(md: MarkdownIt.MarkdownIt, name: string, cssClass: string): void {
    md.use(container, name, {
        validate: (params: string) => params.trim() === name,
        render:   (tokens: Array<{ nesting: number }>, idx: number) =>
            tokens[idx]!.nesting === 1 ? `<div class="${cssClass}">\n` : '</div>\n',
    });
}

/**
 * Registers the layout containers:
 *   `::: columns` wrapping `::: column` blocks — side-by-side content
 *   `::: landscape`                            — one landscape sheet
 *   `::: portrait`                             — one portrait sheet
 *
 * The two orientation containers are symmetric: each forces its own sheet
 * regardless of the document's `Orientation`, so a landscape document can drop
 * back to portrait for one page and vice versa.
 *
 * Nested containers must use fences of differing length (`::::` outside,
 * `:::` inside); equal-length fences are ambiguous to markdown-it-container.
 */
export function registerLayoutContainers(md: MarkdownIt.MarkdownIt): void {
    registerDivContainer(md, 'columns',   'md-columns');
    registerDivContainer(md, 'column',    'md-column');
    registerDivContainer(md, 'landscape', 'md-landscape');
    registerDivContainer(md, 'portrait',  'md-portrait');
}

/**
 * Keeps the markdown emphasis syntaxes free of the redline tint.
 *
 * The revision marks are the HTML tags — `<ins>` and `<del>` — so that plain
 * markdown stays portable: `~~x~~` means the same struck-through text here as
 * it does on GitHub, rather than silently implying a tracked revision.
 *
 * `~~x~~` needs no help; it renders to `<s>`, which the themes leave unstyled.
 * `++x++` does, because markdown-it-ins renders it to the very `<ins>` tag that
 * carries the tint — the class is how a stylesheet tells the two apart, and it
 * gives markdown a plain underline, which the language otherwise lacks.
 */
export function registerRedlineMarks(md: MarkdownIt.MarkdownIt): void {
    md.renderer.rules.ins_open = () => '<ins class="md-plain">';
}
