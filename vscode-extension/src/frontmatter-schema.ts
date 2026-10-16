/**
 * Frontmatter key completion and hover, minus the editor.
 *
 * The key list is not kept here. It comes from the CLI's `--frontmatter-schema`,
 * which is generated from the exporter's own key table (`src/frontmatter-keys.ts`
 * in the root package), so a key the exporter learns appears in the editor with
 * no change to the extension, and a key it drops stops being suggested. A copy
 * here would be the fifth place the key list lived, and the one most likely to
 * fall behind, because the extension ships on its own schedule.
 *
 * No `vscode` import, so `node --test` can load it; `completion.ts` adapts it to
 * VS Code's provider API.
 */

/** One key as the editor offers it. */
export interface SchemaKey {
    key: string;
    description: string;
    /** Values worth suggesting after `Key: ` — an enum, booleans, `false` for an override. */
    values: string[];
    /** For an alias (`Cover Title Colour`), the key it stands for. */
    aliasOf?: string;
}

type Fragment = Record<string, unknown>;

/** Every literal a schema fragment admits, found through `anyOf`, array `items`, `enum`, `const` and boolean types. */
function literalValues(fragment: unknown, out: Set<string> = new Set()): Set<string> {
    if (!fragment || typeof fragment !== 'object') { return out; }
    const f = fragment as Fragment;
    if (Array.isArray(f.enum)) { for (const v of f.enum) { out.add(String(v)); } }
    if ('const' in f) { out.add(String(f.const)); }
    const types = Array.isArray(f.type) ? f.type : [f.type];
    if (types.includes('boolean')) { out.add('true'); out.add('false'); }
    if (Array.isArray(f.anyOf)) { for (const alt of f.anyOf) { literalValues(alt, out); } }
    if (f.items) { literalValues(f.items, out); }
    return out;
}

/**
 * Parses `--frontmatter-schema`, returning [] for anything unexpected.
 *
 * An older CLI does not know the flag and exits 2, which the caller reports as
 * null; a newer one might reshape the schema. Either way the answer is "no
 * suggestions", never an exception inside a completion provider.
 */
export function parseFrontmatterSchema(json: string | null): SchemaKey[] {
    let schema: unknown;
    try { schema = JSON.parse(json ?? ''); } catch { return []; }
    const properties = (schema as { properties?: unknown } | null)?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) { return []; }

    return Object.entries(properties as Record<string, unknown>).map(([key, fragment]) => {
        const f = (fragment ?? {}) as { description?: unknown; 'x-aliasOf'?: unknown };
        return {
            key,
            description: typeof f.description === 'string' ? f.description : '',
            values: [...literalValues(fragment)],
            ...(typeof f['x-aliasOf'] === 'string' ? { aliasOf: f['x-aliasOf'] } : {}),
        };
    });
}

// ── Where the cursor is ───────────────────────────────────────────────────────

const OPENING_FENCE = /^﻿?---[ \t]*$/;
const CLOSING_FENCE = /^(---|\.\.\.)[ \t]*$/;

/**
 * The line range strictly inside the frontmatter, or null when the document has
 * none.
 *
 * A closing fence is required. Without it, a document that merely starts with a
 * `---` rule would have its whole body treated as frontmatter, and every line of
 * prose would be offered key names.
 */
export function frontmatterLines(lines: readonly string[]): { first: number; last: number } | null {
    if (!lines.length || !OPENING_FENCE.test(lines[0])) { return null; }
    for (let i = 1; i < lines.length; i++) {
        if (CLOSING_FENCE.test(lines[i])) { return { first: 1, last: i - 1 }; }
    }
    return null;
}

/** A top-level key line: no indentation, not a comment, not a list item. */
const TOP_LEVEL_KEY = /^([^\s#\-][^:]*?)[ \t]*:/;

/** The top-level keys a frontmatter block already sets, lowercased, skipping `exceptLine`. */
export function presentKeys(lines: readonly string[], exceptLine = -1): Set<string> {
    const range = frontmatterLines(lines);
    const found = new Set<string>();
    if (!range) { return found; }
    for (let i = range.first; i <= range.last; i++) {
        if (i === exceptLine) { continue; }
        const m = TOP_LEVEL_KEY.exec(lines[i]);
        if (m) { found.add(m[1].trim().toLowerCase()); }
    }
    return found;
}

/** What the cursor is in the middle of typing. */
export type CompletionContext =
    | { kind: 'key'; start: number }
    | { kind: 'value'; key: string; start: number };

/**
 * What can be completed at `line`/`character`, or null when nothing can.
 *
 * Only top-level lines are considered: an indented line belongs to `Document
 * Info`, a `Revisions` row or a `Style` mapping, whose keys are either the
 * author's own labels or a short fixed set nobody needs prompting for. `start`
 * is the column the replacement begins at — 0 for a key, because keys contain
 * spaces and VS Code's word-based range would otherwise replace only the last
 * word of `Numbered Head`.
 */
export function completionContext(lines: readonly string[], line: number, character: number): CompletionContext | null {
    const range = frontmatterLines(lines);
    if (!range || line < range.first || line > range.last) { return null; }

    const text = lines[line] ?? '';
    const before = text.slice(0, character);
    if (/^\s/.test(before) || before.startsWith('#') || before.startsWith('-')) { return null; }

    const colon = before.indexOf(':');
    if (colon === -1) { return { kind: 'key', start: 0 }; }

    const key = before.slice(0, colon).trim();
    if (!key) { return null; }
    const afterColon = before.slice(colon + 1);
    const start = colon + 1 + (afterColon.length - afterColon.trimStart().length);
    return { kind: 'value', key, start };
}

/**
 * The keys worth offering on a key line: every known one the block does not
 * already set, under any of its spellings. Aliases are never offered — they
 * exist so a document written either way keeps working, not as a second choice
 * to make — but they still count as setting their key.
 */
export function keySuggestions(keys: readonly SchemaKey[], present: ReadonlySet<string>): SchemaKey[] {
    const set = new Set(present);
    for (const k of keys) { if (k.aliasOf && present.has(k.key.toLowerCase())) { set.add(k.aliasOf.toLowerCase()); } }
    return keys.filter(k => !k.aliasOf && !set.has(k.key.toLowerCase()));
}

/** A key by name, as the exporter matches it: case-insensitively. */
export function findKey(keys: readonly SchemaKey[], name: string): SchemaKey | undefined {
    const lower = name.trim().toLowerCase();
    return keys.find(k => k.key.toLowerCase() === lower);
}

/** The top-level key a hover at `line`/`character` is over, or null. */
export function keyAt(lines: readonly string[], line: number, character: number): string | null {
    const range = frontmatterLines(lines);
    if (!range || line < range.first || line > range.last) { return null; }
    const m = TOP_LEVEL_KEY.exec(lines[line] ?? '');
    if (!m || character > m[1].length) { return null; }
    return m[1].trim();
}

/** The value of a top-level scalar key in the frontmatter, unquoted — how `Style` finds its `Theme`. */
export function topLevelValue(lines: readonly string[], name: string): string | null {
    const range = frontmatterLines(lines);
    if (!range) { return null; }
    const lower = name.toLowerCase();
    for (let i = range.first; i <= range.last; i++) {
        const m = /^([^\s#\-][^:]*?)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(lines[i]);
        if (m && m[1].toLowerCase() === lower) {
            const value = m[2].replace(/[ \t]+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
            return value || null;
        }
    }
    return null;
}
