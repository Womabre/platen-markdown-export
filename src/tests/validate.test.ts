import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validate } from '../validate';
import { ExitError } from '../errors';

let tmpDir: string;
let fakeWeasyprint: string;
let fakeHtml: string;
let fakeMd: string;
let fakeCss: string;

before(() => {
    tmpDir        = fs.mkdtempSync(path.join(os.tmpdir(), 'platen-markdown-export-validate-test-'));
    fakeWeasyprint = path.join(tmpDir, 'weasyprint');
    fakeHtml       = path.join(tmpDir, 'doc.html');
    fakeMd         = path.join(tmpDir, 'doc.md');
    fakeCss        = path.join(tmpDir, 'style.css');
    fs.writeFileSync(fakeWeasyprint, '', 'utf8');
    fs.writeFileSync(fakeHtml,       '', 'utf8');
    fs.writeFileSync(fakeMd,         '', 'utf8');
    fs.writeFileSync(fakeCss,        '', 'utf8');
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function throws(code: number, fn: () => void): void {
    assert.throws(fn, (err: unknown) => {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${err}`);
        assert.equal(err.exitCode, code, `expected exit code ${code}, got ${err.exitCode}`);
        return true;
    });
}

describe('validate', () => {
    it('throws exit 4 when weasyprintPath is null', () => {
        throws(4, () => validate(null, fakeHtml, null, null));
    });

    it('throws exit 4 when weasyprint path does not exist on disk', () => {
        throws(4, () => validate(path.join(tmpDir, 'ghost'), fakeHtml, null, null));
    });

    it('throws exit 3 when the HTML file does not exist', () => {
        throws(3, () => validate(fakeWeasyprint, path.join(tmpDir, 'missing.html'), null, null));
    });

    it('throws exit 3 when a non-null markdown file does not exist', () => {
        throws(3, () => validate(fakeWeasyprint, fakeHtml, path.join(tmpDir, 'missing.md'), null));
    });

    it('does not throw when markdownFile is null (HTML-only input)', () => {
        // validate should not require a markdown sidecar to be present
        assert.doesNotThrow(() => validate(fakeWeasyprint, fakeHtml, null, null));
    });

    it('throws exit 3 when a non-null stylesheet does not exist', () => {
        throws(3, () => validate(fakeWeasyprint, fakeHtml, null, path.join(tmpDir, 'missing.css')));
    });

    it('does not throw for a valid minimal setup (all supplied files exist)', () => {
        assert.doesNotThrow(() => validate(fakeWeasyprint, fakeHtml, fakeMd, fakeCss));
    });

    it('does not throw when optional stylesheet is null', () => {
        assert.doesNotThrow(() => validate(fakeWeasyprint, fakeHtml, fakeMd, null));
    });

    it('does not throw when htmlFile is null (markdown input — HTML generated in memory)', () => {
        assert.doesNotThrow(() => validate(fakeWeasyprint, null, fakeMd, null));
    });
});
