import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import frontMatter from 'front-matter';
import { openSourceDocument, type SourceWriteBackOptions } from '../source-writeback';
import { setQuiet, resetWarnings, warningCount } from '../logger';

/**
 * The source write-back, through its one interface: open a document, report
 * outputs landing, read the file back. Every edit the exporter makes to an
 * author's document is asserted here, on real files in a temp directory.
 */

setQuiet(true);

let dir: string;
let n = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-writeback-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => resetWarnings());

const TODAY = new Date(2026, 8, 2, 12);     // local 2026-09-02
const STAMP = '2026-09-02';

/** Writes `content` to a fresh file and returns its path. */
function file(content: string): string {
    const f = path.join(dir, `doc-${++n}.md`);
    fs.writeFileSync(f, content);
    return f;
}
const read = (f: string): string => fs.readFileSync(f, 'utf8');

/** Opens with sensible test defaults: writing, no release, a fixed date. */
function open(f: string, o: Partial<SourceWriteBackOptions> = {}) {
    return openSourceDocument(f, { writes: true, release: false, note: null, today: TODAY, ...o });
}

/** A document with one Revisions row, in block form. */
const doc = (status: string, { gap = '\n', eol = '\n', author = 'W' } = {}) => [
    '---',
    'Title: T',
    `Status: ${status}`,
    'Revisions:',
    '  - Revision: 1',
    '    Date: "2020-01-01"',
    `    Author: ${author}`,
    '---',
].join(eol) + eol + gap + '# T' + eol + eol + 'Text.' + eol;

/** A released document whose last row is written inline. */
const inlineDoc = (row: string) => `---\nTitle: T\nStatus: Released\nRevisions:\n${row}\n---\n\n# T\n`;

/** Opens, lands every output with a release, and returns the file. */
function release(content: string, note: string | null = null): string {
    const f = file(content);
    open(f, { release: true, note }).allOutputsLanded();
    return read(f);
}

const rows = (content: string) =>
    (frontMatter(content) as { attributes: Record<string, unknown> }).attributes.Revisions as Array<Record<string, unknown>>;

// ── What the export renders ───────────────────────────────────────────────────

describe('content: the text the export renders', () => {
    it('is stamped for work in progress and for both spellings of released', () => {
        for (const status of ['Work In Progress', 'work in progress', 'Released', 'Vrijgegeven']) {
            const s = open(file(doc(status)));
            assert.match(s.content, new RegExp(`Date: "${STAMP}"`), status);
        }
    });

    it('is not stamped for any other status', () => {
        for (const status of ['Final', 'Draft']) {
            const s = open(file(doc(status)));
            assert.match(s.content, /2020-01-01/, status);
        }
    });

    it('carries the TOC cleanup, and leaves a heading\'s own attribute alone', () => {
        const dirty = '# Doc\n\n- [Frontmatter \\& Cover Page {.page-break-before}](#frontmatter--cover-page-page-break-before)\n\n## Frontmatter & Cover Page {.page-break-before}\n';
        const s = open(file(dirty));
        assert.ok(s.content.includes('[Frontmatter \\& Cover Page](#frontmatter--cover-page)'));
        assert.ok(s.content.includes('## Frontmatter & Cover Page {.page-break-before}'));
    });

    it('is the original text when the handle may not write (--no-bump)', () => {
        const original = doc('Work In Progress');
        assert.equal(open(file(original), { writes: false }).content, original);
    });

    it('stamps a document whose keys are written in capitals', () => {
        const s = open(file(doc('Work In Progress').replace('Status:', 'STATUS:').replace('Revisions:', 'REVISIONS:')
                                                   .replace('Date:', 'DATE:')));
        assert.match(s.content, new RegExp(`DATE: "${STAMP}"`));
    });
});

// ── The date stamp ────────────────────────────────────────────────────────────

