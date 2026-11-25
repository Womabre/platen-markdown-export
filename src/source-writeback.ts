/**
 * Source write-back: every edit an export makes to the source document.
 *
 * The source document belongs to its author, and this module is the only code
 * that writes to it (see GLOSSARY.md). Two kinds of edit:
 *
 *   - on any export: markdown-it-attrs syntax stripped from auto-generated TOC
 *     links, and, when Status is Work In Progress or released, today's date
 *     stamped on the last revision row;
 *   - on a release (`--release` on a document whose Status is released): the
 *     release note recorded on the outgoing revision row, a new revision row,
 *     and the document's own `Revision` moved on and `Status` reset to Work In
 *     Progress (top level and directly under Document Info; existing revision
 *     rows keep their numbers).
 *
 * Three rules hold for all of them, and they are why this is one module:
 *
 *   - **Only what the document says.** The writer parses the document's own
 *     frontmatter. It never sees the export's view, which has the config's
 *     `frontmatterDefaults` applied, so a default can never be written in.
 *   - **Keys match the way the reader matches them**, in any casing, and keep
 *     the document's own spelling when rewritten.
 *   - **One baseline.** The handle remembers what it last read or wrote, and
 *     every write first checks the file still holds exactly that. If another
 *     process changed it in the meantime, the write is skipped with a warning
 *     rather than overwriting someone's edit.
 *
 * Timing belongs to the caller, through two events: `outputLanded()` (the first
 * output is on disk, which earns the date stamp) and `allOutputsLanded()` (every
 * output is on disk, which is when a release is cut, so all of them carry the
 * pre-release revision).
 */
import * as fs from 'fs';
import frontMatter from 'front-matter';
import { writeFileAtomic } from './fsutil';
import { log } from './logger';
import { literal } from './strings';
import { isReleasedStatus, reader, yamlQuote, yamlScalar } from './frontmatter';
import { cleanTocAttrs } from './markdown';

/** How a source document may be written during one export. */
export interface SourceWriteBackOptions {
    /** False under `--no-bump`: the handle reads the document but never writes it. */
    writes: boolean;
    /** `--release`: cut a release once every output has landed. */
    release: boolean;
    /** `--release-note`: the Remarks for the revision being released. */
    note: string | null;
    /** The date to stamp. Injectable for tests; defaults to now. */
    today?: Date;
}

/** One export's view of its source document. */
export interface SourceDocument {
    /**
     * The text the export renders: the document with today's stamp and the TOC
     * cleanup already applied when `writes` is set, so the output and the file
     * it is about to become agree. The original text under `--no-bump`.
     */
    readonly content: string;
    /** The first output is on disk: write the date stamp and TOC cleanup. Later calls do nothing. */
    outputLanded(): void;
    /** Every output is on disk: cut the release, if one was asked for and is possible. Runs `outputLanded()` first. */
    allOutputsLanded(): void;
    /** The content this handle last wrote, or null. `--watch` compares it with the file to tell its own write from an edit. */
    readonly written: string | null;
}

// ── Date stamp ────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dy}`;
}

