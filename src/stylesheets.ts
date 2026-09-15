/**
 * External CSS ingestion — icon fonts, remote stylesheets, local stylesheets.
 *
 * Split out of css.ts, which had grown to 955 lines spanning two unrelated
 * jobs. css.ts *generates* CSS from the active theme (page geometry, palette
 * variables, typography). This module *ingests* CSS that someone else wrote and
 * flattens it into a self-contained document: resolving `@import` chains,
 * base64-embedding every `url()` it finds, and caching the immutable icon-font
 * payloads on disk. Different inputs, different failure modes, different
 * reasons to change.
 *
 * Nothing here reads the theme, which is what made the cut clean.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchRemote, fetchRemoteText, fetchAsBase64 } from './fetch';
import { cacheDir, readCache, writeCache } from './cache';
import { mapPool } from './concurrency';
import { CONFIG } from './config';
import { log } from './logger';
import { literal } from './strings';
import { attrOf, attrValues, findTags } from './attributes';

// ── Icon font inlining (Font Awesome Free + Phosphor) ─────────────────────────

const FA_FREE_CSS_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css';
// Phosphor 2.1.2 removed src/index.css — weights are now separate stylesheets.
//
// jsDelivr rather than unpkg. Both serve this package byte-for-byte (verified:
// 78131 bytes for src/regular/style.css from either), but unpkg is a single
// origin with a history of rate-limiting and outages, and Phosphor is the icon
// font that fails hardest when a fetch drops: every weight arrives through an
// @import, so a blocked origin leaves the synthetic index empty. cdnjs is not an
// option here — it does not carry Phosphor at all, which is why Font Awesome
// above and this do not share a CDN.
const PHOSPHOR_BASE_URL = 'https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.2/src/';
// Weight → regex tested against the joined class-attribute values (not the full
// HTML), so each pattern omits the class="[^"]*  prefix for brevity/speed.
// Phosphor icon names embed the weight as a suffix, e.g. ph-database-bold,
// ph-check-circle-fill. The patterns must match that suffix inside the icon
// class name, not a separate standalone class.
// Phosphor v2 uses weight-specific BASE classes, not suffix-in-icon-name.
// Regular: class="ph ph-database"          → .ph selector
// Bold:    class="ph-bold ph-database-bold" → .ph-bold selector
// Fill:    class="ph-fill ph-database-fill" → .ph-fill selector
// etc.
// Detect the base marker class for each weight.
const PHOSPHOR_WEIGHT_PATTERNS: Array<[string, RegExp]> = [
    ['regular',  /\bph\b(?!-)/],        // standalone "ph" class
    ['bold',     /\bph-bold\b/],        // standalone "ph-bold" class
    ['fill',     /\bph-fill\b/],        // standalone "ph-fill" class
    ['duotone',  /\bph-duotone\b/],
    ['light',    /\bph-light\b/],
    ['thin',     /\bph-thin\b/],
];

// ── Icon CSS disk cache ───────────────────────────────────────────────────────
// Icon-font URLs are version-pinned (immutable), so the fully inlined CSS is
// cached on disk. Repeat exports skip the CDN entirely and keep working offline.

/**
 * Where the icon-font CSS cache lives. One namespace of the shared cache — see
 * `cache.ts` for why it is under the user's own home rather than a shared temp
 * directory.
 *
 * Kept as its own function, with the platform parameters passed through, because
 * three of those branches are unreachable from the machine running the suite and
 * the tests assert them directly.
 */
export function iconCacheDir(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    return cacheDir(ICON_CACHE_NS, platform, env, home);
}

const ICON_CACHE_NS = 'icon-cache';

const readIconCache  = (key: string): string | null => readCache(ICON_CACHE_NS, key, '.css');
const writeIconCache = (key: string, css: string): void => writeCache(ICON_CACHE_NS, key, css, '.css');

// Module-level cache for remote CSS content — deduplicates fetches across
// recursive @import resolution branches. Stores Promises so concurrent
// recursive calls share the same in-flight request.
const _cssImportCache = new Map<string, Promise<string>>();

