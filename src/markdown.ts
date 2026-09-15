import * as fs from 'fs';
import * as path from 'path';
import frontMatter from 'front-matter';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import attrs from 'markdown-it-attrs';
import katex from '@traptitech/markdown-it-katex';
import container from 'markdown-it-container';
import footnote from 'markdown-it-footnote';
import abbr from 'markdown-it-abbr';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import deflist from 'markdown-it-deflist';
import ins from 'markdown-it-ins';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskLists = require('markdown-it-task-lists') as (md: MarkdownIt.MarkdownIt) => void;
import hljs from 'highlight.js';
import { log } from './logger';
import { writeFileAtomic } from './fsutil';
import { mermaidPlaceholder } from './mermaid';
import { graphvizPlaceholder } from './graphviz';
import { infographicPlaceholder } from './infographic';
import { escHtml, extractFrontmatter, stampRevisionDate, resolveRevision, CONCURRENT_EXPORT_HINT } from './frontmatter';
import type { FrontmatterData } from './types';
import {
    containerConfig,
    mkdocsAdmonitions,
    registerAdmonitionRenderers,
} from './admonitions';
import {
    splitLangSpec,
    extractHighlightLines,
    wrapCodeLines,
    registerLayoutContainers,
    registerRedlineMarks,
    applyVariables,
} from './markdown-extras';

// ── CJS/ESM dual-module compatibility ────────────────────────────────────────
// Some packages (markdown-it-anchor, markdown-it-attrs, …) ship both CJS and
// ESM builds.  When bundled by the TypeScript compiler the default export may
// land on `.default` instead of the module root.  This helper normalises both.
// Same regex markdown-it's own `replacements` core rule uses to short-circuit
// blocks that contain none of these sequences (dashes, ellipsis, `+-`, etc.).
const RARE_TYPOGRAPHIC_RE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/;

/**
 * Reimplementation of markdown-it's built-in `replacements` core rule, minus
 * the `(c)`/`(r)`/`(tm)` → ©/®/™ half. Swapped in via `md.core.ruler.at()`
 * when `Trademark Symbols` frontmatter isn't opted in, so dashes/ellipsis
 * typography and smart quotes keep working but "(R)" written as a literal
 * parenthetical (e.g. a revision marker, not a trademark) survives untouched.
 */
function replaceRareTypography(state: MarkdownIt.StateCore): void {
    if (!state.md.options.typographer) return;

    for (let blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
        const token = state.tokens[blkIdx];
        if (token.type !== 'inline' || !token.children) continue;
        if (!RARE_TYPOGRAPHIC_RE.test(token.content)) continue;

        let insideAutolink = 0;
        for (let i = token.children.length - 1; i >= 0; i--) {
            const child = token.children[i];
            if (child.type === 'text' && !insideAutolink && RARE_TYPOGRAPHIC_RE.test(child.content)) {
                child.content = child.content
                    .replace(/\+-/g, '±')
                    .replace(/\.{2,}/g, '…').replace(/([?!])…/g, '$1..')
                    .replace(/([?!]){4,}/g, '$1$1$1').replace(/,{2,}/g, ',')
                    .replace(/(^|[^-])---(?=[^-]|$)/mg, '$1—')
                    .replace(/(^|\s)--(?=\s|$)/mg, '$1–')
                    .replace(/(^|[^-\s])--(?=[^-\s]|$)/mg, '$1–');
            }
            if (child.type === 'link_open' && child.info === 'auto') insideAutolink--;
            if (child.type === 'link_close' && child.info === 'auto') insideAutolink++;
        }
    }
}

function compat<T>(m: T & { default?: T }): T {
    return m.default ?? m;
}

// ── Markdown include helpers ──────────────────────────────────────────────────

/**
 * Appends ` (Rev. X)` to the first Markdown heading in `body`, inserting it
 * before any trailing inline annotations such as `{.class}` or
 * `<!-- omit from toc -->` so those keep working correctly.
 */
