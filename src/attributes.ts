import { literal } from './strings';

/**
 * One shared way to read and write an HTML attribute on a tag.
 *
 * This module exists because the same bug was found and fixed five separate
 * times, in three modules, and still shipped a sixth. `html: true` is on, so a
 * document may hand-write `<img src='a.png'>` or `<img src=a.png>` alongside the
 * `src="a.png"` markdown emits — and a pattern that knows only the double-quoted
 * spelling silently does nothing to the other two. That failure is invisible in
 * the output (an un-inlined image and a correctly-inlined one differ only in a
 * PDF nobody diffs), which is why each occurrence was found by a user rather
 * than by a test.
 *
 * The second half of the lesson, learned in `stylesheets.ts` and `drawio.ts` and
 * NOT propagated to `images.ts`, is the leading `\s`. Without it, `src=` also
 * matches the tail of `data-src=`, so `<img data-src="lazy.png">` was read as an
 * image reference (a spurious "Image not found", and an exit 6 under `--strict`)
 * and `<img data-src="x" src="real.png">` had its data URL written into
 * `data-src` while the real `src` kept pointing at a local file the exported
 * HTML could no longer reach.
 *
 * Both rules now live in exactly one place. Callers say which attribute they
 * mean and never write the pattern themselves.
 */

/**
 * The three ways an attribute value may be written, as one alternation with a
 * capture group per spelling. Unquoted values stop at whitespace or `>`.
 */
const VALUE_SPELLINGS = '(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))';

/**
 * Compiled patterns, keyed by `name|flags`.
 *
 * `attrOf` runs per tag and a document can hold thousands, so the pattern is
 * built once rather than on every call.
 */
const patternCache = new Map<string, RegExp>();

/**
 * A pattern matching ` name=<value>` in any of the three spellings.
 *
 * The leading `\s` is load-bearing: it keeps the attribute name whole, so `src`
 * does not match inside `data-src` and `class` does not match inside
 * `data-class`. Group 1/2/3 hold the value for the double-quoted, single-quoted
 * and unquoted forms respectively.
 *
 * `name` is always a literal from this codebase (`src`, `class`, `rel`, `href`),
 * never user input, so it is interpolated without escaping.
 */
export function attrPattern(name: string, flags = 'i'): RegExp {
    const key = `${name}|${flags}`;
    let re = patternCache.get(key);
    if (!re) {
        re = new RegExp(`\\s${name}=${VALUE_SPELLINGS}`, flags);
        patternCache.set(key, re);
    }
    // A cached global pattern carries `lastIndex` between calls, so hand back a
    // fresh one rather than a shared cursor.
    return flags.includes('g') ? new RegExp(re.source, re.flags) : re;
}

/** The value of `name` in `tag`, whichever way it was quoted, or null when absent. */
export function attrOf(tag: string, name: string): string | null {
    const m = attrPattern(name).exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * Replaces `name`'s value in `tag`, normalising to a double-quoted attribute.
 *
 * The value goes through {@link literal}, so a data URI or a caption containing
 * `$&` is inserted verbatim rather than expanded as a replacement template.
 *
 * When the attribute is absent it is inserted directly after the tag name, which
 * is what lets a caller add `class` to a tag that had none without a second
 * code path.
 */
export function setAttr(tag: string, name: string, value: string): string {
    const re = attrPattern(name);
    if (re.test(tag)) return tag.replace(re, literal(` ${name}="${value}"`));
    return tag.replace(/^<([a-z][\w-]*)/i, (_m, tagName: string) => `<${tagName} ${name}="${value}"`);
}

/**
 * Every value of `name` across a whole document, in document order.
 *
 * Used to collect the class attributes an icon-font scan reads, so the document
 * is walked once instead of once per pattern being looked for.
 */
export function attrValues(html: string, name: string): string[] {
    return [...html.matchAll(attrPattern(name, 'gi'))]
        .map(m => m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * Every whole `<tag …>` of one element type in a document.
 *
 * Deliberately matches the element rather than the element-carrying-a-specific
 * attribute: callers then ask {@link attrOf} what it holds. The older shape —
 * one pattern that walked the tag looking for `src` on the way past — encoded an
 * attribute *order* that HTML does not have, so `<link href="…" rel="stylesheet">`
 * matched nothing while the same element written the other way round matched.
 */
export function findTags(html: string, tagName: string): string[] {
    return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))].map(m => m[0]);
}

/** The pattern {@link findTags} uses, for a caller that needs to run a replace with it. */
export function tagPattern(tagName: string): RegExp {
    return new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
}

/**
 * A pattern for `<tagName …>` whose `attr` value ENDS with `valueRe`.
 *
 * The narrow counterpart to {@link findTags}, for the one caller that must not
 * match every element of its type: draw.io rewrites `<img>` tags after image
 * inlining has already turned the rest of them into multi-megabyte data URIs, so
 * a pattern that matched all of them would key a lookup map on those strings and
 * hash a megabyte per image to learn there was nothing to do.
 *
 * Only the value alternation is shared with {@link attrPattern} in spirit — the
 * quoted branches deliberately allow the other quote character and whitespace
 * inside the value, so `src="my diagrams/arch.drawio"` matches — but the leading
 * `\s` guard is identical, and identical for the same reason.
 */
export function tagWithAttrValue(tagName: string, attr: string, valueRe: string, flags = 'gi'): RegExp {
    const quoted = (q: string): string => `${q}[^${q}]*${valueRe}${q}`;
    return new RegExp(
        `<${tagName}\\b[^>]*?\\s${attr}=(?:${quoted('"')}|${quoted("'")}|[^\\s>"']*${valueRe})[^>]*>`,
        flags,
    );
}
