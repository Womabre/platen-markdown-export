import { PDF_VARIANTS } from './config';
import { editDistance } from './strings';

/**
 * Every frontmatter key the exporter reads, in one table.
 *
 * Keys used to be known only implicitly — as the `at('…')` calls scattered
 * through `extractFrontmatter`, the scaffold in `frontmatterTemplate`, the
 * extension's copy of that scaffold and `docs/FRONTMATTER.md` — and nothing
 * compared a document against any of them. `Revison: 2` was read by nobody and
 * reported by nobody: the export ran, the revision stayed wrong, and not even
 * `--strict` could see it. This table is what a document is checked against
 * (`unknownKeyWarnings`) and what `--frontmatter-schema` is generated from, and
 * `src/tests/frontmatter-keys.test.ts` fails when `extractFrontmatter` reads a
 * key this table does not declare.
 */

/** A JSON Schema fragment. Kept loose: the table only ever builds plain literals. */
export type SchemaFragment = Record<string, unknown>;

export interface FrontmatterKeySpec {
    /** The documented spelling. Matching is case-insensitive, as the reader is. */
    key: string;
    /** Other spellings that are read as this key (`Cover Title Colour`). */
    aliases?: readonly string[];
    /** One line for the schema's `description`, and so for editor hovers. */
    description: string;
    /** What the value may be. */
    schema: SchemaFragment;
}

const str:  SchemaFragment = { type: 'string' };
const bool: SchemaFragment = { type: 'boolean' };
/** A value YAML may hand over as a string, a number or a timestamp. */
const scalar: SchemaFragment = { type: ['string', 'number'] };
/** A cover/footer override: a value, or `false` to remove the element. */
const overrideOrFalse = (value: SchemaFragment): SchemaFragment => ({ anyOf: [value, { const: false }] });

/** The keys of one `Revisions` row. */
export const REVISION_ROW_KEYS = ['Revision', 'Date', 'Author', 'Remarks'] as const;

/** The keys of an inline `Style` mapping. */
export const STYLE_OBJECT_KEYS = ['Name', 'Color', 'Image', 'Position', 'Overlay'] as const;

/** The keys of a `Cover Logo` list entry. */
export const COVER_LOGO_KEYS = ['Path', 'Background'] as const;