function appendRevisionToFirstHeading(body: string, revision: string): string {
    return body.replace(
        /^(#{1,6} )(.*?)(\s*(?:(?:\{[^}]*\}|<!--[^>]*-->)\s*)*)$/m,
        (_, hashes, text, trailing) => `${hashes}${text} (Rev. ${revision})${trailing}`,
    );
}

// ── Markdown include resolution ───────────────────────────────────────────────

/**
 * Removes the first TOC block found in a markdown body — a contiguous list
 * where every item with a link uses a hash anchor (#section). Also removes an
 * immediately preceding heading (e.g. "## Table of Contents") if present.
 *
 * Used to strip the TOC from included files before merging them into the
 * main document, since the main TOC is rebuilt from all headings after render.
 */
export function stripMarkdownToc(body: string): string {
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
        if (!/^[ \t]*[-*+] /.test(lines[i])) continue;
        if (!/\[.*?\]\(#/.test(lines[i])) continue;

        // Collect all consecutive list lines starting here
        const blockStart = i;
        let j = i;
        while (j < lines.length && /^[ \t]*[-*+] /.test(lines[j])) j++;

        const block = lines.slice(blockStart, j);
        const linkLines = block.filter(l => /\[.*?\]\(/.test(l));
        const allHashAnchors = linkLines.length >= 2 && linkLines.every(l => /\[.*?\]\(#/.test(l));
        if (!allHashAnchors) continue;

        // Also remove an optional preceding heading (skip back over blank lines)
        let removeFrom = blockStart;
        for (let k = blockStart - 1; k >= Math.max(0, blockStart - 3); k--) {
            if (lines[k].trim() === '') continue;
            if (/^#{1,6}\s/.test(lines[k])) removeFrom = k;
            break;
        }

        lines.splice(removeFrom, j - removeFrom);
        log(`Stripped TOC from included file (${j - removeFrom} lines removed)`);
        return lines.join('\n');
    }

    return body;
}

/**
 * Rewrites relative markdown image paths `![alt](rel/path.png)` to absolute
 * paths anchored at `fromDir`. Leaves URLs and already-absolute paths alone.
 * Applied to included content so that image paths survive being transplanted
 * into a document in a different directory.
 */
export function rewriteRelativeImagePaths(body: string, fromDir: string): string {
    return body.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_match, alt: string, spec: string) => {
            const titleMatch = spec.match(/^(.+?)\s+["']([^"']*)["']$/);
            const rawSrc = (titleMatch ? titleMatch[1] : spec).trim();
            const title  = titleMatch ? ` "${titleMatch[2]}"` : '';

            if (/^(https?:|data:|\/)/i.test(rawSrc)) return _match;

            // Wrap in angle brackets so spaces and special chars in the absolute
            // path don't break the markdown image link parser.
            return `![${alt}](<${path.resolve(fromDir, rawSrc)}>${title})`;
        },
    );
}

/**
 * Replaces `[!include](path/to/file.md)` directives with the content of the
 * referenced file (frontmatter stripped). Recurses into included files and
 * guards against circular references.
 *
 * Relative image paths in included content are rewritten to absolute paths so
 * that they resolve correctly when the merged document is rendered from its own
 * directory.
 *
 * The directive must appear on its own line. Paths are resolved relative to
 * the directory of the file that contains the directive.
 *
 * A markdown link title overrides the syntax-highlighting language, for files
 * whose extension does not identify their content — `Main.config` is really
 * XML, `.rc` might be INI:
 *
 *     [!include](Main.config "xml")
 *     [!include](Main.config#L5-L40 "xml")
 *
 * Because an explicit language only makes sense for a code block, giving one
 * also FORCES code-block treatment — which is how a `.md` file can be quoted
 * as source rather than spliced in as markdown.
 */
/**
 * How deep `[!include]` may nest.
 *
 * The cycle guard alone does not bound the work. `visited` is copied per branch
 * on purpose, so a diamond — two files that both include a third — expands both
 * legitimately rather than dropping one as "already seen". The cost is that a
 * file including two children which each include two grandchildren doubles per
 * level, so a deep chain assembled by accident (or a document generated by a
 * script) can expand exponentially with no cycle anywhere in it. A depth cap is
 * what makes that terminate. Sixteen is far past any real document: the deepest
 * thing anyone hand-writes is a book including parts including chapters.
 */
const MAX_INCLUDE_DEPTH = 16;

/**
 * @param deps Optional accumulator for every file actually read. `--watch` uses
 *             it to watch the documents an export depends on, not just the one
 *             it was pointed at.
 */
export function resolveIncludes(
    body: string,
    baseDir: string,
    visited = new Set<string>(),
    depth = 0,
    deps?: Set<string>,
): string {
    if (depth >= MAX_INCLUDE_DEPTH) {
        log(`WARNING: Include nesting deeper than ${MAX_INCLUDE_DEPTH} levels — not expanding further`);
        return body;
    }
    return body.replace(
        /^[ \t]*\[!include\]\(([^)#"']+?)(#L\d+(?:-L?\d+)?)?(?:[ \t]+["']([^"']*)["'])?\)[ \t]*$/gim,
        (_match, filePath: string, fragment: string | undefined, langOverride: string | undefined) => {
            const absPath = path.resolve(baseDir, filePath.trim());
            const range   = parseLineRange(fragment);
            const lang    = langOverride?.trim() || null;

            if (fragment && !range) {
                log(`WARNING: Malformed line range "${fragment}", including whole file: ${absPath}`);
            }
            if (!fs.existsSync(absPath)) {
                log(`WARNING: Include file not found, skipping: ${absPath}`);
                return _match;
            }

            // Only markdown is spliced as markdown (and so can recurse and
            // circularly reference). Any other extension — or an explicit
            // language override — is quoted as a fenced code block, which is
            // inert and so needs no cycle guard.
            deps?.add(absPath);

            if (lang || path.extname(absPath).toLowerCase() !== '.md') {
                return includeAsCodeBlock(absPath, range, lang);
            }

            if (visited.has(absPath)) {
                log(`WARNING: Circular include detected, skipping: ${absPath}`);
                return '';
            }
            log(`Including: ${absPath}${range ? ` (lines ${range.from}–${range.to})` : ''}`);
            const raw = fs.readFileSync(absPath, 'utf8');
            const { body: includedBody, attributes } = frontMatter(raw);
            const revision = resolveRevision(attributes);
            const childDir = path.dirname(absPath);
            const childVisited = new Set(visited);
            childVisited.add(absPath);

            // A line-ranged markdown include is an excerpt, not a whole
            // document: no TOC stripping, no revision heading, no page break —
            // it is meant to drop into the surrounding prose.
            if (range) {
                const excerpt = sliceLines(includedBody, range);
                return rewriteRelativeImagePaths(
                    resolveIncludes(excerpt, childDir, childVisited, depth + 1, deps), childDir);
            }

            let resolved = resolveIncludes(stripMarkdownToc(includedBody), childDir, childVisited, depth + 1, deps);
            if (revision) {
                log(`  Appending Rev. ${revision} to first heading of included file`);
                resolved = appendRevisionToFirstHeading(resolved, revision);
            }
            return `<div style="page-break-before: always;"></div>\n\n${rewriteRelativeImagePaths(resolved, childDir)}`;
        },
    );
}

interface LineRange { from: number; to: number }

/** Parses a `#L10` / `#L10-L25` / `#L10-25` fragment into 1-indexed inclusive bounds. */
export function parseLineRange(fragment: string | undefined): LineRange | null {
    if (!fragment) return null;
    const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(fragment);
    if (!m) return null;
    const from = parseInt(m[1], 10);
    const to   = m[2] ? parseInt(m[2], 10) : from;
    if (from < 1 || to < from) return null;
    return { from, to };
}

/** Extracts an inclusive 1-indexed line range, clamped to the available lines. */
export function sliceLines(text: string, range: LineRange): string {
    return text.split('\n').slice(range.from - 1, range.to).join('\n');
}

/** Maps a file extension to a highlight.js language name. */
function languageForExtension(ext: string): string {
    const map: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
        '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
        '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
        '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
        '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
        '.ps1': 'powershell', '.psm1': 'powershell',
        '.sql': 'sql', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
        '.toml': 'toml', '.ini': 'ini', '.xml': 'xml', '.html': 'html',
        '.css': 'css', '.scss': 'scss', '.vb': 'vbnet', '.lua': 'lua', '.php': 'php',
    };
    return map[ext] ?? ext.replace(/^\./, '');
}

/**
 * Quotes a file as a fenced code block, so live source can be pulled into a
 * document instead of pasted (and left to rot). The fence is chosen longer than
 * any backtick run inside the file so content containing its own fences cannot
 * terminate it early.
 *
 * `langOverride` wins over the extension mapping — extensions are only a guess
 * at content (`.config` is usually XML, never a language of its own).
 */
function includeAsCodeBlock(absPath: string, range: LineRange | null, langOverride: string | null = null): string {
    const raw     = fs.readFileSync(absPath, 'utf8');
    const content = (range ? sliceLines(raw, range) : raw).replace(/\n+$/, '');
    const lang    = langOverride ?? languageForExtension(path.extname(absPath).toLowerCase());

    const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
    const fence      = '`'.repeat(Math.max(3, longestRun + 1));

    log(`Including as code: ${absPath}${range ? ` (lines ${range.from}–${range.to})` : ''}`
        + ` [${lang || 'plain'}${langOverride ? ', overridden' : ''}]`);
    return `${fence}${lang}\n${content}\n${fence}`;
}

// All keys from ADMONITION_ALIASES — every alias needs its own container rule.
const CONTAINER_TYPES = [
    // note
    'note',
    // abstract
    'abstract', 'summary', 'tldr',
    // info
    'info', 'todo',
    // tip
    'tip', 'hint', 'important',
    // success
    'success', 'check', 'done',
    // question
    'question', 'help', 'faq',
    // warning
    'warning', 'caution', 'attention',
    // failure
    'failure', 'fail', 'missing',
    // danger
    'danger', 'error',
    // bug
    'bug',
    // example
    'example',
    // quote
    'quote', 'cite',
] as const;

/**
 * Strips markdown-it-attrs attribute syntax from TOC link texts and their anchors.
 *
 * VS Code's Markdown All-in-One (and similar tools) auto-generate TOC entries that
 * include {.class} in both the link text and the slugified anchor, e.g.:
 *   [Migration Information {.page-break-before}](#migration-information-page-break-before)
 *
 * markdown-it-anchor generates the heading ID *after* markdown-it-attrs has already
 * stripped the attribute block, so the actual ID is just `migration-information`.
 * This function corrects both the display text and the anchor before rendering.
 */
export function cleanTocAttrs(body: string): string {
    return body.replace(
        /(\[[^\]]+?)\s*(\{[^}]+\})\s*\](\(#[^)]*\))/g,
        (_, textPart: string, attrsBlock: string, anchorPart: string) => {
            // Compute the slug suffix the attrs block added to the anchor.
            // e.g. "{.page-break-before}" → "-page-break-before"
            const suffix = '-' + attrsBlock
                .replace(/[{}]/g, '')           // strip braces
                .replace(/\./g, ' ')            // dot → space (class prefix)
                .replace(/#\S+/g, '')           // strip #id values
                .toLowerCase()
                .replace(/[^a-z0-9 -]/g, '')   // strip remaining special chars
                .trim()
                .replace(/\s+/g, '-');          // collapse spaces to hyphens

            const cleanAnchor = anchorPart.endsWith(suffix + ')')
                ? anchorPart.slice(0, -(suffix.length + 1)) + ')'
                : anchorPart;

            return `${textPart}]${cleanAnchor}`;
        },
    );
}

/** The edits an export wants to make to the principal's own source document. */
export interface PendingSourceUpdate {
    /** The updated content. The export is built from this, written or not. */
    content: string;
    /** The last `Revisions` entry got today's date. */
    dateStamped: boolean;
    /** markdown-it-attrs syntax was stripped from the source TOC links. */
    tocCleaned: boolean;
    /** Whether anything changed at all — `commit()` is a no-op when false. */
    changed: boolean;
    /**
     * Writes the update, once. Call as soon as an export has actually produced
     * an output file.
     *
     * @returns whether this call wrote — false if there was nothing to write, or
     *          if a previous call already did. Idempotent because more than one
     *          output can be produced in a run (`--mode pdf,html`) and each of
     *          them earns the stamp, but only the first should write or log it.
     */
    commit(): boolean;
}

/**
 * Computes every edit the export makes to the source document, without writing.
 *
 * Two edits, over one read of the file:
 *   - today's date stamped on the last `Revisions` entry ({@link stampRevisionDate});
 *   - markdown-it-attrs syntax stripped from auto-generated TOC links
 *     ({@link cleanTocAttrs}), so they are clickable in the .md itself and not
 *     only in the export.
 *
 * They are computed together because they are written together: two independent
 * read-modify-write passes over the same file would have the second clobber the
 * first. And they are deferred rather than applied because the file belongs to
 * the principal — an export that dies on a missing font has no business having
 * already stamped a new date, and a dry run (`Mode:` unset) has no business
 * touching the document at all. `commit()` is called after a successful export.
 *
 * Idempotent: running it against already-updated content reports no change.
 */
export function prepareSourceUpdates(mdFile: string): PendingSourceUpdate {
    const original = fs.readFileSync(mdFile, 'utf8');

    const dated   = stampRevisionDate(original);
    const cleaned = cleanTocAttrs(dated);

    const dateStamped = dated !== original;
    const tocCleaned  = cleaned !== dated;
    let   committed   = false;

    return {
        content: cleaned,
        dateStamped,
        tocCleaned,
        changed: cleaned !== original,
        commit: () => {
            if (committed || cleaned === original) return false;
            committed = true;

            // Compare-and-swap, not a blind write.
            //
            // Nothing serialises two exports of the same document, and there are
            // three ways to get them: `--watch` in one terminal and a manual run
            // in another, the VS Code extension exporting on save while a CLI
            // export is mid-flight, or simply two windows. Each computed its
            // stamp from the bytes it read at the start, so the one that finishes
            // second used to overwrite whatever the first had written — the
            // classic lost update, and the thing lost is the principal's own
            // document.
            //
            // Refusing is the whole fix. This write is a convenience (a date the
            // next export will stamp again anyway); the other process's write may
            // not be. Skipping costs a stamp, clobbering costs an edit.
            let current: string;
            try { current = fs.readFileSync(mdFile, 'utf8'); }
            catch { return false; }        // vanished mid-export; nothing to update
            if (current !== original) {
                log('WARNING: The source document changed during the export — ' +
                    'not writing the revision date, to avoid overwriting that change.\n' +
                    `${CONCURRENT_EXPORT_HINT}\n` +
                    '  The output is still correct; only this stamp was skipped, and the next ' +
                    'export writes it.');
                return false;
            }

            writeFileAtomic(mdFile, cleaned);
            return true;
        },
    };
}

/**
 * Renders a Markdown document to the HTML the pipelines start from.
 *
 * @param mdFile      The document, used for include resolution and messages.
 * @param source      Its content, when the caller already has it. `main()` does:
 *                    it reads the file to compute the deferred source edits, so
 *                    passing that content back means the document is read once
 *                    per run instead of three times (here, in
 *                    `prepareSourceUpdates`, and again in `extractFrontmatter`).
 *                    It also means the render sees exactly the bytes that will
 *                    be written to disk rather than the pre-stamp file.
 * @param frontmatter Its parsed frontmatter, likewise — `main()` has already
 *                    built it, and reparsing produced a second copy that could
 *                    in principle disagree with the one steering the export.
 */
export async function convertMarkdownToHtml(
    mdFile: string,
    source?: string,
    frontmatter?: FrontmatterData,
    deps?: Set<string>,
): Promise<string> {
    const raw = source ?? fs.readFileSync(mdFile, 'utf8');
    const { body: rawBody } = frontMatter(raw);
    const fm = frontmatter ?? extractFrontmatter(mdFile, raw);
    // `extractFrontmatter` already applies the `Lang` key's default.
    const lang = fm.lang;

    // Includes are resolved first so variable substitution reaches included
    // files too.
    let body = resolveIncludes(rawBody, path.dirname(mdFile), new Set(), 0, deps);
    if (Object.keys(fm.variables).length) body = applyVariables(body, fm.variables);

    // These two ship ESM-only (no CJS build) in their current majors. A plain
    // `import` would down-level to `require()` under our CommonJS output and
    // throw ERR_REQUIRE_ESM on Node < 22; a real dynamic `import()` — which
    // `moduleResolution: nodenext` in tsconfig.json preserves instead of also
    // down-leveling — works on every supported Node version.
    const { default: GithubSlugger } = await import('github-slugger');
    const { default: alerts } = await import('markdown-it-github-alerts');

    const slugger = new GithubSlugger();

    const md = new MarkdownIt({
        html:        true,
        linkify:     true,
        typographer: true,
        highlight(code: string, rawLang: string): string {
            // Mermaid diagrams are pre-rendered to SVG in a post-processing step.
            // Emit a placeholder here; the actual render happens in renderMermaidDiagrams().
            if (rawLang === 'mermaid') {
                return mermaidPlaceholder(code);
            }

            // Graphviz diagrams follow the same placeholder-then-render shape as
            // Mermaid, laid out via the WASM engine in renderGraphvizDiagrams().
            // Both fence names are accepted since either is common in the wild.
            if (rawLang === 'dot' || rawLang === 'graphviz') {
                return graphvizPlaceholder(code);
            }

            // AntV Infographic's DSL, rendered in renderInfographicDiagrams().
            if (rawLang === 'infographic') {
                return infographicPlaceholder(code);
            }

            const [lang, rangeSpec] = splitLangSpec(rawLang);
            const highlightLines    = extractHighlightLines(rangeSpec);

            if (lang && hljs.getLanguage(lang)) {
                try {
                    const highlighted = hljs.highlight(
                        code,
                        { language: lang, ignoreIllegals: true },
                    ).value;
                    return `<pre class="hljs"><code>${wrapCodeLines(highlighted, highlightLines)}</code></pre>`;
                } catch { /* fall through to default */ }
            }
            const escaped = md.utils.escapeHtml(code);
            return `<pre class="hljs"><code>${wrapCodeLines(escaped, highlightLines)}</code></pre>`;
        },
    })
        .use(compat(anchor), {
            slugify: (s: string) => { slugger.reset(); return slugger.slug(s); },
            permalink: compat(anchor).permalink?.headerLink?.(),
        })
        .use(compat(attrs))
        // Empty options rather than none: under markdown-it 15's own types the
        // katex plugin declares its options parameter required. `{}` is what it
        // defaulted to anyway, so this is a typing accommodation, not a change.
        .use(compat(katex), {})
        .use(compat(alerts))
        .use(compat(footnote))
        .use(compat(abbr))
        .use(compat(mark))
        .use(compat(sub))
        .use(compat(sup))
        .use(compat(deflist))
        .use(compat(ins))
        .use(taskLists)
        .use(mkdocsAdmonitions);

    if (!fm.trademarkSymbols) {
        md.core.ruler.at('replacements', replaceRareTypography);
    }

    registerAdmonitionRenderers(md);
    registerLayoutContainers(md);
    registerRedlineMarks(md);

    for (const t of CONTAINER_TYPES) {
        md.use(container, t, containerConfig(t));
    }

    const content: string = hideFrontmatterTable(md.render(cleanTocAttrs(body)));
    const glossaryHtml    = buildGlossary(body, lang);
    const katexStyleBlock = documentUsesKatex(content) ? buildKatexStyleBlock() : '';

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${katexStyleBlock}
</head>
<body class="vscode-body vscode-light">

<div class="github-markdown-body">
  <div class="github-markdown-content">
${content}
${glossaryHtml}
  </div>
</div>

</body>
</html>
`;
}

// ── Front matter table suppression ───────────────────────────────────────────

/**
 * If the rendered content starts with a `<table>` before any heading or
 * paragraph, that table is the YAML front matter rendered as HTML (happens when
 * the front-matter package does not recognise the delimiter).  Wrap it in a
 * `<div class="frontmatter-table">` so the CSS rule hides it cleanly.
 */
export function hideFrontmatterTable(html: string): string {
    const firstSignificant = html.search(/<(h[1-6]|p|ul|ol|blockquote|pre|hr)\b/i);
    const firstTable       = html.search(/<table\b/i);

    if (firstTable === -1 || (firstSignificant !== -1 && firstSignificant < firstTable)) {
        return html;
    }

    // Walk forward from firstTable tracking open/close <table> tags so we find
    // the matching </table> even when the frontmatter table contains nested tables.
    let depth = 0;
    let i     = firstTable;
    let tableEnd = -1;
    while (i < html.length) {
        const open  = html.indexOf('<table', i);
        const close = html.indexOf('</table>', i);
        if (open !== -1 && (close === -1 || open < close)) {
            depth++;
            i = open + 6;
        } else if (close !== -1) {
            depth--;
            i = close + 8;
            if (depth === 0) { tableEnd = i; break; }
        } else {
            break;
        }
    }

    if (tableEnd === -1) return html;

    return (
        html.slice(0, firstTable) +
        '<div class="frontmatter-table">' +
        html.slice(firstTable, tableEnd) +
        '</div>' +
        html.slice(tableEnd)
    );
}

// ── Abbreviation glossary ─────────────────────────────────────────────────────

const GLOSSARY_LABELS: Record<string, { heading: string; col1: string; col2: string }> = {
    nl: { heading: 'Afkortingen',   col1: 'Afkorting',    col2: 'Omschrijving' },
    en: { heading: 'Abbreviations', col1: 'Abbreviation', col2: 'Description'  },
    de: { heading: 'Abkürzungen',   col1: 'Abkürzung',    col2: 'Beschreibung' },
    fr: { heading: 'Abréviations',  col1: 'Abréviation',  col2: 'Description'  },
    es: { heading: 'Abreviaturas',  col1: 'Abreviatura',  col2: 'Descripción'  },
};

/**
 * Blanks the body of every fenced code block, keeping line numbering intact.
 *
 * The glossary scan reads the raw markdown rather than the token stream, so
 * without this it saw a line inside a code fence as a definition — and
 * markdown-it-abbr, which does read the token stream, did not. A document
 * showing `*[ABBR]: Full form` as an *example* of the syntax therefore grew a
 * glossary entry for it while nothing in the prose was ever abbreviated.
 *
 * The closing fence must be at least as long as the opening one and of the same
 * character, which is what lets a ```` ```` ```` block quote a ``` one — the
 * same rule `includeAsCodeBlock` relies on when it picks a fence.
 */
export function stripFencedCode(body: string): string {
    const lines = body.split('\n');
    let fence: { char: string; length: number } | null = null;

    return lines.map(line => {
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
        if (!fence) {
            if (open) fence = { char: open[1][0], length: open[1].length };
            return line;                                  // keep the opening fence
        }
        // Inside a block: only a fence of the same character and at least the
        // same length closes it.
        if (open && open[1][0] === fence.char && open[1].length >= fence.length) {
            fence = null;
            return line;
        }
        return '';
    }).join('\n');
}

/**
 * Scans the raw markdown body for abbreviation definitions (`*[ABBR]: Definition`)
 * and returns an HTML glossary section, or an empty string if none are found.
 *
 * The glossary starts on a new page (page-break-before: always) and lists every
 * abbreviation alphabetically in a two-column table, with headings localised to
 * the document language (falls back to English).
 */
export function buildGlossary(body: string, lang: string): string {
    const abbrevRe = /^\*\[([^\]]+)\]:\s*(.+)$/gm;
    const entries  = new Map<string, string>();

    let m: RegExpExecArray | null;
    const prose = stripFencedCode(body);
    while ((m = abbrevRe.exec(prose)) !== null) {
        entries.set(m[1].trim(), m[2].trim());
    }

    if (entries.size === 0) return '';

    const labels = GLOSSARY_LABELS[lang.toLowerCase()] ?? GLOSSARY_LABELS['en'];

    const rows = [...entries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([abbr, def]) =>
            `    <tr><td class="glossary-abbr">${escHtml(abbr)}</td>` +
            `<td class="glossary-def">${escHtml(def)}</td></tr>`,
        )
        .join('\n');

    return `
<div class="glossary-section">
  <h2>${labels.heading}</h2>
  <table class="glossary-table">
    <thead><tr><th>${labels.col1}</th><th>${labels.col2}</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

// ── KaTeX CSS inlining ────────────────────────────────────────────────────────

/**
 * Whether the rendered document contains any KaTeX output.
 *
 * Every katex render path tags its wrapper with a `katex*` class — `katex`,
 * `katex-display`, `katex-block`, `katex-html`, `katex-mathml`, and
 * `katex-error` for a formula that failed to parse — and nothing else in the
 * pipeline emits one, so this is exact rather than a heuristic.
 *
 * It matches the *markup*, deliberately, not the word "katex": a document that
 * merely writes about KaTeX mentions it in prose (and the stylesheet itself
 * carries several hundred `.katex` selectors), so a bare-word search would
 * report a hit on essentially everything and gate nothing.
 */
export function documentUsesKatex(renderedHtml: string): boolean {
    return /class="[^"]*\bkatex/.test(renderedHtml);
}

/**
 * Inlines KaTeX's stylesheet with its twenty woff2 faces embedded as data URIs.
 *
 * Only called for documents that actually rendered math — see
 * {@link documentUsesKatex}. The block is ~370 KB, of which ~347 KB is fonts,
 * and it used to be emitted unconditionally: a five-line document with no math
 * exported at 401 KB, ~90% of it KaTeX that nothing on the page referenced.
 */
function buildKatexStyleBlock(): string {
    try {
        const katexCssPath = require.resolve('katex/dist/katex.min.css', { paths: [__dirname] });
        const katexDir = path.dirname(katexCssPath);
        let css = fs.readFileSync(katexCssPath, 'utf8');

        // Keep only woff2, drop woff/ttf fallbacks
        css = css.replace(/(format\(['"]woff2['"]\))\s*,[^;}]+/g, '$1');

        // Strip SVG presentation attributes (WeasyPrint doesn't need them)
        css = css.replace(
            /\b(?:fill|stroke|fill-rule|fill-opacity|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|stroke-opacity)\s*:[^;]+;?/g,
            '',
        );

        // Inline woff2 fonts as base64
        css = css.replace(
            /url\(['"]?(?!data:)(fonts\/[^'")]+\.woff2)['"]?\)\s*format\(['"]woff2['"]\)/g,
            (match: string, ref: string) => {
                const fontPath = path.resolve(katexDir, ref);
                if (!fs.existsSync(fontPath)) return match;
                const b64 = fs.readFileSync(fontPath).toString('base64');
                return `url('data:font/woff2;base64,${b64}') format('woff2')`;
            },
        );

        // Drop remaining non-woff2 font URLs
        css = css.replace(/,\s*url\(['"]?fonts\/[^'")]+\.(?:woff|ttf)['"]?\)[^,;]*/g, '');

        log(`KaTeX CSS inlined (${(css.length / 1024).toFixed(0)} KB)`);
        return `<style>\n${css}\n</style>`;
    } catch (err: unknown) {
        log(`WARNING: Could not inline KaTeX CSS: ${(err as Error).message}`);
        return '';
    }
}