/**
 * Clears the remote CSS import cache.
 *
 * Called by `main()` at the start of every export, which matters under
 * `--watch`: that loop re-enters `main()` in the same process, so without this
 * the map outlives the run that filled it. A *rejected* promise cached that way
 * is replayed instantly on every later export, so one transient blip disabled
 * icon fonts for the rest of the watch session with no further network attempt.
 * Rejections are also evicted at the point they are caught; this is the
 * belt-and-braces half, and the seam the tests already used.
 */
export function clearCssImportCache(): void { _cssImportCache.clear(); }

/**
 * CSS with everything it referenced folded in, and whether that actually
 * succeeded.
 *
 * `complete: false` means at least one `@import` was dropped or one `url()` was
 * left pointing at the network. The CSS is still usable — a partly-inlined
 * stylesheet beats no stylesheet — but it must never reach the disk cache. See
 * {@link buildIconStylesheet}.
 */
interface InlinedCss {
    css: string;
    complete: boolean;
}

/**
 * Recursively resolves @import rules in CSS before inlining url() font references.
 * Needed because Phosphor's index.css imports per-weight stylesheets.
 * Fetched URLs are cached to avoid duplicate network requests across branches.
 *
 * Reports completeness rather than swallowing failure. Every failure path here
 * *removes* the thing it could not fetch and returns normally, which reads as
 * success to a caller that only looks at the string — and the caller wrote that
 * string to a permanent disk cache.
 */
async function inlineCssRecursive(cssContent: string, baseUrl: string): Promise<InlinedCss> {
    const importRe = /@import\s+(?:url\(['"]?([^'")]+)['"]?\)|['"]([^'"]+)['"])\s*;/g;
    const importMatches = [...cssContent.matchAll(importRe)];
    let complete = true;

    for (const match of importMatches) {
        const ref = match[1] ?? match[2];
        let absoluteUrl: string;
        try {
            // new URL handles absolute, root-relative (/x), relative and ../ refs
            absoluteUrl = new URL(ref, baseUrl).toString();
        } catch {
            log(`WARNING: Could not resolve @import ${ref} against ${baseUrl} — skipping`);
            cssContent = cssContent.replace(match[0], '');
            complete = false;
            continue;
        }
        const importBaseUrl = new URL('.', absoluteUrl).toString();
        try {
            let cachedPromise = _cssImportCache.get(absoluteUrl);
            if (!cachedPromise) {
                cachedPromise = fetchRemote(absoluteUrl).then(r => r.buffer.toString('utf8'));
                _cssImportCache.set(absoluteUrl, cachedPromise);
            }
            const imported = await cachedPromise;
            const inlined  = await inlineCssRecursive(imported, importBaseUrl);
            cssContent = cssContent.replace(match[0], inlined.css);
            if (!inlined.complete) complete = false;
        } catch {
            // Evicted, not left behind: a rejected promise kept in the map is
            // replayed forever, so the next export would not even retry.
            _cssImportCache.delete(absoluteUrl);
            log(`WARNING: Could not resolve @import ${absoluteUrl} — skipping`);
            cssContent = cssContent.replace(match[0], '');
            complete = false;
        }
    }

    const fonts = await inlineFontsInCss(cssContent, baseUrl);
    return { css: fonts.css, complete: complete && fonts.complete };
}

/**
 * The advice a degraded icon-font run ends on.
 *
 * Worth saying out loud because the failure is otherwise invisible: the glyphs
 * are simply missing, and the run that explained why has scrolled away.
 */
const DEGRADED_ICON_NOTE =
    'the document will export, but some glyphs may be missing and the output is no longer self-contained. ' +
    'Re-run when the network is available; use --clear-cache if a previous run cached a bad copy.';

/**
 * Fetches one icon-font stylesheet, flattens it, and caches it only if that
 * worked.
 *
 * Exported for testing. `buildIconStyles` reaches this through two hardcoded CDN
 * URLs, so the caching rule below — the one that turns a transient blip into a
 * permanently wrong export — was unreachable from a hermetic test until this was
 * callable with a loopback URL of its own.
 */
