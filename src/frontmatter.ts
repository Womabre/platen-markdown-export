import * as fs from 'fs';
import frontMatter from 'front-matter';
import { writeFileAtomic } from './fsutil';
import { log } from './logger';
import { literal } from './strings';
import { PDF_VARIANTS } from './config';
import type {
    FrontmatterAnswers,
    FrontmatterData,
    DocumentInfoEntry,
    RevisionEntry,
    StyleFrontmatter,
    CoverLogoSpec,
    Classification,
    PaperDimensions,
    PageOrientation,
    Override,
} from './types';

// ── Case-insensitive key access ───────────────────────────────────────────────

/** A style written inline as a mapping rather than named. */
interface RawStyleObject {
    Name?: string; name?: string;
    Color?: string; color?: string;
    Image?: string; image?: string;
    Position?: unknown; position?: unknown;
    Overlay?: unknown; overlay?: unknown;
}

/**
 * Builds a case-insensitive reader over a YAML mapping.
 *
 * Frontmatter keys are documented in Title Case (`Cover Title Color`) but must
 * keep working in any casing the author happens to type. This used to be spelled
 * out as ~40 pairs of optional interface members plus `attrs.X ?? attrs.x` at
 * every read — which is how `Cover Title Colour` came to need four separate
 * declarations, and how a key wired for only one casing would silently do
 * nothing. One index removes that whole class of bug.
 *
 * Several names may be given; the first one present wins, which is how spelling
 * variants (`Color` / `Colour`) are handled.
 */
function reader(source: unknown): (...names: string[]) => unknown {
    const index = new Map<string, unknown>();
    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
            // First spelling wins, so an exact-case key is never shadowed by a
            // differently-cased duplicate later in the mapping.
            if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), value);
        }
    }
    return (...names: string[]) => {
        for (const name of names) {
            const value = index.get(name.toLowerCase());
            if (value !== undefined) return value;
        }
        return undefined;
    };
}

/** The first value that stringifies to something non-empty, or null. */
function firstNonEmpty(...values: unknown[]): string | null {
    for (const v of values) {
        if (v == null) continue;
        const s = `${v}`;
        if (s !== '') return s;
    }
    return null;
}

/**
 * The revision a document declares.
 *
 * One rule, in one place, because there used to be two that disagreed. This
 * function is what `extractFrontmatter` uses for the document being exported;
 * `resolveIncludes` in markdown.ts used a second copy for an included file, and
 * that copy ordered the sources differently — top-level `Revision`/`Version`
 * ahead of the newest `Revisions` row rather than behind it. A document carrying
 * `Revision: 2` alongside a `Revisions` table ending at 5 therefore reported 5
 * as itself and stamped `(Rev. 2)` on its own heading when included somewhere
 * else. The two can no longer drift because there is only one.
 *
 * Order: `Document Info.Revision` (the explicit statement) → the newest
 * `Revisions` row (the history's own idea of current) → a top-level
 * `Version`/`Revision` (the legacy shorthand). Empty values are skipped rather
 * than returned, so a `Revisions` row with no `Revision:` field falls through
 * instead of resolving to the empty string.
 */
export function resolveRevision(attributes: unknown): string | null {
    const at   = reader(attributes);
    const info = reader(at('Document Info'));

    const rows = at('Revisions');
    const last = Array.isArray(rows) ? rows.at(-1) : undefined;

    return firstNonEmpty(
        info('Revision'),
        last !== undefined ? reader(last)('Revision') : null,
        at('Version', 'Revision'),
    );
}

// ── Scalar coercion ───────────────────────────────────────────────────────────

/**
 * YAML already turns `true`/`yes`/`on` into booleans, but a value can still
 * arrive as a string when quoted (`"true"`) or written in a case YAML doesn't
 * recognise. Anything unset falls back to `false`.
 */
function parseBool(raw: unknown): boolean {
    if (raw == null) return false;
    if (typeof raw === 'boolean') return raw;
    return /^(true|yes|on|1)$/i.test(String(raw).trim());
}

const CLASSIFICATIONS: Classification[] = ['Public', 'Internal', 'Confidential'];

/** Case-insensitively resolves a Classification, warning (and disabling) on an unknown value. */
function parseClassification(raw: unknown): Classification | null {
    if (raw == null || raw === '') return null;
    const value = String(raw).trim();
    const match = CLASSIFICATIONS.find(c => c.toLowerCase() === value.toLowerCase());
    if (!match) {
        log(`WARNING: Unknown Classification "${value}" — expected one of ${CLASSIFICATIONS.join(', ')}; ignoring`);
        return null;
    }
    return match;
}

/**
 * Statuses meaning "this document is final" — English and Dutch. A released
 * document is never watermarked: the stamp exists to mark work that is NOT
 * final, so leaving it on a signed-off deliverable is worse than useless.
 */
const RELEASED_STATUSES = ['released', 'vrijgegeven'];