export const FRONTMATTER_KEYS: readonly FrontmatterKeySpec[] = [
    // ── Identity and revision ────────────────────────────────────────────────
    { key: 'Title', schema: str,
      description: 'Document title. Text after a spaced " — " or ": " becomes the cover subtitle.' },
    { key: 'Document Info', schema: {
          type: 'object',
          properties: {
              Author:   scalar,
              Date:     {},
              Revision: scalar,
              Status:   str,
          },
          additionalProperties: true,
      },
      description: 'Labelled rows rendered on the cover. Author, Date, Revision and Status are also read by the exporter; any other label is shown as written.' },
    { key: 'Revisions', schema: {
          type: 'array',
          items: {
              type: 'object',
              properties: { Revision: scalar, Date: {}, Author: scalar, Remarks: scalar },
          },
      },
      description: 'Revision history table, oldest first. The last row is the current revision.' },
    { key: 'Revisions Visible', schema: { type: 'integer', minimum: 0 },
      description: 'How many revision rows the cover shows (0 hides the table). Default 3.' },
    { key: 'Status', schema: str,
      description: 'Fallback for Document Info.Status. "Released" (or "Vrijgegeven") enables --release.' },
    { key: 'Author', schema: scalar,
      description: 'Fallback for Document Info.Author.' },
    { key: 'Date', schema: {},
      description: 'Fallback for Document Info.Date.' },
    { key: 'Revision', aliases: ['Version'], schema: scalar,
      description: 'Legacy shorthand, used only when neither Document Info nor Revisions gives a revision.' },

    // ── Output ───────────────────────────────────────────────────────────────
    { key: 'Mode', schema: { anyOf: [str, { type: 'array', items: { enum: ['pdf', 'html', 'debug'] } }] },
      description: 'What to export: pdf, html, debug, or a comma-separated combination. Without it the document is not exported.' },
    { key: 'Export On Save', schema: bool,
      description: 'VS Code only: false keeps this document out of export-on-save.' },
    { key: 'PDF Variant', schema: { enum: [...PDF_VARIANTS] },
      description: 'Tags the PDF as a conformance level (PDF/A, PDF/UA, PDF/X), e.g. pdf/a-2b.' },
    { key: 'Lang', schema: str,
      description: 'Document language (en, nl, de, fr, es); sets generated labels.' },

    // ── Branding ─────────────────────────────────────────────────────────────
    { key: 'Theme', schema: str,
      description: 'Brand package: a theme name (see --list-themes) or a theme directory.' },
    { key: 'Style', schema: {
          anyOf: [str, {
              type: 'object',
              properties: {
                  Name:     str,
                  Color:    str,
                  Image:    str,
                  Position: scalar,
                  Overlay:  { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              },
          }],
      },
      description: 'Cover style: a named style of the theme (see --list-styles), or a {Name, Color, Image, Position, Overlay} mapping.' },
    { key: 'Logo', schema: str,
      description: "Brand mark: a name from the theme's logos map, or a path." },
    { key: 'Cover Logo', schema: {
          anyOf: [str, { type: 'array', items: { type: 'object' } }],
      },
      description: 'A third-party logo on the cover: a path, or a list of {Path} and {Background} entries.' },
    { key: 'Cover Page', schema: bool,
      description: "false suppresses the cover but keeps the Style's colours." },
    { key: 'Cover Slogan', schema: overrideOrFalse(str),
      description: "Replaces the theme's cover slogan; false removes it." },
    { key: 'Cover Address', schema: overrideOrFalse({ anyOf: [str, { type: 'array', items: str }] }),
      description: "Replaces the theme's cover address (a string or one line per list entry); false removes it." },
    { key: 'Cover Title Color', aliases: ['Cover Title Colour'], schema: str,
      description: 'Colour of the cover title, subtitle and rule: hex, rgb()/rgba() or a palette name.' },
    { key: 'Cover Footer Logo', schema: overrideOrFalse(str),
      description: "The cover's bottom-right mark; false removes it." },
    { key: 'Footer Logo', schema: overrideOrFalse(str),
      description: 'The bottom-centre mark on every page; false removes it.' },
    { key: 'Header', schema: { type: ['string', 'null'] },
      description: 'Running header text. Defaults to the title.' },
    { key: 'Footer', schema: { type: ['string', 'null'] },
      description: 'Running footer text. Defaults to "page N of M".' },

    // ── Document controls ────────────────────────────────────────────────────
    { key: 'Numbered Headings', schema: bool,
      description: 'Numbers ## to ###### hierarchically (1, 1.1, 1.1.1).' },
    { key: 'Running Header', schema: bool,
      description: 'The top-left header follows the current section title.' },
    { key: 'List of Tables', schema: bool,
      description: 'Index of captioned tables after the TOC.' },
    { key: 'List of Figures', schema: bool,
      description: 'Index of captioned figures after the TOC.' },
    { key: 'Code Line Numbers', schema: bool,
      description: 'Numbers every line of every fenced code block.' },
    { key: 'Copy Buttons', schema: bool,
      description: 'On by default: a Copy button on every code block in the HTML export.' },
    { key: 'Trademark Symbols', schema: bool,
      description: 'Converts (c), (r), (tm) to ©, ®, ™.' },
    { key: 'Watermark', schema: { type: ['string', 'boolean'] },
      description: 'Diagonal stamp on every PDF page; true reuses Status. Never shown once Released.' },
    { key: 'Classification', schema: { enum: ['Public', 'Internal', 'Confidential'] },
      description: 'Sensitivity label in the top-right margin.' },
    { key: 'TOC Depth', schema: { type: 'integer', minimum: 1, maximum: 6 },
      description: 'Deepest heading level listed in the table of contents.' },
    { key: 'Page Size', schema: str,
      description: 'A3, A4, A5, Letter, Legal, Tabloid, or a "W H" pair. Default A4.' },
    { key: 'Margins', schema: str,
      description: '@page margin as 1-4 CSS lengths (20mm, 25mm 15mm). Default 2cm.' },
    { key: 'Orientation', schema: { enum: ['portrait', 'landscape'] },
      description: 'Page orientation for the whole document.' },
    { key: 'Variables', schema: { type: 'object', additionalProperties: scalar },
      description: 'A mapping substituted into the body as {{Name}}.' },
];

// ── Unknown-key detection ─────────────────────────────────────────────────────

/** Case, spaces, hyphens and underscores folded away: `cover_title-color` → `covertitlecolor`. */
function fold(key: string): string {
    return key.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * The known key `key` was most likely meant to be, or null.
 *
 * Deliberately a near-miss detector, not an allowlist. A document often carries
 * keys for other tools — Marp's `paginate`, Obsidian's `tags`, Hugo's `draft` —
 * and warning on every one of those would teach people to ignore the warning.
 * So a key is reported only when it is close enough to one of ours to be a typo:
 * the same key spelled with `_`/`-` or without spaces (the reader matches case,
 * not separators), or within a small edit distance that counts a swapped pair of
 * letters as one edit (`Titel`). Short keys get a tighter limit, because two
 * edits turn `tag` into `Lang`.
 */
export function suggestKey(key: string, known: readonly string[]): string | null {
    const target = fold(key);
    if (!target) return null;
    const limit = target.length < 6 ? 1 : Math.max(2, Math.floor(target.length / 4));

    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of known) {
        const d = editDistance(target, fold(candidate), { transpositions: true });
        if (d < bestDistance) { best = candidate; bestDistance = d; }
    }
    return bestDistance <= limit ? best : null;
}

/** Keys of `mapping` that are neither known nor a case variant of one, each with its suggestion. */
function nearMisses(mapping: unknown, known: readonly string[], aliases: readonly string[] = []): Array<[string, string]> {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return [];
    const exact = new Set([...known, ...aliases].map(k => k.toLowerCase()));
    const out: Array<[string, string]> = [];
    for (const key of Object.keys(mapping)) {
        if (exact.has(key.toLowerCase())) continue;
        const guess = suggestKey(key, [...known, ...aliases]);
        if (guess) out.push([key, guess]);
    }
    return out;
}

const TOP_LEVEL = FRONTMATTER_KEYS.map(k => k.key);
const TOP_LEVEL_ALIASES = FRONTMATTER_KEYS.flatMap(k => k.aliases ?? []);

/**
 * A warning for every frontmatter key that looks like a misspelling of one the
 * exporter reads — top level, inside a `Revisions` row, an inline `Style`
 * mapping or a `Cover Logo` entry.
 *
 * `Document Info` and `Variables` are not checked: their keys are the author's
 * own labels and names, and any of them is valid.
 */
export function unknownKeyWarnings(attributes: unknown): string[] {
    const warnings: string[] = [];
    const say = (where: string, key: string, guess: string): void => {
        warnings.push(`WARNING: Unknown frontmatter key "${where}${key}" — did you mean "${where}${guess}"? It is ignored.`);
    };

    for (const [key, guess] of nearMisses(attributes, TOP_LEVEL, TOP_LEVEL_ALIASES)) say('', key, guess);

    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return warnings;
    const attrs = attributes as Record<string, unknown>;
    const value = (name: string): unknown => {
        const hit = Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase());
        return hit === undefined ? undefined : attrs[hit];
    };

    const revisions = value('Revisions');
    if (Array.isArray(revisions)) {
        revisions.forEach((row, i) => {
            for (const [key, guess] of nearMisses(row, REVISION_ROW_KEYS))
                warnings.push(`WARNING: Unknown key "${key}" in Revisions row ${i + 1} — did you mean "${guess}"? It is ignored.`);
        });
    }

    for (const [key, guess] of nearMisses(value('Style'), STYLE_OBJECT_KEYS)) say('Style.', key, guess);

    const coverLogo = value('Cover Logo');
    if (Array.isArray(coverLogo)) {
        for (const entry of coverLogo)
            for (const [key, guess] of nearMisses(entry, COVER_LOGO_KEYS)) say('Cover Logo.', key, guess);
    }

    return warnings;
}