describe('outputLanded: the date stamp', () => {
    it('writes nothing until an output lands', () => {
        const original = doc('Work In Progress');
        const f = file(original);
        open(f);
        assert.equal(read(f), original);
    });

    it('writes what the export rendered, once, however many outputs land', () => {
        const f = file(doc('Work In Progress'));
        const s = open(f);
        s.outputLanded();
        assert.equal(read(f), s.content);
        assert.equal(s.written, s.content, 'written is the bytes on disk, for --watch');

        fs.writeFileSync(f, 'edited after the first output');
        s.outputLanded();
        assert.equal(read(f), 'edited after the first output', 'a second output does not write again');
    });

    it('writes nothing when there is nothing to change', () => {
        const original = doc('Draft');
        const f = file(original);
        const s = open(f);
        s.outputLanded();
        assert.equal(read(f), original);
        assert.equal(s.written, null);
    });

    it('writes nothing at all under --no-bump', () => {
        const original = doc('Released');
        const f = file(original);
        const s = open(f, { writes: false, release: true });
        s.allOutputsLanded();
        assert.equal(read(f), original);
        assert.equal(s.written, null);
        assert.equal(warningCount(), 0, 'and does not warn about a release it was never going to cut');
    });

    // The front-matter library swallows the blank lines after the closing
    // delimiter into its match; rebuilding from its `body` deleted them.
    for (const [label, gap] of [['one blank line', '\n'], ['two blank lines', '\n\n'], ['none', '']]) {
        it(`keeps ${label} after the frontmatter`, () => {
            const f = file(doc('Work In Progress', { gap }));
            open(f).outputLanded();
            const out = read(f);
            assert.match(out, new RegExp(STAMP));
            assert.ok(out.endsWith(`---\n${gap}# T\n\nText.\n`), JSON.stringify(out.slice(-30)));
        });
    }

    it('keeps a CRLF blank line too', () => {
        const f = file(doc('Work In Progress', { gap: '\r\n', eol: '\r\n' }));
        open(f).outputLanded();
        const out = read(f);
        assert.match(out, new RegExp(STAMP));
        assert.ok(out.endsWith('\r\n# T\r\n\r\nText.\r\n'), JSON.stringify(out.slice(-30)));
    });
});

// ── The release ───────────────────────────────────────────────────────────────