/**
 * What to do about two exports racing for the same document.
 *
 * Both compare-and-swap guards — the revision-date stamp in markdown.ts and the
 * release bump here — detect the same condition and used to explain it in two
 * different amounts of detail, only one of which said what to change. Shared so
 * they cannot drift, and so the advice is given wherever the condition is met.
 *
 * There is deliberately no lock file: a stale one would make the tool refuse to
 * export, which is a worse failure than doing the work twice.
 */
export const CONCURRENT_EXPORT_HINT =
    '  Usually this means two exports ran at once — a --watch loop and the VS Code\n' +
    "  extension's export-on-save both watch the same file. Pick one: stop the watch,\n" +
    '  or set "Export On Save: false" in this document\'s frontmatter.';

export function isReleasedStatus(status: string | null): boolean {
    return status != null && RELEASED_STATUSES.includes(status.trim().toLowerCase());
}

/**
 * `Watermark: true` reuses the document Status as the stamp text (the common
 * "DRAFT"/"Work in Progress" case); any other string is used verbatim.
 * Suppressed entirely once the document is Released / Vrijgegeven, whatever
 * the value — an explicit string included.
 */
function parseWatermark(raw: unknown, status: string | null): string | null {
    if (raw == null || raw === '' || raw === false) return null;

    if (isReleasedStatus(status)) {
        log(`Watermark suppressed — document status is "${status}"`);
        return null;
    }

    if (raw === true) return status?.trim() || null;
    const value = String(raw).trim();
    if (/^(false|no|off|0)$/i.test(value)) return null;
    if (/^(true|yes|on|1)$/i.test(value)) return status?.trim() || null;
    return value || null;
}

// ── Variables, TOC depth, page geometry ───────────────────────────────────────

/** Flattens a `Variables:` mapping to string→string; non-mapping values are ignored. */
function parseVariables(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        out[k] = v == null ? '' : `${v}`;
    }
    return out;
}

/** Deepest heading level shown in the TOC. Out-of-range values warn and disable the limit. */
function parseTocDepth(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isNaN(n) || n < 1 || n > 6) {
        log(`WARNING: TOC Depth "${raw}" is not a heading level 1–6; ignoring`);
        return null;
    }
    return n;
}

/** Portrait dimensions of the paper sizes accepted by `Page Size`, in millimetres. */
export const PAPER_SIZES: Record<string, PaperDimensions> = {
    a3:      { widthMm: 297, heightMm: 420 },
    a4:      { widthMm: 210, heightMm: 297 },
    a5:      { widthMm: 148, heightMm: 210 },
    letter:  { widthMm: 216, heightMm: 279 },
    legal:   { widthMm: 216, heightMm: 356 },
    tabloid: { widthMm: 279, heightMm: 432 },
};

/** A named paper size, or any literal CSS `size` value (e.g. `210mm 297mm`) passed through. */
function parsePageSize(raw: unknown): string | null {
    if (raw == null || raw === '') return null;
    const value = String(raw).trim();
    if (PAPER_SIZES[value.toLowerCase()]) return value.toUpperCase();
    if (/^[\d.]+\s*(mm|cm|in|pt|px)\s+[\d.]+\s*(mm|cm|in|pt|px)$/i.test(value)) return value;
    log(`WARNING: Unknown Page Size "${value}" — expected ${Object.keys(PAPER_SIZES).join('/')} or "W H"; ignoring`);
    return null;
}

/**
 * A PDF conformance level (`PDF Variant`), validated against WeasyPrint's own
 * enum so a typo fails with the full list of valid values rather than
 * reaching WeasyPrint as a bare error.
 */
function parsePdfVariant(raw: unknown): string | null {
    if (raw == null || raw === '') return null;
    const value = String(raw).trim().toLowerCase();
    if ((PDF_VARIANTS as readonly string[]).includes(value)) return value;
    log(`WARNING: Unknown PDF Variant "${value}" — expected one of ${PDF_VARIANTS.join(', ')}; ignoring`);
    return null;
}

/**
 * Document-wide sheet orientation. `::: landscape` / `::: portrait` blocks
 * override it per page, so this only sets the default.
 */
function parseOrientation(raw: unknown): PageOrientation {
    if (raw == null || raw === '') return 'portrait';
    const value = String(raw).trim().toLowerCase();
    if (value === 'landscape' || value === 'portrait') return value;
    log(`WARNING: Unknown Orientation "${raw}" — expected portrait or landscape; using portrait`);
    return 'portrait';
}

/**
 * A key that can replace an element's content or switch the element off.
 * `false`/`no`/`none`/`off` remove it; any other text replaces the theme's
 * value; absent leaves the theme default in place.
 *
 * YAML turns a bare `false` into a boolean and `none` into a string, so both
 * shapes have to be handled.
 */
