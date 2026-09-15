/**
 * String helpers for the HTML/CSS rewriting the pipeline is built on.
 */

/**
 * Wraps a computed replacement so `String.replace`/`replaceAll` insert it
 * verbatim.
 *
 * A *string* replacement is a template: `$&`, `` $` ``, `$'`, `$1`… are
 * expanded against the match. That is fine for a literal written in the source,
 * and a latent corruption bug for anything derived from the document — a title
 * of `Q1 $& Q2`, an `<img alt="a$&b">`, a third-party stylesheet, or a Mermaid
 * diagram echoed back in an error block. A *function* replacement has no such
 * syntax: whatever it returns is inserted as-is.
 *
 * So: `html.replaceAll(needle, literal(value))`, never
 * `html.replaceAll(needle, value)`, whenever `value` comes from content rather
 * than from the source file you are reading.
 */
export function literal(replacement: string): () => string {
    return () => replacement;
}

/**
 * Serialises a value for embedding inside an inline `<script>` element.
 *
 * `JSON.stringify` produces a valid JavaScript literal, but the surrounding
 * `<script>` is parsed by the **HTML** parser first, and that parser does not
 * know it is looking at a string. It ends the element at the first `</script>`
 * in the raw text, wherever it appears — so a Mermaid node label reading
 * `A["close tag: </script>"]`, ordinary enough in documentation about HTML,
 * truncates the script mid-statement and spills the rest of the diagram into
 * the page as markup.
 *
 * Escaping `<` closes the whole class, not just that one case: `</script>` ends
 * the element, and `<!--` followed by `<script` puts the parser into the
 * double-escaped state where a later `</script>` does *not* end it. `<` is
 * the same character to the JavaScript parser and invisible to the HTML one, so
 * the value reaches the script unchanged.
 */
export function jsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * The candidate closest to `target`, when it is close enough to be the thing
 * someone meant to type — within a quarter of `target`'s length, and never more
 * than a few edits for a short one. Null when nothing is that close, so a wild
 * guess is never offered as a correction.
 */
export function closestMatch(target: string, candidates: readonly string[]): string | null {
    const limit = Math.max(2, Math.floor(target.length / 4));
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const d = editDistance(target.toLowerCase(), candidate.toLowerCase());
        if (d < bestDistance) { best = candidate; bestDistance = d; }
    }
    return bestDistance <= limit ? best : null;
}