function statusFromYaml(yaml: string): string | null {
    // Matches "Status:" or "status:" at any indentation and returns the trimmed value
    const m = yaml.match(/^[ \t]*status\s*:\s*([^\n\r]+)/im);
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
            const m = line.match(/^(\s*)revisions\s*:/i);
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
    if (/\bdate\s*:/i.test(itemLine)) {
        lines[lastItemIdx] = itemLine.replace(
            /(\bdate\s*:\s*)("?)([^,"'}]*)("?)/i,
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

        if (/\bdate\s*:/i.test(line)) {
            lines[i] = line.replace(
                /(\bdate\s*:\s*)("?)([^,"'}]*)("?)/i,
                (_, prefix, openQ, _val, closeQ) => `${prefix}${openQ}${date}${closeQ}`,
            );
            return;
        }
    }
}

/**
 * The document after its closing frontmatter delimiter, byte for byte.
 *
 * Not `frontMatter(content).body` on its own: the library matches the closing
 * delimiter with `\s*$` under the `m` flag, and `\s` spans newlines, so the
 * blank line between `---` and the first heading is swallowed into the match
 * and dropped from `body`. Rebuilding the file from that body deleted the
 * blank line on every date stamp and every revision bump. The swallowed text
 * is recovered from the original: everything after the closing delimiter's
 * own line break belongs to the body.
 */
function verbatimBody(content: string, body: string): string {
    if (!content.endsWith(body)) return body;
    const header = content.slice(0, content.length - body.length);
    const delimiter = /(?:^|\n)(?:---|\.\.\.|= yaml =)[^\S\r\n]*(?:\r?\n|$)/g;
    let end = header.length;
    for (let m = delimiter.exec(header); m; m = delimiter.exec(header)) end = m.index + m[0].length;
    return header.slice(end) + body;
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
function stampRevisionDate(content: string, today: Date = new Date()): string {
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

    return `---\n${newYaml}\n---\n${verbatimBody(content, parsed.body)}`;
}

// ── Revision rows ─────────────────────────────────────────────────────────────

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
 * How a key missing from a revisions row should be spelled, so a key the
 * exporter adds matches the row's own style: `REMARKS` beside `REVISION`,
 * `Remarks` beside `Revision`, `remarks` beside `revision`. Judged by the row's
 * first key.
 */
function inRowStyle(rowLine: string, name: string): string {
    const first = /^[\s-{]*([A-Za-z]+)/.exec(rowLine)?.[1] ?? '';
    if (first.length > 1 && first === first.toUpperCase()) return name.toUpperCase();
    return /^[A-Z]/.test(first) ? name.charAt(0).toUpperCase() + name.slice(1) : name.toLowerCase();
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
 */
function setLastRevisionRemarks(lines: string[], note: string): boolean {
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
            lines[lastItemIdx] = line.replace(/\}\s*$/,
                                              literal(`, ${inRowStyle(line, 'remarks')}: ${value}}`));
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
    lines.splice(lastItemEndIdx + 1, 0, `${childIndent}${inRowStyle(first, 'remarks')}: ${value}`);
    return true;
}

function appendRevisionEntry(lines: string[], newRevision: string, author: string, date: string): void {
    const [lastItemIdx, lastItemEndIdx, isInline] = findLastRevisionItem(lines);
    if (lastItemIdx === -1) return;

    const itemLine     = lines[lastItemIdx];
    const lastIndent   = itemLine.length - itemLine.trimStart().length;
    const indent       = ' '.repeat(lastIndent);
    const childIndent  = ' '.repeat(lastIndent + 2);

    // The new row spells each key the way the row before it does (`Revision`,
    // `revision`, `REVISION`), so the document keeps one style. A key that row
    // lacks follows the row's style (see `inRowStyle`).
    const itemText = lines.slice(lastItemIdx, lastItemEndIdx + 1).join('\n');
    const spelled  = (name: string): string =>
        new RegExp(`\\b(${name})\\s*:`, 'i').exec(itemText)?.[1] ?? inRowStyle(itemLine, name);
    const R = spelled('revision');
    const D = spelled('date');
    const A = spelled('author');
    const K = spelled('remarks');

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

// ── Releasing ─────────────────────────────────────────────────────────────────

/**
 * Why this document cannot be released, or null when it can.
 *
 * Asked when the handle opens, so the warning comes before the export rather
 * than after it: a release you asked for and will not get should not be news
 * at the end of a long render.
 */
function releaseRefusal(content: string): string | null {
    const own    = reader(frontMatter(content).attributes);
    const status = reader(own('Document Info'))('Status') ?? own('Status');
    const text   = status != null ? `${status}` : null;
    if (!isReleasedStatus(text))
        return `WARNING: --release given, but Status is ${text ? `"${text}"` : 'not set'} — ` +
               'nothing to release. Set Status: Released (or Vrijgegeven) first.';

    const rows = own('Revisions');
    if (!Array.isArray(rows) || rows.length === 0)
        return 'WARNING: Status is Released but no Revisions entries found — skipping revision bump';

    return null;
}

/** A release, computed: the new content and what it did. */
interface ReleaseEdit {
    content: string;
    from: string;
    to: string;
    noteRecorded: boolean;
}

/**
 * The release edits applied to `content`, or null when it has nothing to release:
 *
 * - the release note set as the Remarks of the outgoing revision row;
 * - a new Revisions row: the next revision, today's date, the outgoing row's
 *   author (or the document's own Author), empty remarks;
 * - the document's `Revision` moved to the new value and its `Status` reset to
 *   "Work In Progress", so a second `--release` finds nothing to release (see
 *   {@link moveDocumentScalars} for exactly which keys).
 *
 * The reset is always the English "Work In Progress", including for a document
 * that said "Vrijgegeven": that is the status the README documents, and there
 * is no documented Dutch spelling of the in-progress state to reset to.
 *
 * Everything is read from `content` itself. The author fallback in particular
 * must not come from the export's frontmatter, which has `frontmatterDefaults`
 * applied: a default is not something the document said.
 */
function releaseEdit(content: string, note: string | null, today: Date): ReleaseEdit | null {
    const parsed = frontMatter(content);
    if (!parsed.frontmatter) return null;

    const own  = reader(parsed.attributes);
    const rows = own('Revisions');
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const last      = reader(rows.at(-1));
    const from      = `${last('Revision') ?? ''}`;
    const to        = incrementRevision(from);
    const ownAuthor = reader(own('Document Info'))('Author') ?? own('Author');
    const author    = `${last('Author') ?? ''}` || (ownAuthor != null ? `${ownAuthor}` : '');

    const lines = parsed.frontmatter.split('\n');

    // Before the append, never after: this fills in the row being RELEASED, and
    // after `appendRevisionEntry` the last row is the new empty one instead.
    const noteRecorded = note != null && note.trim() !== ''
        ? setLastRevisionRemarks(lines, note.trim())
        : false;

    appendRevisionEntry(lines, to, author, formatDate(today));
    moveDocumentScalars(lines, to);

    return { content: `---\n${lines.join('\n')}\n---\n${verbatimBody(content, parsed.body)}`, from, to, noteRecorded };
}

/**
 * Resets `Status` to Work In Progress and moves `Revision` to `to`, in place,
 * wherever the reader looks for them: as top-level keys and as direct children
 * of `Document Info`. Any key casing; quotes kept.
 *
 * Nowhere else. A pattern over every indented `Revision:` line also hit the
 * history: in a block row whose Revision is not its first key (`- Date: ...`
 * then `Revision: 1`) that line is a plain indented key, so every row in the
 * document took the new number. A `Variables` entry that happens to be called
 * Status or Revision is the author's own text and is left alone too.
 */
function moveDocumentScalars(lines: string[], to: string): void {
    const move = (line: string): string => line
        .replace(/^(\s*status\s*:\s*)(["']?).*\2$/i, '$1$2Work In Progress$2')
        .replace(/^(\s*revision\s*:\s*)(["']?).*\2$/i,
                 (_match, prefix: string, q: string) => `${prefix}${q}${to}${q}`);

    let block: string | null = null;    // the top-level key whose block we are in
    let childIndent = -1;               // the indent of that block's direct children
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const indent = lines[i].length - trimmed.length;

        if (indent === 0) {
            block = /^([^:]+?)\s*:/.exec(trimmed)?.[1].toLowerCase() ?? null;
            childIndent = -1;
            lines[i] = move(lines[i]);
            continue;
        }
        if (block !== 'document info') continue;
        if (childIndent === -1) childIndent = indent;
        if (indent === childIndent) lines[i] = move(lines[i]);
    }
}

// ── The handle ────────────────────────────────────────────────────────────────

/**
 * What to do about two exports racing for the same document.
 *
 * Both writes, the date stamp and the release, detect the same condition, and
 * share this advice so it is given wherever the condition is met.
 *
 * There is deliberately no lock file: a stale one would make the tool refuse to
 * export, which is a worse failure than doing the work twice.
 */
const CONCURRENT_EXPORT_HINT =
    '  Usually this means two exports ran at once — a --watch loop and the VS Code\n' +
    "  extension's export-on-save both watch the same file. Pick one: stop the watch,\n" +
    '  or set "Export On Save: false" in this document\'s frontmatter.';

// A skipped stamp is a convenience the next export repeats.
const STAMP_SKIPPED =
    'WARNING: The source document changed during the export — ' +
    'not writing the revision date, to avoid overwriting that change.\n' +
    `${CONCURRENT_EXPORT_HINT}\n` +
    '  The output is still correct; only this stamp was skipped, and the next ' +
    'export writes it.';

// A skipped release is the thing you asked for not happening, so it is spelled
// out: the one-line version read as noise, and the release you thought you cut
// silently was not.
const RELEASE_SKIPPED =
    'WARNING: The source document changed during the export — the release was NOT cut.\n' +
    `  No Revisions row was appended and the revision was not bumped.\n${CONCURRENT_EXPORT_HINT}\n` +
    '  Re-run with --release once nothing else is exporting this document.';

/**
 * Opens `file` for one export and returns its {@link SourceDocument}.
 *
 * Reads the file once. Nothing is written until the caller reports an output
 * landing, so a run that dies on a missing asset, or exports nothing at all,
 * leaves the document exactly as it found it. A release that cannot happen
 * (Status not released, no Revisions rows) is reported here, before the export.
 *
 * Throws what `fs.readFileSync` throws when the file cannot be read.
 */
export function openSourceDocument(file: string, opts: SourceWriteBackOptions): SourceDocument {
    const original = fs.readFileSync(file, 'utf8');
    const today    = opts.today ?? new Date();

    const dated   = opts.writes ? stampRevisionDate(original, today) : original;
    const updated = opts.writes ? cleanTocAttrs(dated) : original;
    const changes = [
        dated !== original  ? 'revision date' : '',
        updated !== dated   ? 'TOC link attributes' : '',
    ].filter(Boolean).join(' + ');

    let release = opts.writes && opts.release;
    if (release) {
        const refusal = releaseRefusal(original);
        if (refusal) { log(refusal); release = false; }
    }

    // What the file is expected to hold: what was read, then what was written.
    // Nothing serialises two exports of one document (`--watch` in one terminal
    // and a manual run in another, the extension exporting on save during a CLI
    // export), so every write is a compare-and-swap against this, never a blind
    // overwrite. Skipping costs a stamp or a release; clobbering costs an edit.
    let baseline = original;
    let written: string | null = null;
    let landed   = false;
    let released = false;

    const writeIfUnchanged = (next: string, refused: string): boolean => {
        let current: string;
        try { current = fs.readFileSync(file, 'utf8'); }
        catch { return false; }        // vanished mid-export; nothing to update
        if (current !== baseline) { log(refused); return false; }
        writeFileAtomic(file, next);
        baseline = next;
        written  = next;
        return true;
    };

    const outputLanded = (): void => {
        if (landed) return;
        landed = true;
        if (updated === original) return;
        if (writeIfUnchanged(updated, STAMP_SKIPPED)) log(`Updated source document (${changes})`);
    };

    const allOutputsLanded = (): void => {
        outputLanded();
        if (!release || released) return;
        released = true;
        const edit = releaseEdit(baseline, opts.note, today);
        if (!edit || !writeIfUnchanged(edit.content, RELEASE_SKIPPED)) return;
        if (edit.noteRecorded) log(`Release note recorded on revision ${edit.from}`);
        log(`Bumped revision: ${edit.from} → ${edit.to}, status reset to Work In Progress`);
    };

    return {
        content: updated,
        outputLanded,
        allOutputsLanded,
        get written() { return written; },
    };
}