function parseOverride(raw: unknown): Override {
    if (raw == null || raw === '') return null;
    if (raw === false) return false;
    if (raw === true)  return null;          // `true` means "keep the default"
    const value = String(raw).trim();
    if (/^(false|no|none|off)$/i.test(value)) return false;
    return value || null;
}

/** As {@link parseOverride}, but a YAML list becomes the lines of a block. */
function parseOverrideLines(raw: unknown): Override {
    if (Array.isArray(raw)) {
        const lines = raw.filter(v => v != null).map(v => `${v}`.trim()).filter(Boolean);
        return lines.length ? lines.join('\n') : false;
    }
    return parseOverride(raw);
}

/** A 1–4 component CSS length shorthand for `@page { margin }`. */
function parseMargins(raw: unknown): string | null {
    if (raw == null || raw === '') return null;
    const value = String(raw).trim();
    const parts = value.split(/\s+/);
    if (parts.length > 4 || !parts.every(p => /^[\d.]+(mm|cm|in|pt|px)$/i.test(p))) {
        log(`WARNING: Margins "${value}" is not 1–4 CSS lengths (e.g. "20mm" or "25mm 15mm"); ignoring`);
        return null;
    }
    return value;
}

/**
 * A starter frontmatter block, for `--init`.
 *
 * Every key here is one the exporter actually reads and every value is one it
 * accepts — `Navy` is a real style of the `default` theme, checked by the test
 * beside this. A scaffold that names something the tool does not have is worse
 * than no scaffold, because the person following it has no way to tell whose
 * fault the error is.
 *
 * The VS Code extension keeps its own copy in `vscode-extension/src/core.ts`:
 * it compiles as a separate package and inserts this into an editor buffer
 * rather than a file, so it cannot import from here. A test asserts the two
 * declare the same keys, in the same spirit as `check:versions` — two copies
 * that must agree, with something that fails when they stop agreeing.
 *
 * @param today Overridable so the output is deterministic in a test.
 */