export async function buildIconStylesheet(name: string, url: string): Promise<string> {
    const cached = readIconCache(url);
    if (cached !== null) {
        log(`Icon font ready: ${name} (disk cache)`);
        return `<style>\n${cached}\n</style>`;
    }

    log(`Fetching icon font: ${name}`);
    try {
        const baseUrl = new URL('.', url).toString();
        const css     = (await fetchRemote(url)).buffer.toString('utf8');
        const { css: inlined, complete } = await inlineCssRecursive(css, baseUrl);

        // The cache is permanent, has no expiry, and is trusted on the next read.
        // Writing a degraded copy into it converts one transient network blip
        // into a silent, forever-wrong export: every later run reported
        // "(disk cache)" and made no request at all, so not even --strict could
        // see it. Only a complete inline earns a cache entry.
        if (complete) {
            writeIconCache(url, inlined);
            log(`Icon font ready: ${name}`);
        } else {
            log(`WARNING: ${name} was inlined incompletely and has NOT been cached — ${DEGRADED_ICON_NOTE}`);
        }
        return `<style>\n${inlined}\n</style>`;
    } catch (err: unknown) {
        log(`WARNING: Could not fetch icon font ${name}: ${err instanceof Error ? err.message : String(err)}`);
        return '';
    }
}

/** Which icon fonts a rendered document actually uses. */
export interface IconFontUsage {
    needsFa: boolean;
    /** Phosphor weights present, in `PHOSPHOR_WEIGHT_PATTERNS` order. */
    phosphorWeights: string[];
}

/**
 * Decides which icon fonts a document needs — the pure half of
 * {@link buildIconStyles}, split out so the detection can be tested without a
 * CDN. It is the part that rots: the Phosphor patterns encode that library's
 * class scheme (weight-specific BASE classes since v2), and getting one wrong
 * either ships a 300 KB font nobody uses or silently renders no glyph.
 */
export function detectIconFonts(htmlContent: string): IconFontUsage {
    // Extract all class-attribute values once — avoids scanning the full HTML
    // once per icon-weight pattern. `attrValues` supplies the three quoting
    // spellings and the leading-whitespace guard that keeps `class` from
    // matching inside `data-class`.
    const classAttrs = attrValues(htmlContent, 'class').join(' ');

    return {
        needsFa: /\bfa-[a-z]/.test(classAttrs),
        phosphorWeights: PHOSPHOR_WEIGHT_PATTERNS
            .filter(([, re]) => re.test(classAttrs))
            .map(([w]) => w),
    };
}

/**
 * Auto-detects FA Free / Phosphor icon usage in the rendered HTML and inlines
 * the required icon font CSS (with all woff2 files base64-encoded) into the PDF.
 * Only fetches what is actually used — zero overhead when icons are absent.
 *
 * For Phosphor, detects which weights are used and builds a synthetic combined
 * CSS (since @phosphor-icons/web 2.1.2 removed the top-level src/index.css).
 */
export async function buildIconStyles(htmlContent: string): Promise<string> {
    const { needsFa, phosphorWeights } = detectIconFonts(htmlContent);
    const needsPh = phosphorWeights.length > 0;

    if (!needsFa && !needsPh) return '';

    const tasks: Promise<string>[] = [];
    if (needsFa) tasks.push(buildIconStylesheet('Font Awesome Free', FA_FREE_CSS_URL));
    if (needsPh) {
        // Build a synthetic index that imports only the weights used in this document.
        const syntheticCss = phosphorWeights.map(w => `@import url("${w}/style.css");`).join('\n');
        const cacheKey     = `${PHOSPHOR_BASE_URL}#${phosphorWeights.join(',')}`;
        const cached       = readIconCache(cacheKey);
        if (cached !== null) {
            log(`Icon font ready: Phosphor Icons (${phosphorWeights.join(', ')}) (disk cache)`);
            tasks.push(Promise.resolve(`<style>\n${cached}\n</style>`));
        } else {
            log(`Fetching icon font: Phosphor Icons (${phosphorWeights.join(', ')})`);
            tasks.push(
                inlineCssRecursive(syntheticCss, PHOSPHOR_BASE_URL)
                    .then(({ css, complete }) => {
                        // Same rule as buildIconStylesheet: only a complete
                        // inline earns a permanent cache entry. This branch is
                        // the one that fails hardest — every weight arrives
                        // through an @import, so a blocked CDN leaves the
                        // synthetic index empty and cached forever.
                        if (complete) {
                            writeIconCache(cacheKey, css);
                            log('Icon font ready: Phosphor Icons');
                        } else {
                            log(`WARNING: Phosphor Icons was inlined incompletely and has NOT been cached — ${DEGRADED_ICON_NOTE}`);
                        }
                        return `<style>\n${css}\n</style>`;
                    })
                    .catch((err: unknown) => {
                        log(`WARNING: Could not fetch icon font Phosphor Icons: ${err instanceof Error ? err.message : String(err)}`);
                        return '';
                    }),
            );
        }
    }

    return (await Promise.all(tasks)).filter(Boolean).join('\n');
}