describe('allOutputsLanded: the release', () => {
    it('records the history: new row, revision moved on, status reset, old row kept', () => {
        const out = release(doc('Released'));
        const r = rows(out);
        assert.equal(r.length, 2);
        assert.equal(String(r[0].Revision), '1');
        assert.equal(r[0].Date, STAMP, 'the released row was stamped first');
        assert.equal(String(r[1].Revision), '2');
        assert.equal(r[1].Date, STAMP);
        assert.equal(r[1].Author, 'W');
        assert.match(out, /^Status: Work In Progress$/m);
    });

    it('stamps first, even when no output reported landing on its own', () => {
        const f = file(doc('Released'));
        const s = open(f, { release: true });
        s.allOutputsLanded();
        assert.equal(rows(read(f))[0].Date, STAMP);
        assert.equal(s.written, read(f));
    });

    it('releases once, however often it is told', () => {
        const f = file(doc('Released'));
        const s = open(f, { release: true });
        s.allOutputsLanded();
        s.allOutputsLanded();
        assert.equal(rows(read(f)).length, 2);
    });

    it('does nothing without --release', () => {
        const f = file(doc('Released'));
        open(f).allOutputsLanded();
        assert.equal(rows(read(f)).length, 1);
        assert.match(read(f), /Status: Released/);
    });

    it('keeps the blank line after the frontmatter', () => {
        assert.ok(release(doc('Released')).endsWith('---\n\n# T\n\nText.\n'));
    });

    it('survives an author whose name contains a colon', () => {
        // Unquoted, `Smith, John: PDM` is not a YAML scalar: the whole frontmatter
        // would stop parsing, on the export that cut the release.
        const r = rows(release(doc('Released', { author: '"Smith, John: PDM"' })));
        assert.equal(r.length, 2, 'frontmatter still parses');
        assert.equal(r[1].Author, 'Smith, John: PDM');
    });

    it('quotes the author it copies into the new row', () => {
        assert.match(release(doc('Released', { author: 'Jane Doe' })), /Author: "Jane Doe"/);
    });

    it('does the same inside the inline row form', () => {
        const r = rows(release(inlineDoc('  - {Revision: 1, Date: "2020-01-01", Author: "Smith, John: PDM", Remarks: first}')));
        assert.equal(r.length, 2, 'the flow mapping is still a mapping');
        assert.equal(r[1].Author, 'Smith, John: PDM');
    });

    it('spells the new row\'s keys the way the row before it does', () => {
        const out = release(inlineDoc('  - {REVISION: 1, DATE: "2020-01-01", AUTHOR: A, REMARKS: first}'));
        assert.match(out, /- \{REVISION: 2, DATE: "2026-09-02", AUTHOR: "A", REMARKS: \}/);
    });

    // The Revision and Status rewrite used to touch every indented line with
    // that key, so a block row whose Revision is not its first key lost its own
    // number: every history row became the new revision.
    it('leaves the history alone when Revision is not a row\'s first key', () => {
        const out = release([
            '---',
            'Title: T',
            'Status: Released',
            'Document Info:',
            '  Revision: 2',
            '  Status: Released',
            'Revisions:',
            '  - Date: "2026-01-01"',
            '    Revision: 1',
            '  - Remarks: outgoing',
            '    Revision: 2',
            '---',
            '',
            '# T',
            '',
        ].join('\n'));
        const r = rows(out);
        assert.deepEqual(r.map(x => String(x.Revision)), ['1', '2', '3'], 'each row keeps its own revision');
        assert.match(out, /^Document Info:\n {2}Revision: 3\n {2}Status: Work In Progress$/m, 'Document Info moves on');
        assert.match(out, /^Status: Work In Progress$/m, 'the top-level status resets');
    });

    it('leaves a Variables entry called Status or Revision alone', () => {
        const out = release(doc('Released').replace('Title: T', 'Title: T\nVariables:\n  Status: Draft\n  REVISION: x'));
        assert.match(out, /^ {2}Status: Draft$/m);
        assert.match(out, /^ {2}REVISION: x$/m);
        assert.match(out, /^Status: Work In Progress$/m);
    });

    it('takes the Document Info Author over a top-level Author', () => {
        const out = release(inlineDoc('  - {Revision: 1, Date: "2020-01-01"}')
            .replace('Title: T', 'Title: T\nAuthor: Top Level\nDocument Info:\n  Author: Info Author'));
        assert.equal(rows(out)[1].Author, 'Info Author');
    });

    it('spells each key of a mixed-case row the way that row does', () => {
        const out = release(inlineDoc('  - {Revision: 1, DATE: "2020-01-01", author: A}'));
        assert.match(out, /- \{Revision: 2, DATE: "2026-09-02", author: "A", Remarks: \}/);
    });

    it('spells a key the row lacks in the row\'s own style', () => {
        const out = release(inlineDoc('  - {REVISION: 1, DATE: "2020-01-01"}'), 'done');
        assert.match(out, /- \{REVISION: 1, DATE: "2026-09-02", REMARKS: done\}/);
        assert.match(out, /- \{REVISION: 2, DATE: "2026-09-02", AUTHOR: "", REMARKS: \}/);
    });

    it('falls back to the document\'s own Author when the row has none', () => {
        const out = release(inlineDoc('  - {Revision: 1, Date: "2020-01-01"}').replace('Title: T', 'Title: T\nAuthor: Own Name'));
        assert.equal(rows(out)[1].Author, 'Own Name');
    });
});