export function frontmatterTemplate(
    today: string = new Date().toISOString().slice(0, 10),
    answers: FrontmatterAnswers = {},
): string {
    const a = answers;
    const date     = a.date ?? today;
    const title    = a.title  ?? 'Document Title';
    const author   = a.author ?? 'Your Name';
    const revision = String(a.revision ?? 1);
    const status   = a.status ?? 'Work In Progress';
    const remarks  = a.remarks ?? 'Initial version';

    // Every answered value goes through `yamlQuote`, which is why the wizard is
    // routed here rather than assembling YAML in the editor: a title with a
    // colon in it ("Q3 Report: Draft") or an author with an apostrophe produces
    // a document that does not parse, on the very first export, and the person
    // who typed it has no way to tell whose fault that is.
    const lines: string[] = [
        '---',
        `Title: ${yamlScalar(title)}`,
        'Document Info:',
        `    Author: ${yamlScalar(author)}`,
        `    Date: "${date}"`,
        `    Revision: ${revision}`,
        `    Status: ${yamlScalar(status)}`,
        'Revisions:',
        `    - {Revision: ${revision}, Date: "${date}", Author: ${yamlScalar(author, { flow: true })}, Remarks: ${yamlScalar(remarks, { flow: true })}}`,
        `Revisions Visible: ${a.revisionsVisible ?? 3}`,
        `Theme: ${yamlScalar(a.theme ?? 'default')}`,
        `Style: ${yamlScalar(a.style ?? 'Navy')}`,
        'Header:',
        'Footer:',
        `Mode: ${a.mode ?? 'pdf, html'}`,
    ];

    // Optional keys are emitted only when answered, so a wizard that asked three
    // questions produces the same short scaffold `--init` always did rather than
    // a wall of defaults the author then has to read and delete.
    const maybe = (key: string, value: string | number | boolean | undefined): void => {
        if (value === undefined || value === '' || value === false) return;
        lines.push(`${key}: ${typeof value === 'string' ? yamlScalar(value) : String(value)}`);
    };
    maybe('Lang',             a.lang);
    maybe('Page Size',        a.pageSize);
    maybe('Orientation',      a.orientation);
    maybe('Margins',          a.margins);
    maybe('Classification',   a.classification);
    maybe('Watermark',        a.watermark);
    maybe('Numbered Headings', a.numberedHeadings);
    maybe('Running Header',   a.runningHeader);
    maybe('List of Tables',   a.listOfTables);
    maybe('List of Figures',  a.listOfFigures);
    maybe('Code Line Numbers', a.codeLineNumbers);
    maybe('TOC Depth',        a.tocDepth);

    lines.push(
        '# Cover Logo:',
        '#     - Path: assets/logo.png',
        "#     - Background: '#ffffff'",
        '---',
        '',
        '',
    );
    return lines.join('\n');
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

export function escHtml(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Image spec parser ─────────────────────────────────────────────────────────

export function parseImageSpec(spec: string | null | undefined): { src: string | null; position: number } {
    if (!spec) return { src: null, position: 0.5 };

    const match = spec.match(/^(.+?)\s+position:\s*([\d.]+)%\s*$/i);
    if (match)
        return { src: match[1].trim(), position: (100 - parseFloat(match[2])) / 100 };

    return { src: spec.trim(), position: 0.5 };
}

// ── Frontmatter extraction ────────────────────────────────────────────────────

/**
 * Reads a document's frontmatter.
 *
 * @param source Content to parse instead of reading `markdownFile` from disk.
 *               Lets the caller extract from pending source updates that have
 *               not been committed yet — the export must see today's stamped
 *               revision date even though the file is only written once the
 *               export has succeeded.
 */
export function extractFrontmatter(markdownFile: string | null, source?: string): FrontmatterData {
    const empty: FrontmatterData = {
        title: '', documentInfo: [], revisions: [], revisionsVisible: 3,
        revision: null, status: null, author: null, date: null,
        header: null, footer: null, lang: 'en', mode: null, theme: null,
        style: null, logo: null, coverLogo: null,
        numberedHeadings: false, runningHeader: false,
        listOfTables: false, listOfFigures: false,
        watermark: null, codeLineNumbers: false, trademarkSymbols: false, classification: null,
        variables: {}, tocDepth: null, pdfVariant: null, pageSize: null, margins: null,
        orientation: 'portrait',
        coverPage: true, footerLogo: null, coverSlogan: null,
        coverAddress: null, coverFooterLogo: null, coverTitleColor: null,
    };

    if (!markdownFile) return empty;
    if (source === undefined && !fs.existsSync(markdownFile)) return empty;

    const { attributes } = frontMatter(source ?? fs.readFileSync(markdownFile, 'utf8'));
    const at   = reader(attributes);
    const info = (at('Document Info') ?? {}) as Record<string, unknown>;
    const atInfo = reader(info);

    const rawVisible = parseInt(String(at('Revisions Visible') ?? 3), 10);
    // Non-numeric values (e.g. "all") would otherwise become NaN and silently
    // hide the revision table — fall back to the default instead.
    const revisionsVisible = Number.isNaN(rawVisible) ? 3 : rawVisible;

    const documentInfo: DocumentInfoEntry[] = Object.entries(info).map(([label, value]) => ({
        label,
        value: value != null ? `${value}` : '',
    }));

    const rawRevisions = (at('Revisions') ?? []) as unknown[];
    const revisions: RevisionEntry[] = (Array.isArray(rawRevisions) ? rawRevisions : [])
        .map(entry => {
            const r = reader(entry);
            return {
                revision: `${r('Revision') ?? ''}`,
                date:     `${r('Date')     ?? ''}`,
                author:   `${r('Author')   ?? ''}`,
                remarks:  `${r('Remarks')  ?? ''}`,
            };
        });

    // One rule, shared with the include path — see `resolveRevision`.
    const revision = resolveRevision(attributes);
    const date     = atInfo('Date')     ?? at('Date');
    const author   = atInfo('Author')   ?? at('Author');
    const status   = atInfo('Status')   ?? at('Status');

    // Theme selects the brand package (a simple name); resolved in index.ts.
    const themeRaw = at('Theme');
    const theme = themeRaw ? String(themeRaw) : null;

    // Style selects the per-document cover variant: a named style or an inline
    // { Color, Image, Position } object.
    const style = (() => {
        const raw = at('Style') as string | RawStyleObject | undefined;
        if (!raw) return null;
        if (typeof raw === 'string') return raw;

        const rawPos = raw.Position ?? raw.position ?? null;
        let position: number | null = null;
        if (rawPos != null) {
            const str = String(rawPos).trim().replace(/%$/, '');
            const val = parseFloat(str);
            if (!isNaN(val)) {
                // Accept percentage (>1) or fraction (0–1); convert to sharp crop offset
                // using the same convention as parseImageSpec: (100 - pct) / 100
                position = val > 1 ? (100 - val) / 100 : 1 - val;
            }
        }

        const rawOverlay = raw.Overlay ?? raw.overlay ?? null;
        let overlay: [number, number] | null = null;
        if (Array.isArray(rawOverlay) && rawOverlay.length === 2) {
            const [start, end] = rawOverlay.map(Number);
            if (!isNaN(start) && !isNaN(end)) overlay = [start, end];
        }

        return {
            name:     raw.Name  ?? raw.name  ?? null,
            color:    raw.Color ?? raw.color ?? null,
            image:    raw.Image ?? raw.image ?? null,
            position,
            overlay,
        } as StyleFrontmatter;
    })();

    return {
        title:  (at('Title') as string) ?? '',
        documentInfo,
        revisions,
        revisionsVisible,
        revision,
        status:   status   != null ? `${status}`   : null,
        author:   author   != null ? `${author}`   : null,
        date:     date     != null ? `${date}`     : null,
        header:   (at('Header') as string) ?? null,
        footer:   (at('Footer') as string) ?? null,
        lang:     (at('Lang')   as string) ?? 'en',
        mode: (() => {
            const raw = at('Mode') ?? '';
            const str = Array.isArray(raw) ? raw.join(',') : String(raw);
            return str.toLowerCase().replace(/\s+/g, '') || null;
        })(),
        theme,
        style,
        logo: (() => {
            const raw = at('Logo');
            const str = raw == null ? '' : String(raw).trim();
            return str || null;
        })(),
        coverLogo: parseCoverLogo(at('Cover Logo')),
        numberedHeadings: parseBool(at('Numbered Headings')),
        runningHeader:    parseBool(at('Running Header')),
        listOfTables:     parseBool(at('List of Tables')),
        listOfFigures:    parseBool(at('List of Figures')),
        codeLineNumbers:  parseBool(at('Code Line Numbers')),
        trademarkSymbols: parseBool(at('Trademark Symbols')),
        watermark:        parseWatermark(at('Watermark'), status != null ? `${status}` : null),
        classification:   parseClassification(at('Classification')),
        variables:        parseVariables(at('Variables')),
        tocDepth:         parseTocDepth(at('TOC Depth')),
        pdfVariant:       parsePdfVariant(at('PDF Variant')),
        pageSize:         parsePageSize(at('Page Size')),
        margins:          parseMargins(at('Margins')),
        orientation:      parseOrientation(at('Orientation')),
        coverPage:        parseOverride(at('Cover Page')) !== false,
        footerLogo:       parseOverride(at('Footer Logo')),
        coverSlogan:      parseOverride(at('Cover Slogan')),
        coverAddress:     parseOverrideLines(at('Cover Address')),
        coverFooterLogo:  parseOverride(at('Cover Footer Logo')),
        // Both spellings, because the rest of the vocabulary is British-agnostic
        // and a silently-ignored colour key is a miserable thing to debug.
        coverTitleColor:  (() => {
            const raw = at('Cover Title Color', 'Cover Title Colour');
            const str = raw == null ? '' : String(raw).trim();
            return str || null;
        })(),
    };
}

// ── Frontmatter date updater ──────────────────────────────────────────────────

function formatDate(d: Date): string {
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dy}`;
}

function statusFromYaml(yaml: string): string | null {
    // Matches "Status:" or "status:" at any indentation and returns the trimmed value
    const m = yaml.match(/^[ \t]*(?:Status|status)\s*:\s*([^\n\r]+)/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Where the last `- ` item of the `Revisions:` block sits, or null if there is none. */
interface RevisionItemPosition {
    /** Index of the line the item starts on. */
    index: number;
    /** Its indentation, which bounds the item's own child lines. */
    indent: number;
}

/**
 * Finds the last entry in the `Revisions:` block.
 *
 * Both writers need exactly this — the date stamper to locate the `Date:` it
 * rewrites, the bumper to locate where a new entry is appended — and each
 * carried its own byte-identical copy of the scan. Two copies of a YAML block
 * walk is two places for the indentation rules to drift apart.
 *
 * The rules: the block starts at a `Revisions:` key; a line indented less than
 * that key has left it; a line at exactly that indent leaves it too unless it is
 * a list item, because a sequence may be written flush with its key.
 */
function locateLastRevisionItem(lines: string[]): RevisionItemPosition | null {
    let inRevisions     = false;
    let revisionsIndent = -1;
    let found: RevisionItemPosition | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inRevisions) {
            const m = line.match(/^(\s*)(?:Revisions|revisions)\s*:/);
            if (m) { inRevisions = true; revisionsIndent = m[1].length; }
            continue;
        }

        const trimmed = line.trimStart();
        if (trimmed === '') continue;
        const lineIndent = line.length - trimmed.length;

        // List items at the same indent as "Revisions:" are still inside the block
        if (lineIndent < revisionsIndent) break;
        if (lineIndent === revisionsIndent && !trimmed.startsWith('- ') && trimmed !== '-') break;

        if (trimmed.startsWith('- ') || trimmed === '-') {
            found = { index: i, indent: lineIndent };
        }
    }

    return found;
}

function updateLastRevisionDate(lines: string[], date: string): void {
    const last = locateLastRevisionItem(lines);
    if (!last) return;

    const { index: lastItemIdx, indent: lastItemIndent } = last;

    // If Date appears on the item line itself (inline flow or Date-first block), update it there
    const itemLine = lines[lastItemIdx];
    if (/(Date|date)\s*:/.test(itemLine)) {
        lines[lastItemIdx] = itemLine.replace(
            /((?:Date|date)\s*:\s*)("?)([^,"'}]*)("?)/,
            (_, prefix, openQ, _val, closeQ) => `${prefix}${openQ}${date}${closeQ}`,
        );
        return;
    }

    // Date is on its own indented line (standard block mapping)
    for (let i = lastItemIdx + 1; i < lines.length; i++) {
        const line    = lines[i];
        const trimmed = line.trimStart();
        if (trimmed === '') continue;
        const lineIndent = line.length - trimmed.length;

        if (lineIndent <= lastItemIndent) break;         // left this item

        if (/(Date|date)\s*:/.test(line)) {
            lines[i] = line.replace(
                /((?:Date|date)\s*:\s*)("?)([^,"'}]*)("?)/,
                (_, prefix, openQ, _val, closeQ) => `${prefix}${openQ}${date}${closeQ}`,
            );
            return;
        }
    }
}

/**
 * Stamps today's date on the last `Revisions` entry, returning the new content.
 *
 * Pure: it takes and returns a string rather than reading and writing the file.
 * The caller decides *when* the result reaches disk — which matters, because
 * the source belongs to the principal and a failed export has no business
 * having edited it. Content is returned unchanged when there is no frontmatter,
 * when `Status` is neither "Work In Progress" nor "Released", or when the date
 * is already today's (so a second run in the same day is a no-op).
 *
 * @param today Injectable for tests; defaults to now.
 */
export function stampRevisionDate(content: string, today: Date = new Date()): string {
    const parsed = frontMatter(content);
    if (!parsed.frontmatter) return content;

    const status = statusFromYaml(parsed.frontmatter);
    // `isReleasedStatus` rather than a literal "released": it is the one place
    // that knows the released vocabulary is bilingual (Vrijgegeven), and a
    // document that suppresses its watermark for being released must also get
    // its revision date stamped. Three checks spelled three ways is how a Dutch
    // document ended up with no watermark, no date stamp and no bump.
    if (status?.toLowerCase() !== 'work in progress' && !isReleasedStatus(status ?? null)) return content;

    const lines = parsed.frontmatter.split('\n');
    updateLastRevisionDate(lines, formatDate(today));

    const newYaml = lines.join('\n');
    if (newYaml === parsed.frontmatter) return content;

    return `---\n${newYaml}\n---\n${parsed.body}`;
}

// ── Revision bumper ───────────────────────────────────────────────────────────

function incrementRevision(rev: string): string {
    // Pure integer: "1" → "2"
    if (/^\d+$/.test(rev)) return String(parseInt(rev, 10) + 1);
    // Single letter A-Y / a-y: "A" → "B"
    if (/^[A-Ya-y]$/.test(rev)) return String.fromCharCode(rev.charCodeAt(0) + 1);
    // Trailing integer: "Rev1" → "Rev2", "1.0" → "1.1"
    if (/\d+$/.test(rev)) return rev.replace(/(\d+)$/, (_, n) => String(parseInt(n, 10) + 1));
    // Fallback: append ".1"
    return `${rev}.1`;
}

/** Find where the last Revisions list item ends; returns [lastItemIdx, lastItemEndIdx, isInline] */
function findLastRevisionItem(lines: string[]): [number, number, boolean] {
    const last = locateLastRevisionItem(lines);
    if (!last) return [-1, -1, false];

    const { index: lastItemIdx, indent: lastItemIndent } = last;

    const isInline = /^\s*-\s*\{/.test(lines[lastItemIdx]);
    if (isInline) return [lastItemIdx, lastItemIdx, true];

    // Block item: scan forward until we leave its indentation
    let lastItemEndIdx = lastItemIdx;
    for (let i = lastItemIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed === '') continue;
        if (lines[i].length - trimmed.length <= lastItemIndent) break;
        lastItemEndIdx = i;
    }
    return [lastItemIdx, lastItemEndIdx, false];
}

/**
 * A YAML double-quoted scalar.
 *
 * Only `\` and `"` need escaping inside one; every other character — a colon, a
 * comma, a brace, a leading dash — is ordinary text once it is quoted, which is
 * the whole point. An empty value stays `""` rather than becoming YAML's null.
 *
 * Exported for testing.
 */
export function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * YAML's reserved words, which must be quoted to stay strings.
 *
 * `Status: No` is a status, not the boolean false — and a document whose author
 * is called `Yes` is silly but not impossible.
 */
const YAML_KEYWORDS = /^(?:true|false|null|yes|no|on|off|~)$/i;

/**
 * A scalar written bare when that is safe, and quoted when it is not.
 *
 * {@link yamlQuote} always quotes, which is right where it is used — an author
 * carried over into an appended revisions row — and wrong for the `--init`
 * scaffold, which people read as documentation. Quoting all of it would turn
 * every line of an example into `Title: "Document Title"` for the benefit of the
 * rare value that needs it.
 *
 * `flow` tightens the rules for a value inside an inline `{…}` mapping, where
 * `,` and `}` end the scalar as well.
 */
export function yamlScalar(value: string, { flow = false } = {}): string {
    const unsafe =
        value === '' ||
        value !== value.trim() ||                       // leading/trailing space is lost bare
        /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||        // a YAML indicator opens the value
        /:\s/.test(value) || value.endsWith(':') ||     // reads as a nested mapping
        /\s#/.test(value) ||                            // starts a comment
        YAML_KEYWORDS.test(value) ||
        /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) ||  // number-like
        (flow && /[,{}[\]]/.test(value));
    return unsafe ? yamlQuote(value) : value;
}

/**
 * Sets the `Remarks` of the LAST revisions row — the one being released.
 *
 * The outgoing revision, deliberately: `--release` appends a fresh row for the
 * *next* revision, so the row describing the work being signed off is the one
 * that is already there. That is also the row the cover's revision table shows,
 * and `appendRevisionEntry` leaves the new one's remarks empty on purpose —
 * nothing has happened in it yet.
 *
 * Must run BEFORE `appendRevisionEntry`, or it would fill in the new empty row
 * instead of the one it means.
 *
 * Both frontmatter shapes are handled, and the key's existing casing is kept:
 * a document written in lowercase stays lowercase. A row with no `Remarks` key
 * at all gains one rather than being left unchanged.
 *
 * Exported for testing.
 */
export function setLastRevisionRemarks(lines: string[], note: string): boolean {
    const [lastItemIdx, lastItemEndIdx, isInline] = findLastRevisionItem(lines);
    if (lastItemIdx === -1) return false;

    if (isInline) {
        const line = lines[lastItemIdx];
        // Bounded by `,` and `}` because that is where a flow scalar ends.
        const existing = /(\bremarks\s*:\s*)([^,}]*)/i.exec(line);
        const value = yamlScalar(note, { flow: true });
        if (existing) {
            lines[lastItemIdx] = line.replace(/(\bremarks\s*:\s*)([^,}]*)/i,
                                              literal(`${existing[1]}${value}`));
        } else {
            // No Remarks key: add one just inside the closing brace.
            const usesCap = /[A-Z]/.test(line.replace(/^[\s-{]*/, '').charAt(0));
            lines[lastItemIdx] = line.replace(/\}\s*$/,
                                              literal(`, ${usesCap ? 'Remarks' : 'remarks'}: ${value}}`));
        }
        return true;
    }

    const value = yamlScalar(note);
    for (let i = lastItemIdx; i <= lastItemEndIdx; i++) {
        const m = /^(\s*(?:-\s*)?)(remarks\s*:\s*)(.*)$/i.exec(lines[i]);
        if (!m) continue;
        lines[i] = `${m[1]}${m[2].replace(/\s*$/, ' ')}${value}`.replace(/:\s+/, ': ');
        return true;
    }

    // No Remarks key in a block item — append one at the item's own indentation.
    const first = lines[lastItemIdx];
    const childIndent = ' '.repeat(first.length - first.trimStart().length + 2);
    const usesCap = /[A-Z]/.test(first.replace(/^[\s-]*/, '').charAt(0));
    lines.splice(lastItemEndIdx + 1, 0, `${childIndent}${usesCap ? 'Remarks' : 'remarks'}: ${value}`);
    return true;
}