/**
 * A `fill:` declaration WeasyPrint can't parse, excluding the three values that
 * must survive: `currentColor` (how icon SVGs inherit their heading colour),
 * `inherit`, and a `url(#gradient)` paint reference.
 *
 * The lookahead sits immediately after the colon and swallows the whitespace
 * *itself*. Written the obvious way — `fill\s*:\s*(?!currentColor|…)` — the
 * `\s*` before the lookahead can backtrack to zero width, at which point the
 * lookahead is tested against " currentColor", does not match, and the negative
 * lookahead succeeds. So the exemption held for `fill:currentColor` and failed
 * for `fill: currentColor`: every exempt value written the normal way, with a
 * space, was stripped anyway. Shared by both inliners so the two cannot drift.
 */
const UNSUPPORTED_FILL_RE = /\bfill\s*:(?!\s*(?:currentColor|inherit|url))[^;}\n]+;?/g;

// ── Remote stylesheet inlining ────────────────────────────────────────────────

/**
 * Inlines all non-data url() references in CSS as base64 data URLs.
 *
 * Deduplicates by the raw url(...) text so each unique URL is fetched only
 * once even when referenced multiple times (e.g. Font Awesome's woff2 files).
 * All fetches run in parallel, then replacements are applied with replaceAll
 * to handle every occurrence in a single pass.
 */
async function inlineFontsInCss(cssContent: string, baseUrl: string): Promise<InlinedCss> {
    const matches = [...cssContent.matchAll(/url\(['"]?(?!data:)([^'")]+)['"]?\)/g)];
    if (matches.length === 0) return { css: cssContent, complete: true };

    let complete = true;

    // Deduplicate: map each unique url(...) text to its resolved absolute URL
    const urlMap = new Map<string, string>();
    for (const match of matches) {
        if (urlMap.has(match[0])) continue;
        const ref = match[1];
        try {
            // new URL handles absolute, root-relative (/x), relative and ../ refs
            urlMap.set(match[0], new URL(ref, baseUrl).toString());
        } catch {
            log(`WARNING: Could not resolve url(${ref}) against ${baseUrl} — keeping as-is`);
            complete = false;
        }
    }

    // Bounded, like every other renderer that fans out over document matches:
    // one icon-font stylesheet can reference dozens of files, and each in-flight
    // fetch holds its whole response in memory before it is base64-encoded.
    const results = await mapPool(
        [...urlMap.entries()], CONFIG.concurrency,
        async ([originalText, absoluteUrl]) => {
            try {
                return [originalText, `url('${await fetchAsBase64(absoluteUrl)}')`, true] as const;
            } catch {
                // The declaration survives, pointing at the network — which is
                // the right fallback for THIS export and the wrong thing to
                // remember, so the caller is told the result is degraded.
                log(`WARNING: Failed to inline font ${absoluteUrl} — keeping as absolute URL`);
                return [originalText, `url('${absoluteUrl}')`, false] as const;
            }
        },
    );

    // Replace all occurrences of each url(...) in one pass
    for (const [originalText, replacement, ok] of results) {
        cssContent = cssContent.replaceAll(originalText, literal(replacement));
        if (!ok) complete = false;
    }

    return { css: cssContent, complete };
}

/**
 * Every remote stylesheet `<link>` in the document, as `[tag, href]` pairs.
 *
 * The tag is matched whole and its attributes are then found within it, rather
 * than in one pattern that walks `rel` then `href`. That older shape encoded an
 * attribute *order* the HTML spec does not have: `<link href="…" rel="stylesheet">`
 * — the same element, written the other way round — matched nothing, and so was
 * never inlined. WeasyPrint then either fetched it itself at render time or laid
 * the page out with no stylesheet at all, neither of which says anything about
 * why. `rel=stylesheet` unquoted missed for the same reason. drawio.ts already
 * carries this lesson for `<img>`; this is the same fix.
 *
 * `rel` is compared token-wise because it is a space-separated list, and an
 * `alternate stylesheet` is deliberately excluded: it is the one a browser does
 * *not* apply by default, so inlining it would paint the wrong styles.
 *
 * Exported for testing — whether a tag is recognised is invisible in the output,
 * which is exactly how the two spellings above went unnoticed.
 */
