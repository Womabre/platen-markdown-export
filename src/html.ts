import * as fs from 'fs';
import { ALERT_COLORS } from './config';
import { log } from './logger';
import { escHtml } from './frontmatter';
import { literal } from './strings';
import { readableTextOn } from './color';
import type { Classification } from './types';

// ── HTML template loader ──────────────────────────────────────────────────────

export function loadHtmlTemplate(filePath: string, tokens: Record<string, string> = {}): string {
    if (!fs.existsSync(filePath))
        throw new Error(`HTML template not found: ${filePath}`);

    let html = fs.readFileSync(filePath, 'utf8');

    // Strip HTML comments first — but keep {{token}} placeholder comments
    // (e.g. <!--{{REVISION_ROWS}}-->). This prevents prose that mentions a
    // literal "<body>"/"</body>" inside a comment from fooling the body
    // extraction below.
    html = html.replace(/<!--(?!\s*\{\{)[\s\S]*?-->/g, '');

    // Extract content between <body> tags (strips the standalone page shell)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (!bodyMatch)
        throw new Error(`No <body> element found in template: ${filePath}`);

    html = bodyMatch[1];

    // Strip <script> blocks (preview-only; not needed in exported PDF)
    html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');

    // Strip <template> elements (used by preview scripts as data holders)
    html = html.replace(/<template\b[\s\S]*?<\/template>/gi, '');

    // Handle comment-wrapped tokens first (valid placement inside <tbody> etc.)
    html = html.replace(/<!--\{\{(\w+)\}\}-->/g, (_, key) => tokens[key] ?? '');

    for (const [token, value] of Object.entries(tokens))
        html = html.replaceAll(`{{${token}}}`, literal(value));

    return html.trim();
}

// ── Document metadata ─────────────────────────────────────────────────────────

/**
 * Puts the document's own title and author into `<head>`.
 *
 * Nothing emitted either, so the exported PDF had no `/Title` and no `/Author`
 * at all — WeasyPrint fell back to the first `<h1>` it found. That is right only
 * by coincidence: the cover template's `<h1>` happens to hold the title, so a
 * cover page made the metadata look correct, and `Cover Page: false` silently
 * turned `/Title` into whatever the body's first heading said ("Introduction").
 * `Author:` was in the frontmatter the whole time and never reached the file.
 *
 * It is worth more than tidiness here. `/Title` is what a PDF reader shows in
 * its window and its Document Properties, what a DMS or SharePoint indexes on,
 * and what PDF/UA requires a tagged document to carry — and this tool exists to
 * produce exactly that kind of controlled deliverable. The standalone HTML
 * export gets the same `<title>`, so a browser tab stops showing the filename.
 *
 * Only ever ADDS: an `.html` input that already declares its own title or author
 * keeps them, since that document said something deliberate and the frontmatter
 * may only be a sibling `.md` guess. Absent values add nothing rather than an
 * empty tag, which leaves WeasyPrint's heading fallback in place for a document
 * that genuinely has no title.
 */
export function injectDocumentMetadata(
    html: string,
    meta: { title?: string | null; author?: string | null },
): string {
    const additions: string[] = [];

    if (meta.title && !/<title[\s>]/i.test(html))
        additions.push(`<title>${escHtml(meta.title)}</title>`);

    if (meta.author && !/<meta[^>]+\bname=["']?author["'\s>]/i.test(html))
        additions.push(`<meta name="author" content="${escHtml(meta.author)}">`);

    if (additions.length === 0) return html;

    // A function replacement, so a `$&` in a title cannot expand against the match.
    const withMeta = html.replace(/<head[^>]*>/i, m => `${m}\n${additions.join('\n')}`);
    if (withMeta === html) log('WARNING: Document has no <head> — title and author metadata not set');
    return withMeta;
}

// ── TOC wrapper injection ─────────────────────────────────────────────────────

export function injectTocWrapper(htmlContent: string): string {
    const TOC_HEADING_RE = /<h[1-6][^>]*>(?:table\s+of\s+contents|contents|inhoudsopgave)<\/h[1-6]>/i;
    const headingMatch   = TOC_HEADING_RE.exec(htmlContent);
    const searchFrom     = headingMatch ? headingMatch.index + headingMatch[0].length : 0;

    const ulStart = htmlContent.indexOf('<ul', searchFrom);
    if (ulStart === -1) return htmlContent;

    const outerUl = extractOuterUl(htmlContent, ulStart);
    if (!outerUl) return htmlContent;

    const ulContent  = htmlContent.slice(outerUl.start, outerUl.end);
    const allAnchors = [...ulContent.matchAll(/<a\s+href="([^"]+)"/g)];

    if (allAnchors.length === 0 || !allAnchors.every(m => m[1].startsWith('#'))) {
        log('WARNING: Could not detect TOC — skipping wrapper injection');
        return htmlContent;
    }

    log(`TOC detected and wrapped${headingMatch ? ' (via heading)' : ' (via anchor heuristic)'}`);
    return (
        htmlContent.slice(0, outerUl.start) +
        `<nav class="toc">${ulContent}</nav>` +
        htmlContent.slice(outerUl.end)
    );
}

function extractOuterUl(html: string, startIndex: number): { start: number; end: number } | null {
    let depth = 0;
    let i     = startIndex;

    while (i < html.length) {
        const open  = html.indexOf('<ul', i);
        const close = html.indexOf('</ul>', i);

        if (open === -1 && close === -1) break;

        if (open !== -1 && (close === -1 || open < close)) {
            depth++;
            i = open + 3;
        } else {
            depth--;
            i = close + 5;
            if (depth === 0) return { start: startIndex, end: i };
        }
    }
    return null;
}

// ── TOC rebuild from headings ─────────────────────────────────────────────────

// Labels for headings that introduce the TOC section itself — these should not
// appear as entries in the rebuilt TOC.
const TOC_LABEL_RE = /^(?:table\s+of\s+contents|contents|toc|inhoud|inhoudsopgave|inhaltsverzeichnis|table\s+des\s+mati[eè]res|sommaire|[íi]ndice)$/i;

interface TocNode {
    id: string;
    text: string;
    children: TocNode[];
}

/**
 * Groups a flat heading list into a tree by nesting depth, without assuming
 * the first heading sits at the document's shallowest level — a heading can
 * be dropped from the array (e.g. the title) leaving a deeper one first, and
 * that heading must still surface as a top-level sibling rather than vanish.
 */
function buildTocTree(headings: Array<{ level: number; id: string; text: string }>): TocNode[] {
    const root: TocNode[] = [];
    const stack: Array<{ level: number; children: TocNode[] }> = [{ level: -Infinity, children: root }];

    for (const h of headings) {
        while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
            stack.pop();
        }
        const node: TocNode = { id: h.id, text: h.text, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push({ level: h.level, children: node.children });
    }

    return root;
}

function renderTocTree(nodes: TocNode[]): string {
    if (nodes.length === 0) return '';
    const items = nodes.map(n => {
        const childHtml = renderTocTree(n.children);
        return `<li><a href="#${n.id}">${n.text}</a>${childHtml ? `\n${childHtml}` : ''}</li>`;
    });
    return `<ul>\n${items.join('\n')}\n</ul>`;
}

function buildNestedTocHtml(headings: Array<{ level: number; id: string; text: string }>): string {
    if (headings.length === 0) return '<ul></ul>';
    return renderTocTree(buildTocTree(headings));
}

/**
 * Rebuilds the `<nav class="toc">` from all `<h1>–<h6 id="...">` elements in
 * the HTML. Called after includes have been merged so that headings from
 * included files appear in the TOC alongside those from the main document.
 * No-ops when there is no TOC nav in the document.
 */
export function rebuildToc(htmlContent: string, maxDepth: number | null = null): string {
    if (!htmlContent.includes('<nav class="toc">')) return htmlContent;

    const headingRe = /<h([1-6])[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
    const headings: Array<{ level: number; id: string; text: string }> = [];
    let m: RegExpExecArray | null;
    let sawFirstHeading = false;

    while ((m = headingRe.exec(htmlContent)) !== null) {
        const level = parseInt(m[1]);

        // The document's very first heading is its title (mirroring the
        // frontmatter Title, already shown on the cover) — never list it.
        if (!sawFirstHeading) {
            sawFirstHeading = true;
            if (level === 1) continue;
        }

        // `TOC Depth` is an absolute heading level: 3 lists down to <h3>.
        if (maxDepth !== null && level > maxDepth) continue;

        const text = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (TOC_LABEL_RE.test(text)) continue;
        headings.push({ level, id: m[2], text });
    }

    if (headings.length === 0) return htmlContent;

    const newUl = buildNestedTocHtml(headings);
    log(`TOC rebuilt: ${headings.length} heading(s)`);

    return htmlContent.replace(
        /<nav class="toc">[\s\S]*?<\/nav>/,
        `<nav class="toc">\n${newUl}\n</nav>`,
    );
}

// ── Heading auto-numbering ────────────────────────────────────────────────────

/**
 * Prefixes `<h2>`–`<h6>` with a hierarchical number (`1.`, `1.2`, `1.2.3`).
 *
 * `<h1>` is deliberately not numbered: in these documents it is the title, and
 * body `<h1>`s (as in the sample docs' typography section) are display headings
 * rather than numbered sections — so `##` is section 1, `###` is 1.1, and so on.
 *
 * Runs BEFORE `rebuildToc`, which reads heading text with tags stripped — so the
 * numbers flow into the TOC automatically and can never drift out of sync with
 * the body. The skip rules land in the same place as `rebuildToc`'s, by different
 * means: the leading title `<h1>` and the glossary's id-less headings are excluded
 * by the regex itself, leaving only the "Contents" heading to test for.
 */
export function numberHeadings(htmlContent: string): string {
    const counters = [0, 0, 0, 0, 0]; // h2…h6

    return htmlContent.replace(
        /<h([2-6])([^>]*\bid="[^"]*"[^>]*)>([\s\S]*?)<\/h\1>/g,
        (match, levelStr: string, attrs: string, inner: string) => {
            const level = parseInt(levelStr, 10);

            const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (TOC_LABEL_RE.test(text)) return match;

            const idx = level - 2;
            counters[idx]++;
            for (let i = idx + 1; i < counters.length; i++) counters[i] = 0;

            const number = counters.slice(0, idx + 1).join('.');
            // The space sits OUTSIDE the span deliberately: the TOC rebuild and
            // the running-header `string-set` both read heading text with tags
            // stripped, and a CSS margin would vanish there — leaving "1Alpha
            // Section". A real space survives both.
            return `<h${level}${attrs}><span class="heading-number">${number}</span> ${inner}</h${level}>`;
        },
    );
}

// ── List of Tables / List of Figures ──────────────────────────────────────────

/**
 * Builds a `<nav class="caption-index">` listing every auto-numbered caption of
 * one kind, styled like the TOC (leader dots + `target-counter` page numbers).
 * Returns an empty string when the document has no captions of that kind, so an
 * enabled-but-unused switch adds nothing rather than an empty heading.
 */
export function buildCaptionIndex(
    htmlContent: string,
    kind: 'table' | 'figure',
    heading: string,
): string {
    const entryRe = new RegExp(
        `<p class="caption caption-${kind}" id="(${kind}-\\d+)">([\\s\\S]*?)<\\/p>`,
        'g',
    );

    const items: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(htmlContent)) !== null) {
        const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        items.push(`<li><a href="#${m[1]}">${text}</a></li>`);
    }

    if (items.length === 0) return '';

    log(`${heading}: ${items.length} entr${items.length === 1 ? 'y' : 'ies'}`);
    return `<nav class="caption-index caption-index-${kind}">\n`
         + `<h2 class="caption-index-heading">${heading}</h2>\n`
         + `<ul>\n${items.join('\n')}\n</ul>\n</nav>`;
}

/** Inserts pre-built caption indexes directly after the TOC nav (no-op without one). */
export function injectCaptionIndexes(htmlContent: string, indexes: string[]): string {
    const blocks = indexes.filter(Boolean);
    if (blocks.length === 0) return htmlContent;
    if (!htmlContent.includes('<nav class="toc">')) return htmlContent;

    return htmlContent.replace(
        /(<nav class="toc">[\s\S]*?<\/nav>)/,
        `$1\n${blocks.join('\n')}`,
    );
}

// ── Page chrome: watermark + classification ───────────────────────────────────

/**
 * A diagonal watermark element. WeasyPrint repeats `position: fixed` boxes on
 * every page, so one element in the source stamps the whole document.
 */
export function buildWatermark(text: string): string {
    return `<div id="page-watermark" aria-hidden="true">${escHtml(text)}</div>`;
}

/** Shield tint per classification — the fill layer of the duotone glyph. */
const CLASSIFICATION_COLORS: Record<Classification, string> = {
    Public:       '#14a10f',
    Internal:     '#eaa300',
    Confidential: '#f7630a',
};

/**
 * The top-right classification label, emitted as a *running element* (see the
 * theme page.css `position: running(classification)`) so the page margin box can
 * pull in real markup — a `@page` `content:` string could not carry the icon.
 *
 * Uses Phosphor's `ph-duotone` weight, whose glyph is two stacked layers: the
 * `::before` silhouette takes the classification colour and the `::after` line
 * art is forced black by the theme CSS, giving a tinted shield with a black
 * outline. (`ph-solid` is not a Phosphor class at all — the weights are
 * regular/bold/fill/duotone/light/thin — and renders no glyph.)
 */
export function buildClassificationHeader(classification: Classification): string {
    const color = CLASSIFICATION_COLORS[classification];
    return `<div id="classification-header" class="classification-${classification.toLowerCase()}">`
         + `<i class="ph-duotone ph-shield" style="color: ${color};"></i> ${classification}</div>`;
}

/** Injects page-chrome elements immediately after `<body>` so they precede all content. */
export function injectPageChrome(htmlContent: string, elements: string[]): string {
    const blocks = elements.filter(Boolean);
    if (blocks.length === 0) return htmlContent;

    return htmlContent.replace(
        /<body([^>]*)>/,
        (_match: string, attrs: string) => `<body${attrs}>\n${blocks.join('\n')}`,
    );
}

// ── Task list checkbox rendering ──────────────────────────────────────────────
//
// markdown-it-task-lists emits <input type="checkbox" disabled> elements.
// WeasyPrint does not render form controls, so we replace them with inline SVGs
// before the HTML reaches WeasyPrint.

const CHECKED_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"',
    ' style="vertical-align:-3px;margin-right:5px;display:inline-block;flex-shrink:0">',
    '<rect width="15" height="15" rx="3" fill="#2563eb"/>',
    '<path d="M3 7.5L6.5 11L12 4.5" stroke="white" stroke-width="2"',
    ' stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    '</svg>',
].join('');

const UNCHECKED_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"',
    ' style="vertical-align:-3px;margin-right:5px;display:inline-block;flex-shrink:0">',
    '<rect x="1" y="1" width="13" height="13" rx="2.5" fill="none" stroke="#bbb" stroke-width="1.5"/>',
    '</svg>',
].join('');

/** CSS injected into <head> to style inline images inside headings (e.g. product icons). */
export const HEADING_ICON_CSS = `
/* ── Inline heading icons ──────────────────────────────── */
.github-markdown-body h1 img,
.github-markdown-body h2 img,
.github-markdown-body h3 img,
.github-markdown-body h4 img,
.github-markdown-body h5 img,
.github-markdown-body h6 img,
.github-markdown-body .icon,
.github-markdown-body .icon-small {
    height: 0.85em !important;
    width: auto !important;
    vertical-align: -0.2em !important;
    padding-right: 0.25em !important;
    display: inline !important;
    margin: 0 !important;
}`;

// ── Emoji ─────────────────────────────────────────────────────────────────────
//
// WeasyPrint places bare emoji by the emoji font's metrics, which lifts them off
// the text baseline by a font-dependent amount that CSS vertical-align can't
// reliably correct. Instead we replace emoji with inline Twemoji SVG images:
// images align by their own box (height 1em, fixed vertical-align), so they sit
// on the baseline consistently across every theme/font, and render identically
// regardless of the host's emoji font. The <img>s are inlined as data URIs by
// inlineImages() (run right after wrapEmoji), keeping the output self-contained.

/**
 * Twemoji release the emoji images are pulled from.
 *
 * Pinned, like the icon-font CDNs above it. `@latest` meant whatever jsDelivr
 * served that minute was baked into the PDF: emoji could change shape, or stop
 * resolving, between two exports of the same unchanged document and with no
 * release on our side — and the artifact is meant to be a fixed record. Bumping
 * is a one-line change with a visible diff, which is the point.
 *
 * To bump: pick a version from
 * `https://data.jsdelivr.com/v1/packages/gh/jdecked/twemoji` and check that
 * `<TWEMOJI_BASE>1f600.svg` still resolves.
 */
export const TWEMOJI_VERSION = '17.0.3';

export const TWEMOJI_BASE = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@${TWEMOJI_VERSION}/assets/svg/`;

// Matches emoji-presentation sequences only — a default-emoji base
// (\p{Emoji_Presentation}) or a pictograph forced to emoji with VS16 (️) —
// plus trailing skin-tone modifiers and ZWJ-joined pictographs. This excludes
// default-text characters (e.g. the footnote back-arrow ↩︎, U+21A9 U+FE0E),
// which must stay as text rather than become emoji images.
const EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F})(?:[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{200D}(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F}?))*/gu;

/** Maps an emoji to its Twemoji asset basename (codepoints, VS16 stripped unless ZWJ). */
function emojiCodePoints(emoji: string): string {
    const cps = Array.from(emoji).map(ch => ch.codePointAt(0)!.toString(16));
    // Twemoji keeps the U+FE0F variation selector only in ZWJ sequences.
    const keepVs = emoji.includes('‍');
    return (keepVs ? cps : cps.filter(cp => cp !== 'fe0f')).join('-');
}

/**
 * Replaces emoji with inline Twemoji `<img class="emoji">` so EMOJI_CSS can pin
 * them to the baseline. Processes only text between tags, leaving <pre>/<code>
 * blocks and tag attributes untouched. Run before inlineImages() so the images
 * get inlined as data URIs.
 */
export function wrapEmoji(htmlContent: string): string {
    return htmlContent.replace(/<(pre|code)\b[\s\S]*?<\/\1>|<[^>]+>|[^<]+/gi, (seg) =>
        seg.startsWith('<')
            ? seg
            : seg.replace(EMOJI_RE, m =>
                `<img class="emoji" alt="${m}" src="${TWEMOJI_BASE}${emojiCodePoints(m)}.svg">`),
    );
}

/** CSS injected into <head> to render emoji images inline on the text baseline. */
export const EMOJI_CSS = `
/* ── Emoji (inline Twemoji images) ─────────────────────── */
img.emoji {
    height: 1em !important;
    width: 1em !important;
    margin: 0 0.05em !important;
    vertical-align: -0.125em !important;
    display: inline !important;
    max-height: none !important;
    background: none !important;
}`;

/** CSS injected into <head> when the document contains task list items. */
export const TASK_LIST_CSS = `
/* ── Task list checkboxes ──────────────────────────────── */
ul.contains-task-list {
    padding-left: 0.5em;
}
ul.contains-task-list li.task-list-item {
    list-style: none;
    padding: 0.2em 0;
}`;

/**
 * CSS injected into <head>, theme-independent, so a table too wide for the
 * page fits without ever splitting a word.
 *
 * Words are never broken in a table: cells wrap at word boundaries only, and
 * hyphenation is off. A broken word in a data cell reads as a typo — the point
 * of a table is that its values stay legible.
 *
 * That leaves the problem the previous `overflow-wrap: anywhere` tier solved:
 * a many-column table's min-content width is the sum of its columns' longest
 * words, which for 10+ columns can exceed the page. Dense tables (tagged by
 * `markDenseTables` in markdown-extras.ts) therefore buy their width back from
 * type size and padding instead of from the words:
 *   - horizontal padding drops 13px → 5px, which across 12 columns alone
 *     reclaims roughly 190px of the sheet;
 *   - font-size drops to 0.8em, shrinking every column's longest word
 *     proportionally.
 * Both shrink min-content without touching a single word. A table dense enough
 * to still overflow after that wants a landscape page (`::: landscape`) or
 * fewer columns — not a hyphen in the middle of a value.
 */
export const TABLE_FIT_CSS = `
/* ── Table text: wrap at word boundaries, never mid-word ────────────── */
.github-markdown-body table th,
.github-markdown-body table td {
    overflow-wrap: normal;
    word-break: normal;
    word-wrap: normal;
    hyphens: none;
}
/* ── Dense tables: reclaim width from padding and type, not from words ── */
.github-markdown-body table.table-dense th,
.github-markdown-body table.table-dense td {
    padding: 5px 5px;
    font-size: 0.8em;
}`;

/**
 * Replaces `<input type="checkbox">` elements produced by markdown-it-task-lists
 * with inline SVG checkboxes that WeasyPrint can render.
 */
export function replaceTaskListInputs(html: string): string {
    return html.replace(
        /<input\b([^>]*)type="checkbox"([^>]*)>/gi,
        (_match, before: string, after: string) => {
            const isChecked = /\bchecked\b/i.test(before + after);
            return isChecked ? CHECKED_SVG : UNCHECKED_SVG;
        },
    );
}

// ── GitHub alert SVG icon color injection ─────────────────────────────────────

const ALERT_PATTERNS: Array<{ regex: RegExp; color: string }> = Object.entries(ALERT_COLORS)
    .map(([alertClass, color]) => ({
        regex: new RegExp(`(<div[^>]+${alertClass}[^>]*>[\\s\\S]*?</div>)`, 'g'),
        color,
    }));

export function inlineAlertIconColors(htmlContent: string): string {
    for (const { regex, color } of ALERT_PATTERNS) {
        htmlContent = htmlContent.replace(regex, (block: string) =>
            block.replace(/<path /g, `<path fill="${color}" `),
        );
    }
    return htmlContent;
}

// ── Hex color inline code backgrounds ────────────────────────────────────────
//
// Two cases:
//   Pure hex  — `#2563eb`  → the <code> element itself gets the hex background
//               (no grey overhang); text color chosen for WCAG contrast.
//   Mixed     — `text #904c9e more` → <code> keeps its grey background; only
//               the hex token gets a colored pill inside the code span.

const HEX_COLOR_RE    = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HEX_INLINE_RE   = /#[0-9a-fA-F]{3,8}/g;

function hexPill(hex: string, extraStyle = ''): string {
    const fg = readableTextOn(hex);
    return `<span style="background:${hex};color:${fg};border-radius:3px;padding:0.1em 0.35em${extraStyle}">${hex}</span>`;
}

export function inlineHexColorCode(htmlContent: string): string {
    // Protect <pre>…</pre> blocks so hex strings in code listings are untouched.
    const preserved: string[] = [];
    let pidx = 0;
    const ph = (n: number) => `\x02HEX_PRESERVED_${n}\x03`;

    let result = htmlContent.replace(
        /<pre[\s\S]*?<\/pre>/gi,
        (match) => { preserved.push(match); return ph(pidx++); },
    );

    result = result.replace(
        /(<code)((?:\s[^>]*)?)>([\s\S]*?)(<\/code>)/g,
        (match, tag, attrs, content, close) => {
            const trimmed = content.trim();

            // Pure hex — override the <code> background directly (no grey protrusion).
            if (HEX_COLOR_RE.test(trimmed)) {
                const fg = readableTextOn(trimmed);
                return `${tag}${attrs} style="background:${trimmed};color:${fg}">${content}${close}`;
            }

            // Mixed content — replace only the hex token(s) with colored pills.
            HEX_INLINE_RE.lastIndex = 0;
            if (!HEX_INLINE_RE.test(content)) return match;

            const newContent = content.replace(HEX_INLINE_RE, (hex: string) =>
                HEX_COLOR_RE.test(hex) ? hexPill(hex) : hex,
            );
            return `${tag}${attrs}>${newContent}${close}`;
        },
    );

    return result.replace(/\x02HEX_PRESERVED_(\d+)\x03/g, (_, n) => preserved[parseInt(n, 10)]);
}

// ── Admonition SVG icon color injection ───────────────────────────────────────
//
// Admonition icons use fill="currentColor" to inherit the heading text colour
// via CSS.  WeasyPrint does not resolve currentColor from CSS into SVG
// attributes, so icons render black.  We stamp the actual colour directly onto
// the SVG element — matching the colour values in the theme stylesheet.

const ADMONITION_ICON_COLORS: Record<string, string> = {
    'admonition-note':     '#1565c0',
    'admonition-abstract': '#006db3',
    'admonition-info':     '#006978',
    'admonition-tip':      '#007a6e',
    'admonition-success':  '#007325',
    'admonition-question': '#33691e',
    'admonition-warning':  '#b36200',
    'admonition-failure':  '#b71c1c',
    'admonition-danger':   '#c0002f',
    'admonition-bug':      '#880037',
    'admonition-example':  '#4527a0',
    'admonition-quote':    '#424242',
};

export function inlineAdmonitionIconColors(htmlContent: string): string {
    for (const [cls, color] of Object.entries(ADMONITION_ICON_COLORS)) {
        // Match from the outer admonition div through the end of its heading div.
        // The heading div never contains nested divs, so the first </div> after
        // <div class="admonition-heading"> is unambiguously the heading close tag.
        htmlContent = htmlContent.replace(
            new RegExp(
                `(<div[^>]+\\b${cls}\\b[^>]*>[\\s\\S]*?<div class="admonition-heading">[\\s\\S]*?</div>)`,
                'g',
            ),
            (match: string) => match.replace(/\bfill="currentColor"/, `fill="${color}"`),
        );
    }
    return htmlContent;
}

// ── Body class marking ────────────────────────────────────────────────────────

/**
 * Prepends class names to the document's `<body>`, whether or not it already
 * carries a `class` attribute.
 *
 * Both pipelines mark the body — the HTML export with `html-export`, which the
 * banner and page-layout CSS scope to (`body.html-export .github-markdown-body`
 * in cover.ts), and both with `code-line-numbers`. Each used to do it inline,
 * and the HTML export's version matched only `<body …class="…`: a body with no
 * class attribute was left unmarked and the entire html-export layout silently
 * did not apply. Markdown-derived HTML always has `class="vscode-body …"`, so
 * this only ever bit an `.html` input written by hand — which is a supported
 * input, and the failure was invisible in the output.
 *
 * Classes are prepended rather than appended purely to keep the existing byte
 * order of the golden HTML export; class order has no meaning in CSS.
 */
export function addBodyClasses(html: string, classes: Array<string | false | null | undefined>): string {
    const wanted = classes.filter((c): c is string => Boolean(c));
    if (wanted.length === 0) return html;
    const prefix = wanted.join(' ');

    // Existing class attribute — either quote style, since a hand-written
    // document may use single quotes where the generated HTML never does.
    const withClass = html.replace(
        /<body([^>]*?)\sclass=(["'])/i,
        (_m, attrs: string, quote: string) => `<body${attrs} class=${quote}${prefix} `,
    );
    if (withClass !== html) return withClass;

    return html.replace(
        /<body\b([^>]*)>/i,
        (_m, attrs: string) => `<body${attrs} class="${prefix}">`,
    );
}