function appendRevisionEntry(lines: string[], newRevision: string, author: string, date: string): void {
    const [lastItemIdx, lastItemEndIdx, isInline] = findLastRevisionItem(lines);
    if (lastItemIdx === -1) return;

    const itemLine     = lines[lastItemIdx];
    const lastIndent   = itemLine.length - itemLine.trimStart().length;
    const indent       = ' '.repeat(lastIndent);
    const childIndent  = ' '.repeat(lastIndent + 2);

    // Match key casing of existing entry
    const usesCap = /[A-Z]/.test(itemLine.replace(/^[\s-{]*/, '').charAt(0));
    const R = usesCap ? 'Revision' : 'revision';
    const D = usesCap ? 'Date'     : 'date';
    const A = usesCap ? 'Author'   : 'author';
    const K = usesCap ? 'Remarks'  : 'remarks';

    // The author is free text carried over from the previous entry, and it is
    // the one field here that a person's actual name can break: a `:` (a title,
    // a department), a leading `{`, `[`, `#` or `-`, or a `,` or `}` inside the
    // inline form, all mean something to YAML. Unquoted, that does not produce a
    // wrong author — it produces a document whose frontmatter no longer parses,
    // on the export that cut the release. The date was already quoted; the
    // revision is a version token and stays bare so appended rows keep the shape
    // every document already has.
    const quotedAuthor = yamlQuote(author);

    const newEntry = isInline
        ? `${indent}- {${R}: ${newRevision}, ${D}: "${date}", ${A}: ${quotedAuthor}, ${K}: }`
        : `${indent}- ${R}: ${newRevision}\n${childIndent}${D}: "${date}"\n${childIndent}${A}: ${quotedAuthor}\n${childIndent}${K}: `;

    lines.splice(lastItemEndIdx + 1, 0, newEntry);
}

/**
 * Called after all exports complete when Status is released ("Released" or
 * "Vrijgegeven" — see {@link isReleasedStatus}):
 * - Appends a new Revisions entry (next revision, today's date, same author, empty remarks)
 * - Updates every Revision: scalar in the frontmatter to the new value
 * - Resets every Status: scalar to "Work In Progress" so subsequent exports don't bump again
 *
 * The reset is always the English "Work In Progress", including for a document
 * that said "Vrijgegeven": that is the status the README documents, and there
 * is no documented Dutch spelling of the in-progress state to reset to.
 *
 * @returns the content written, or null when nothing was — `--watch` uses it to
 *          tell an export's own write apart from an edit.
 */
export function bumpRevisionAfterExport(
    markdownFile: string,
    fm: FrontmatterData,
    expectedContent?: string | null,
    releaseNote?: string | null,
): string | null {
    if (!isReleasedStatus(fm.status)) return null;
    if (!fs.existsSync(markdownFile)) return null;

    const lastRevEntry = fm.revisions.at(-1);
    if (!lastRevEntry) {
        log('WARNING: Status is Released but no Revisions entries found — skipping revision bump');
        return null;
    }

    const nextRev = incrementRevision(lastRevEntry.revision);
    const author  = lastRevEntry.author || fm.author || '';
    const today   = formatDate(new Date());

    const content = fs.readFileSync(markdownFile, 'utf8');

    // The same compare-and-swap `prepareSourceUpdates` does, and here it guards
    // something worse than a date. `fm` was parsed at the start of the export; if
    // another process has bumped the document since, this one would append a
    // SECOND row for a revision that already exists and reset the status again,
    // using numbers read from content that is no longer on disk.
    if (expectedContent != null && content !== expectedContent) {
        // Spelled out, and pointed at the usual cause. A skipped *date stamp* is
        // a convenience the next export repeats; a skipped *release bump* is the
        // thing you asked for not happening, and the one-line version of this
        // read as noise — so the release you thought you cut silently was not.
        log('WARNING: The source document changed during the export — the release was NOT cut.\n' +
            `  No Revisions row was appended and the revision was not bumped.\n${CONCURRENT_EXPORT_HINT}\n` +
            '  Re-run with --release once nothing else is exporting this document.');
        return null;
    }

    const parsed  = frontMatter(content);
    if (!parsed.frontmatter) return null;

    const lines = parsed.frontmatter.split('\n');

    // Before the append, never after: this fills in the row being RELEASED, and
    // after `appendRevisionEntry` the last row is the new empty one instead.
    if (releaseNote != null && releaseNote.trim() !== '') {
        if (setLastRevisionRemarks(lines, releaseNote.trim()))
            log(`Release note recorded on revision ${lastRevEntry.revision}`);
    }

    appendRevisionEntry(lines, nextRev, author, today);
    let yaml = lines.join('\n');

    // Replace every Status: value (top-level or nested, quoted or bare)
    yaml = yaml.replace(
        /^(\s*(?:Status|status)\s*:\s*)(["']?).*\2$/gm,
        `$1$2Work In Progress$2`,
    );

    // Replace every Revision: scalar. History rows are excluded by the pattern
    // itself: `^\s*` cannot match the `-` that starts a list item, so a
    // `- Revision: 2` line never matches in the first place. `Document Info`'s
    // nested Revision, being a plain indented key, is updated on purpose.
    yaml = yaml.replace(
        /^(\s*(?:Revision|revision)\s*:\s*)(["']?).*\2$/gm,
        (_match, prefix: string, q: string) => `${prefix}${q}${nextRev}${q}`,
    );

    const updated = `---\n${yaml}\n---\n${parsed.body}`;
    writeFileAtomic(markdownFile, updated);
    log(`Bumped revision: ${lastRevEntry.revision} → ${nextRev}, status reset to Work In Progress`);
    // Returned so `--watch` can recognise this write as its own.
    return updated;
}

// ── Cover logo spec parser ─────────────────────────────────────────────────

function normalizeColor(value: string): string {
    return value.trim().replace(/;$/, '');
}

function parseCoverLogo(raw: unknown): CoverLogoSpec | null {
    if (!raw) return null;

    // Plain string: Cover Logo: path/to/logo.png
    if (typeof raw === 'string') return { path: raw, background: null };

    // Array of single-key objects:
    //   Cover Logo:
    //     - Path: ...
    //     - Background: '#454545'
    if (Array.isArray(raw)) {
        const merged = Object.assign({}, ...raw) as Record<string, string>;
        const path = merged.Path ?? merged.path ?? null;
        if (!path) return null;
        const bg = merged.Background ?? merged.background ?? null;
        return {
            path,
            background: bg ? normalizeColor(bg) : null,
        };
    }

    return null;
}