// ── JSON Schema ───────────────────────────────────────────────────────────────

/**
 * A JSON Schema (draft-07) for the frontmatter, generated from the table.
 *
 * Unknown keys stay allowed (`additionalProperties: true`) for the same reason
 * `unknownKeyWarnings` only reports near-misses: a document may carry other
 * tools' keys. JSON Schema cannot say "case-insensitive", so the schema uses the
 * documented spelling; aliases are listed as properties of their own, marked
 * with `x-aliasOf`.
 */
export function frontmatterJsonSchema(): SchemaFragment {
    const properties: Record<string, SchemaFragment> = {};
    for (const spec of FRONTMATTER_KEYS) {
        properties[spec.key] = { description: spec.description, ...spec.schema };
        for (const alias of spec.aliases ?? [])
            // `x-aliasOf` lets an editor hide the alias from suggestions while
            // still describing it on hover; validators ignore unknown keywords.
            properties[alias] = { description: `Alias of ${spec.key}. ${spec.description}`, 'x-aliasOf': spec.key, ...spec.schema };
    }
    return {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://raw.githubusercontent.com/Womabre/platen-markdown-export/main/schema/frontmatter.schema.json',
        title: 'platen-markdown-export frontmatter',
        description: 'YAML frontmatter keys read by platen-markdown-export. Keys are case-insensitive.',
        type: 'object',
        properties,
        additionalProperties: true,
    };
}
