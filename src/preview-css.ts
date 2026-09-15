/**
 * Rewrites export CSS so it themes one element inside someone else's page.
 *
 * An export owns its whole document: its stylesheet can say `body`, `table` or
 * `.code-line` and mean exactly its own markup. A live preview is not that. The
 * theme's HTML is dropped into a page VS Code (or Markdown Preview Enhanced)
 * built, next to CSS from every other extension that styles the preview — and
 * two kinds of collision follow, both seen in a real editor:
 *
 * - **Our selectors hit their markup.** VS Code puts `class="code-line"` on every
 *   block element for scroll sync — `table`, `tr`, `td` included — and every
 *   theme has `.code-line { display: inline-block; width: 100% }` for the line
 *   spans it writes inside code blocks. Every table cell became a full-width
 *   block.
 * - **Their selectors hit our markup.** The GitHub-styles extension scopes its
 *   CSS to `.github-markdown-body` — the class the export's wrapper uses — with
 *   dark-mode colour variables, so its `.github-markdown-body table tr` rules
 *   outranked the theme's plain `table` rules and every row turned black.
 *
 * So every rule is scoped under one id, `#pme-preview`, which the preview
 * wrapper carries and nothing else does:
 *
 * - `html`, `body` and `:root` become the wrapper itself (`body.html-export` too:
 *   a preview is a screen, which is what that class selects);
 * - `.github-markdown-body` / `.markdown-body` / `.github-markdown-content` become
 *   `.pme-body` / `.pme-content`, classes no other extension targets;
 * - a selector that starts with `.code-line` is confined to `pre`, the only place
 *   the export writes that class;
 * - every other selector gets `#pme-preview ` in front.
 *
 * The id outranks any class-only rule from another extension for every property
 * the theme sets. For the properties it does *not* set — a `display: block` on
 * tables, a background on odd rows — {@link PREVIEW_RESET_CSS} reverts whatever
 * another extension applied inside the wrapper, before the theme's own rules.
 *
 * `@page` rules are dropped (there are no pages), dark `prefers-color-scheme`
 * blocks are dropped and light ones unwrapped (the preview is paper, whatever
 * the editor theme), and every `@import` is lifted out so the caller can put it
 * first, where CSS honours it.
 */

/** The id on the preview wrapper — must match `PREVIEW_OPEN` in preview-plugin.ts. */
export const PREVIEW_SCOPE = '#pme-preview';

/**
 * Undoes other extensions' styles inside the wrapper; the theme then applies its own.
 *
 * `all: revert` rolls each property back to the browser default, so inherited
 * ones (font, colour) come from the wrapper, which the theme styles. It sits at
 * the id's specificity with no class, so any scoped theme rule for the same
 * element wins, and it goes first, so a tie does too.
 *
 * Diagrams and maths are left alone: SVG output (Mermaid, PlantUML) carries its
 * own styling, and KaTeX is laid out entirely by its stylesheet — reverting
 * either takes it apart, and the theme has nothing to replace it with.
 */
export const PREVIEW_RESET_CSS =
    `${PREVIEW_SCOPE} :where(:not(svg, svg *, math, math *, .katex, .katex *, .mermaid, .mermaid *)) { all: revert; }`;

/** A rewritten stylesheet: its `@import`s, and everything else. */
export interface ScopedCss {
    imports: string[];
    rules: string;
}

/** Removes comments, leaving strings intact (a comment can hold a brace, and so can a string). */
function stripComments(css: string): string {
    let out = '';
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '"' || c === "'") {
            const end = skipString(css, i);
            out += css.slice(i, end);
            i = end - 1;
        } else if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end < 0 ? css.length : end + 1;
        } else {
            out += c;
        }
    }
    return out;
}

/** Index just past the string starting at `start`. */
function skipString(css: string, start: number): number {
    const quote = css[start];
    for (let i = start + 1; i < css.length; i++) {
        if (css[i] === '\\') { i++; continue; }
        if (css[i] === quote) return i + 1;
    }
    return css.length;
}