export function findRemoteStylesheetLinks(htmlContent: string): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    for (const tag of findTags(htmlContent, 'link')) {
        const rel = (attrOf(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!rel.includes('stylesheet') || rel.includes('alternate')) continue;

        const href = attrOf(tag, 'href');
        if (href && /^https?:\/\//i.test(href)) found.push([tag, href]);
    }
    return found;
}

export async function inlineRemoteStylesheets(htmlContent: string): Promise<string> {
    const matches = findRemoteStylesheetLinks(htmlContent);

    if (matches.length === 0) return htmlContent;

    // Bounded: independent requests, but a document is free to link twenty
    // stylesheets and each one fans out again over its own url() references.
    const replacements = await mapPool(
        matches, CONFIG.concurrency,
        async ([tag, href]) => {
            const baseUrl = new URL('.', href).toString();
            try {
                log(`Inlining remote stylesheet: ${href}`);
                // Completeness is not consulted here: a remote <link> is inlined
                // per export and never cached, so a degraded result costs this
                // run only. The warnings it raised still reach --strict.
                let css = (await inlineFontsInCss(await fetchRemoteText(href), baseUrl)).css;
                css = css.replace(UNSUPPORTED_FILL_RE, '');
                log(`Inlined: ${href}`);
                return { tag, replacement: `<style>${css}</style>` };
            } catch (err: unknown) {
                log(`WARNING: Failed to inline stylesheet ${href}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
    );

    for (const r of replacements) {
        if (r) htmlContent = htmlContent.replace(r.tag, literal(r.replacement));
    }

    return htmlContent;
}

// ── Local stylesheet inlining ─────────────────────────────────────────────────

/**
 * Recursively resolves local `@import url("./...")` rules by inlining the file
 * each names. Remote `@import` urls are left alone — they are handled by
 * `buildIconStyles` or by WeasyPrint itself.
 *
 * `seen` is shared across the whole resolution, not copied per branch, so a file
 * is inlined **once** however many stylesheets import it. That is a deduplicator
 * that happens to also close cycles, and the distinction matters: the comment
 * here used to call it a circular-import guard, which reads as though a repeat
 * were impossible rather than merely dropped.
 *
 * Dropping is the right behaviour — a theme whose two stylesheets both import a
 * shared reset should not carry two copies of it into every PDF, and CSS has no
 * context that would make the second copy mean something different. But it is
 * not *nothing*, because it moves that file's position in the cascade to
 * wherever it was first pulled in, so it is now logged rather than silent.
 *
 * `resolveIncludes` in markdown.ts deliberately does the opposite (a per-branch
 * copy, so a diamond expands twice) because there the repeat is prose the author
 * meant to appear twice.
 */
function resolveLocalImports(css: string, dir: string, seen: Set<string>, deps?: Set<string>): string {
    return css.replace(
        /@import\s+url\(['"]?(?!https?:\/\/)([^'")]+)['"]?\)\s*;/g,
        (_match: string, ref: string) => {
            const importPath = path.resolve(dir, ref);
            if (seen.has(importPath)) {
                log(`Local @import already inlined, skipping repeat: ${importPath}`);
                return '';
            }
            if (!fs.existsSync(importPath)) {
                log(`WARNING: Local @import not found, skipping: ${importPath}`);
                return '';
            }
            seen.add(importPath);
            // A theme stylesheet that @imports another is a file this export
            // read; --watch had only the top-level sheet.
            deps?.add(importPath);
            const content = fs.readFileSync(importPath, 'utf8');
            return resolveLocalImports(content, path.dirname(importPath), seen, deps);
        },
    );
}

/**
 * Removes a balanced at-rule (e.g. `@media …{ … }`) wherever `openRe` matches its `…{`.
 *
 * An at-rule whose braces never close is left in place, along with everything
 * after it. The brace scan can only find the end of a rule that HAS one, and
 * treating "ran off the end of the file" as "the rule ended here" silently
 * deleted the entire remainder of the stylesheet — a far worse outcome than
 * leaving one unparseable rule for WeasyPrint to warn about.
 */
function stripBalancedAtRule(css: string, openRe: RegExp): string {
    let out = '', last = 0;
    let m: RegExpExecArray | null;
    openRe.lastIndex = 0;
    while ((m = openRe.exec(css)) !== null) {
        let depth = 1, i = openRe.lastIndex;
        while (i < css.length && depth > 0) {
            const c = css[i++];
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
        if (depth > 0) {
            log('WARNING: Unterminated at-rule in stylesheet — keeping it and everything after it');
            break;
        }
        out += css.slice(last, m.index);
        last = i;
        openRe.lastIndex = i;
    }
    return out + css.slice(last);
}

/**
 * Strips CSS that WeasyPrint can't parse and that is irrelevant to print, so the
 * PDF run isn't flooded with harmless "unsupported selector / media type"
 * warnings (and isn't bloated by a screen-only dark-mode block):
 *   - `@media (prefers-color-scheme: …)` blocks — dark mode is screen-only.
 *   - form-control pseudo-element rules (`::-webkit-…`, `::-moz-…`, `::placeholder`,
 *     `:dir(…)`) that markdown output never contains (e.g. from github-markdown-css).
 */
export function stripPrintIncompatibleCss(css: string): string {
    css = stripBalancedAtRule(css, /@media[^{]*prefers-color-scheme[^{]*\{/g);
    css = css.replace(PRINT_INCOMPATIBLE_RULE_RE, '');
    return css;
}

/**
 * A whole rule whose selector carries a pseudo-element WeasyPrint cannot parse.
 *
 * The leading `(^|\})` is what makes this linear, and it is the only reason it
 * is written this way. A selector run cannot contain a brace, so a rule's
 * selector always begins at the start of the stylesheet or just after the
 * previous rule's `}` — but spelled `[^{}]*?…` with nothing anchoring it, the
 * engine cannot know that, and retries the whole alternation at *every* offset.
 * Each failed start costs O(n), so the scan is quadratic in the stylesheet:
 * measured at 50 ms for 10 KB, 192 ms for 20 KB, 788 ms for 40 KB and 3.4 s for
 * 80 KB of brace-free input. Every theme shipped here is well under that (3 ms
 * worst case), which is why nothing caught it — but the input is a stylesheet
 * the user points `-s` at, and this runs on every save-triggered export.
 *
 * Anchoring sends the engine straight to the viable start positions: at every
 * other offset the assertion fails in constant time instead of dragging the
 * alternation across the rest of the stylesheet.
 *
 * The anchor is a **lookbehind**, not a captured `}`, and that distinction is
 * load-bearing. Capturing it consumes it, so the delimiter the *next* rule needs
 * to anchor on is gone — two strippable rules in a row meant the first was
 * removed and the second silently kept, which is worse than the slowness this
 * was fixing. A lookbehind asserts the same thing without eating it.
 */
const PRINT_INCOMPATIBLE_RULE_RE =
    /(?:^|(?<=\}))[^{}]*?(?:::-webkit-[\w-]+|::-moz-[\w-]+|::placeholder|:dir\([^)]*\))[^{}]*\{[^{}]*\}/g;

/** What {@link readLocalStylesheet} does beyond reading the file. */
export interface LocalStylesheetOptions {
    /** Drop screen-only and WeasyPrint-incompatible CSS. */
    forPrint?: boolean;
    /** Collects every file read, for `--watch`. */
    deps?: Set<string>;
    /**
     * Keep the remote Font Awesome / Phosphor `@import`s. An export strips them
     * because `buildIconStyles` embeds only the icon fonts a document uses; a
     * live preview has no document to scan ahead of time, so it keeps the link.
     */
    keepIconImports?: boolean;
}

/**
 * A local stylesheet flattened into one self-contained string — local
 * `@import`s resolved, local fonts embedded — or null when the file is missing.
 *
 * Split from {@link inlineLocalStylesheet} so the preview kit (`preview-kit.ts`)
 * builds its CSS from the very same processing the export applies, rather than
 * from a second reader that could quietly disagree with it.
 */
export function readLocalStylesheet(stylesheetPath: string, opts: LocalStylesheetOptions = {}): string | null {
    const { forPrint = false, deps, keepIconImports = false } = opts;
    if (!fs.existsSync(stylesheetPath)) {
        log(`WARNING: Stylesheet not found at ${stylesheetPath}`);
        return null;
    }

    const cssDir = path.dirname(stylesheetPath);
    let css = fs.readFileSync(stylesheetPath, 'utf8');

    // Resolve local @import references first (e.g. @import url("./fonts.css") or a
    // theme that extends another via @import url("../default/css/theme.css")) so
    // nested imports are inlined before the icon-import strip below sees them.
    css = resolveLocalImports(css, cssDir, new Set([path.resolve(stylesheetPath)]), deps);

    // Strip icon-font @imports (Font Awesome, Phosphor) already handled by
    // buildIconStyles, so WeasyPrint doesn't make duplicate or failing fetches.
    if (!keepIconImports) {
        css = css.replace(
            /@import\s+url\(['"]?https?:\/\/[^'")]*(?:font-awesome|@phosphor-icons)[^'")]*['"]?\)\s*;/g,
            '',
        );
    }

    // Inline local font files referenced in the stylesheet
    css = css.replace(
        /url\(['"]?(?!https?:\/\/|data:)([^'")]+\.(?:woff2?|ttf|otf))['"]?\)/gi,
        (match: string, ref: string) => {
            const fontPath = path.resolve(cssDir, ref);
            if (!fs.existsSync(fontPath)) {
                log(`WARNING: Font file not found, skipping inline: ${fontPath}`);
                return match;
            }
            const ext  = path.extname(fontPath).toLowerCase().slice(1);
            const mime = ext === 'woff2' ? 'font/woff2'
                       : ext === 'woff'  ? 'font/woff'
                       : ext === 'ttf'   ? 'font/ttf'
                       :                   'font/otf';
            log(`Inlined font: ${path.basename(fontPath)}`);
            return `url('data:${mime};base64,${fs.readFileSync(fontPath).toString('base64')}')`;
        },
    );

    // Strip SVG fill declarations (WeasyPrint chokes on them in stylesheets)
    css = css.replace(UNSUPPORTED_FILL_RE, '');

    // For the PDF, drop screen-only / WeasyPrint-incompatible CSS (dark-mode media,
    // form-control pseudo-elements) so the run isn't bloated or noisy with warnings.
    if (forPrint) css = stripPrintIncompatibleCss(css);

    return css;
}

export function inlineLocalStylesheet(htmlContent: string, stylesheetPath: string | null, forPrint = false, deps?: Set<string>): string {
    if (!stylesheetPath) return htmlContent;

    if (!fs.existsSync(stylesheetPath)) {
        log(`WARNING: Stylesheet not found at ${stylesheetPath}`);
        return htmlContent;
    }

    log(`Inlining local stylesheet: ${stylesheetPath}`);
    const css = readLocalStylesheet(stylesheetPath, { forPrint, deps });
    if (css === null) return htmlContent;

    const styleBlock = `<style>\n${css}\n</style>`;

    // Replace an existing <link> to the theme stylesheet if present (matched by
    // its filename), otherwise append the inlined block to <head>.
    //
    // The choice is made on whether the *replacement actually matched*, never on
    // whether the filename appears somewhere in the document. Those are not the
    // same question: every shipped theme's stylesheet is called `theme.css`, and
    // a document that merely writes that name in its prose ("edit theme.css…" —
    // this project's own README does) used to satisfy a plain `includes()` guard,
    // match no `<link>`, and silently ship with NO stylesheet at all while the
    // log still claimed it had been inlined.
    const escaped = path.basename(stylesheetPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linked  = htmlContent.replace(new RegExp(`<link[^>]+${escaped}[^>]*>`, 'g'), literal(styleBlock));

    if (linked !== htmlContent) {
        log(`Inlined: ${stylesheetPath}`);
        return linked;
    }

    if (!htmlContent.includes('</head>')) {
        log(`WARNING: Document has no </head> and no <link> to ${path.basename(stylesheetPath)} — stylesheet not applied`);
        return htmlContent;
    }

    log(`Inlined: ${stylesheetPath}`);
    return htmlContent.replace('</head>', literal(`${styleBlock}\n</head>`));
}
