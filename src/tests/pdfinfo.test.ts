import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { countPdfPages, summarizePdf } from '../pdfinfo';

const buf = (s: string) => Buffer.from(s, 'latin1');

describe('countPdfPages', () => {
    it('reads the total from the page tree root /Count', () => {
        assert.equal(countPdfPages(buf('%PDF-1.7\n1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 12 >>\nendobj')), 12);
    });

    it('takes the largest /Count, which is the root rather than a subtree', () => {
        const pdf = '<< /Type /Pages /Kids [3 0 R] /Count 4 >>\n<< /Type /Pages /Kids [] /Count 9 >>';
        assert.equal(countPdfPages(buf(pdf)), 9);
    });

    it('falls back to counting /Type /Page dictionaries', () => {
        const pdf = '<< /Type /Page /Parent 1 0 R >>\n<< /Type /Page >>\n<< /Type /Page >>';
        assert.equal(countPdfPages(buf(pdf)), 3);
    });

    it('does not mistake /Type /Pages for a page', () => {
        assert.equal(countPdfPages(buf('<< /Type /Pages /Kids [] >>')), null);
    });

    it('does not mistake /Type /PageLabel for a page', () => {
        assert.equal(countPdfPages(buf('<< /Type /PageLabels >>')), null);
    });

    it('tolerates no space between /Type and /Page', () => {
        assert.equal(countPdfPages(buf('<</Type/Page>><</Type/Page>>')), 2);
    });

    // The behaviour that matters: an unknown count must be null, so the caller
    // omits it. The old implementation always returned a number, so a document
    // whose page objects it could not see silently reported the wrong total.
    it('returns null when nothing countable is present', () => {
        assert.equal(countPdfPages(buf('%PDF-1.7\nstream\n<binary>\nendstream')), null);
    });

    it('returns null for an empty buffer', () => {
        assert.equal(countPdfPages(Buffer.alloc(0)), null);
    });

    it('ignores a zero or negative /Count rather than reporting zero pages', () => {
        assert.equal(countPdfPages(buf('<< /Type /Pages /Count 0 >>')), null);
    });

    it('finds the count in a long file, not just near the end', () => {
        // The old tail-only scan is exactly what this catches.
        const pdf = '<< /Type /Pages /Count 40 >>' + '\n% filler'.repeat(200_000);
        assert.ok(pdf.length > 1_000_000);
        assert.equal(countPdfPages(buf(pdf)), 40);
    });
});

describe('countPdfPages: compressed object streams', () => {
    /** Wraps a payload the way a PDF carries a Flate-compressed object stream. */
    const objStm = (payload: string) => Buffer.concat([
        Buffer.from('%PDF-1.7\n5 0 obj\n<</Type /ObjStm /Filter /FlateDecode>>\nstream\n', 'latin1'),
        zlib.deflateSync(Buffer.from(payload, 'latin1')),
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);

    // The case that matters most: this is exactly what WeasyPrint emits, so
    // without inflation the tool could never report a page count on its own
    // output — the scan would always come back "unknown".
    it('finds the count inside a Flate-compressed object stream', () => {
        assert.equal(countPdfPages(objStm('<</Type /Pages /Kids [1 0 R] /Count 32>>')), 32);
    });

    it('counts page dictionaries inside a compressed stream', () => {
        assert.equal(countPdfPages(objStm('<</Type /Page>><</Type /Page>><</Type /Page>>')), 3);
    });

    it('still returns null when the compressed content holds no page markers', () => {
        assert.equal(countPdfPages(objStm('<</Type /Font /BaseFont /Helvetica>>')), null);
    });

    it('skips streams that are not deflate rather than failing', () => {
        const mixed = Buffer.concat([
            Buffer.from('%PDF-1.7\n<</Type /ObjStm>>\nstream\nnot-compressed-at-all\nendstream\n', 'latin1'),
            objStm('<</Type /Pages /Count 5>>'),
        ]);
        assert.equal(countPdfPages(mixed), 5);
    });

    it('does not attempt inflation when the file has no object streams', () => {
        // Plain PDFs take the cheap path; this just pins the behaviour.
        assert.equal(countPdfPages(Buffer.from('<< /Type /Pages /Count 2 >>', 'latin1')), 2);
    });
});

describe('summarizePdf', () => {
    let dir: string;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-pdfinfo-')); });
    after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

    const write = (name: string, body: string) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, body, 'latin1');
        return p;
    };

    it('reports the filename, page count and size', () => {
        const p = write('doc.pdf', '<< /Type /Pages /Count 7 >>');
        const s = summarizePdf(p);
        assert.match(s, /doc\.pdf/);
        assert.match(s, /7 pages/);
        assert.match(s, /MB$/);
    });

    it('uses the singular for a one-page document', () => {
        assert.match(summarizePdf(write('one.pdf', '<< /Type /Page >>')), /1 page,/);
    });

    it('omits the page count entirely when it cannot be established', () => {
        const s = summarizePdf(write('opaque.pdf', '%PDF-1.7\nbinary junk'));
        assert.ok(!/page/.test(s), `should not claim a page count: ${s}`);
        assert.match(s, /opaque\.pdf — \d+\.\d MB/);
    });
});