/** Index of the `}` closing the block whose `{` is at `open`, strings respected. */
function matchBrace(css: string, open: number): number {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        const c = css[i];
        if (c === '"' || c === "'") { i = skipString(css, i) - 1; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    return css.length;
}

/** Splits a selector list on top-level commas — not those inside `:is(a, b)` or `[x="a,b"]`. */
export function splitSelectors(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === '"' || c === "'") { i = skipString(list, i) - 1; continue; }
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === ',' && depth === 0) {
            parts.push(list.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(list.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

/** One selector, scoped under {@link PREVIEW_SCOPE}. */
export function scopeSelector(selector: string): string {
    let s = selector.trim()
        .replace(/\.github-markdown-body(?![\w-])/g, '.pme-body')
        .replace(/\.markdown-body(?![\w-])/g, '.pme-body')
        .replace(/\.github-markdown-content(?![\w-])/g, '.pme-content');

    // `html body …` / `html > body …` — the page root and the body are one element here.
    s = s.replace(/^(?:html|:root)\s*>?\s*(?=body(?![\w-]))/, '');

    const root = /^(?:html|body|:root)(?![\w-])((?:[.#:[][^\s>+~]*)?)/.exec(s);
    if (root) {
        const qualifiers = root[1].replace(/\.html-export(?![\w-])/g, '');
        return `${PREVIEW_SCOPE}${qualifiers}${s.slice(root[0].length)}`;
    }
    if (/^\.code-line(?![\w-])/.test(s)) return `${PREVIEW_SCOPE} pre ${s}`;
    return `${PREVIEW_SCOPE} ${s}`;
}

/** At-rules whose block holds declarations or keyframes, not selectors — kept as written. */
const OPAQUE_AT_RULES = /^@(?:-[a-z]+-)?(?:font-face|keyframes|property|counter-style|font-feature-values|font-palette-values|view-transition)\b/i;

/** Scopes every rule in `css`; see the module comment for what changes. */
export function scopeForPreview(css: string): ScopedCss {
    const imports: string[] = [];
    const rules = scopeBlock(stripComments(css), imports);
    return { imports, rules };
}

function scopeBlock(css: string, imports: string[]): string {
    const out: string[] = [];
    let i = 0;
    while (i < css.length) {
        while (i < css.length && /\s|;/.test(css[i])) i++;
        if (i >= css.length) break;

        // Everything up to the next `{` or `;` at this level is a prelude.
        let j = i;
        while (j < css.length && css[j] !== '{' && css[j] !== ';') {
            if (css[j] === '"' || css[j] === "'") { j = skipString(css, j); continue; }
            if (css[j] === '(') { j = css.indexOf(')', j) + 1 || css.length; continue; }
            j++;
        }
        const prelude = css.slice(i, j).trim();

        if (j >= css.length || css[j] === ';') {
            // A statement at-rule (`@import`, `@charset`, `@layer a, b;`) or stray text.
            if (/^@import\b/i.test(prelude)) imports.push(`${prelude};`);
            else if (/^@(?:layer|namespace)\b/i.test(prelude)) out.push(`${prelude};`);
            i = j + 1;
            continue;
        }

        const close = matchBrace(css, j);
        const body = css.slice(j + 1, close);
        i = close + 1;

        if (prelude.startsWith('@')) {
            if (/^@page\b/i.test(prelude)) continue;
            if (OPAQUE_AT_RULES.test(prelude)) { out.push(`${prelude} {${body}}`); continue; }
            if (/^@media\b/i.test(prelude)) {
                if (/prefers-color-scheme\s*:\s*dark/i.test(prelude)) continue;
                if (/^@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)$/i.test(prelude)) {
                    out.push(scopeBlock(body, imports));
                    continue;
                }
            }
            // @media, @supports, @container, @layer, @document — rules inside.
            out.push(`${prelude} {\n${scopeBlock(body, imports)}\n}`);
            continue;
        }

        const selectors = splitSelectors(prelude).map(scopeSelector);
        if (selectors.length) out.push(`${selectors.join(',\n')} {${body}}`);
    }
    return out.join('\n');
}