describe('allOutputsLanded: the release note', () => {
    const noteOn = (row: string, note: string) => {
        const out = release(inlineDoc(row), note);
        return out.split('\n').find(l => l.includes('Revision: 3') || l.includes('revision: 3')) ?? '';
    };

    it('fills an empty inline Remarks on the outgoing row, not the new one', () => {
        const out = release(inlineDoc([
            '    - {Revision: 2, Date: "2026-01-01", Author: A, Remarks: older}',
            '    - {Revision: 3, Date: "2026-02-01", Author: A, Remarks: }',
        ].join('\n')), 'signed off');
        assert.match(out, /Revision: 2,.*Remarks: older\}/, 'earlier rows are untouched');
        assert.match(out, /Revision: 3,.*Remarks: signed off\}/);
        assert.match(out, /Revision: 4,.*Remarks: \}/, 'the new row starts empty');
    });

    it('replaces a non-empty inline Remarks', () => {
        assert.match(noteOn('    - {Revision: 3, Date: "d", Author: A, Remarks: old}', 'new'), /Remarks: new\}/);
    });

    it('quotes a note that would break the flow mapping', () => {
        assert.match(noteOn('    - {Revision: 3, Date: "d", Author: A, Remarks: }', 'fixed A, added B'),
                     /Remarks: "fixed A, added B"\}/);
    });

    it('adds a Remarks key to an inline row that has none', () => {
        assert.match(noteOn('    - {Revision: 3, Date: "d", Author: A}', 'note'), /, Remarks: note\}$/);
    });

    it('keeps the document\'s own key casing', () => {
        const line = noteOn('    - {revision: 3, date: "d", author: a, remarks: }', 'note');
        assert.match(line, /remarks: note\}/);
        assert.ok(!/Remarks/.test(line), 'must not introduce a capitalised key');
    });

    it('inserts a note containing $& verbatim', () => {
        assert.match(noteOn('    - {Revision: 3, Date: "d", Author: A, Remarks: }', 'a$&b'), /Remarks: a\$&b\}/);
    });

    it('fills a block-form Remarks', () => {
        const out = release(doc('Released').replace('    Author: W', '    Author: W\n    Remarks:'), 'signed off');
        assert.equal(rows(out)[0].Remarks, 'signed off');
    });

    it('adds a Remarks key to a block row that has none', () => {
        assert.equal(rows(release(doc('Released'), 'note'))[0].Remarks, 'note');
    });
});

describe('openSourceDocument: a release that cannot happen is reported up front', () => {
    it('warns at open for a document that is not released, and never cuts one', () => {
        const original = doc('Work In Progress');
        const f = file(original);
        const s = open(f, { release: true });
        assert.equal(warningCount(), 1, 'the warning comes before any output lands');
        s.allOutputsLanded();
        assert.equal(rows(read(f)).length, 1, 'no release');
        assert.equal(rows(read(f))[0].Date, STAMP, 'the ordinary stamp still happens');
    });

    it('warns at open for a released document with no Revisions rows', () => {
        const original = '---\nTitle: T\nStatus: Released\n---\n\n# T\n';
        const f = file(original);
        const s = open(f, { release: true });
        assert.equal(warningCount(), 1);
        s.allOutputsLanded();
        assert.equal(read(f), original);
    });
});

// ── One baseline ──────────────────────────────────────────────────────────────

describe('a document that changed under the export', () => {
    it('does not overwrite an edit that landed before the first output', () => {
        const f = file(doc('Work In Progress'));
        const s = open(f);
        fs.writeFileSync(f, 'someone else was typing');
        s.outputLanded();
        assert.equal(read(f), 'someone else was typing');
        assert.equal(s.written, null);
        assert.equal(warningCount(), 1);
    });

    it('does not cut a release on top of an edit that landed after the stamp', () => {
        const f = file(doc('Released'));
        const s = open(f, { release: true });
        s.outputLanded();
        const stamped = read(f);
        const edited  = stamped.replace('Text.', 'More text.');
        fs.writeFileSync(f, edited);
        s.allOutputsLanded();
        assert.equal(read(f), edited, 'no release on content it never read');
        assert.equal(s.written, stamped, 'written is still its own last write');
        assert.equal(warningCount(), 1);
    });

    it('does not cut a release when the stamp was refused', () => {
        const f = file(doc('Released'));
        const s = open(f, { release: true });
        fs.writeFileSync(f, 'replaced');
        s.allOutputsLanded();
        assert.equal(read(f), 'replaced');
        assert.equal(warningCount(), 2, 'one for the stamp, one for the release');
    });

    it('does not cut a release on an edit when no stamp was needed', () => {
        // Already stamped today, so the handle writes nothing before the release
        // and its baseline is still what it read.
        const f = file(doc('Released').replace('2020-01-01', STAMP));
        const s = open(f, { release: true });
        s.outputLanded();
        assert.equal(s.written, null, 'nothing to stamp');
        fs.writeFileSync(f, read(f).replace('Text.', 'More text.'));
        const edited = read(f);
        s.allOutputsLanded();
        assert.equal(read(f), edited);
        assert.equal(warningCount(), 1);
    });

    it('does nothing when the document vanished mid-export', () => {
        const f = file(doc('Released'));
        const s = open(f, { release: true });
        fs.rmSync(f);
        s.allOutputsLanded();
        assert.equal(fs.existsSync(f), false);
        assert.equal(s.written, null);
    });
});
