import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { extractFrontmatter } from '../frontmatter';

/**
 * Frontmatter keys are documented in Title Case but must work in any casing.
 *
 * This used to be hand-maintained as ~40 pairs of interface members plus an
 * `attrs.X ?? attrs.x` at each read, so a key wired for only one casing did
 * nothing in the other — silently. These cases walk every documented key in
 * three casings and assert the parsed value is identical.
 */

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-casing-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function parse(yaml: string) {
    const file = path.join(dir, `doc-${seq++}.md`);
    fs.writeFileSync(file, `---\n${yaml}\n---\n\n# Body\n`, 'utf8');
    return extractFrontmatter(file);
}

/** Title Case → the three spellings a user might reasonably type. */
const casings = (key: string) => [
    key,
    key.toLowerCase(),
    key.toUpperCase(),
];

const SCALAR_KEYS: Array<[key: string, yamlValue: string, field: string, expected: unknown]> = [
    ['Title',             'A Doc',        'title',            'A Doc'],
    ['Header',            'Top',          'header',           'Top'],
    ['Footer',            'Bottom',       'footer',           'Bottom'],
    ['Lang',              'nl',           'lang',             'nl'],
    ['Numbered Headings', 'true',         'numberedHeadings', true],
    ['Running Header',    'true',         'runningHeader',    true],
    ['List of Tables',    'true',         'listOfTables',     true],
    ['List of Figures',   'true',         'listOfFigures',    true],
    ['Code Line Numbers', 'true',         'codeLineNumbers',  true],
    ['Trademark Symbols', 'true',         'trademarkSymbols', true],
    ['TOC Depth',         '2',            'tocDepth',         2],
    ['Page Size',         'a5',           'pageSize',         'A5'],
    ['Margins',           '20mm',         'margins',          '20mm'],
    ['Orientation',       'landscape',    'orientation',      'landscape'],
    ['Classification',    'Confidential', 'classification',   'Confidential'],
    ['Theme',             'modern',       'theme',            'modern'],
    ['Style',             'Cherry',       'style',            'Cherry'],
    ['Logo',              'alt.svg',      'logo',             'alt.svg'],
    ['Cover Slogan',      'Tagline',      'coverSlogan',      'Tagline'],
    ['Cover Footer Logo', 'mark.svg',     'coverFooterLogo',  'mark.svg'],
    ['Revisions Visible', '5',            'revisionsVisible', 5],
];

describe('frontmatter keys are case-insensitive', () => {
    for (const [key, value, field, expected] of SCALAR_KEYS) {
        it(`${key} works in every casing`, () => {
            for (const spelling of casings(key)) {
                const fm = parse(`${spelling}: ${value}`) as unknown as Record<string, unknown>;
                assert.deepEqual(fm[field], expected, `"${spelling}: ${value}" → ${field}`);
            }
        });
    }

    it('Cover Page: false works in every casing', () => {
        for (const spelling of casings('Cover Page')) {
            assert.equal(parse(`${spelling}: false`).coverPage, false, spelling);
        }
    });

    it('Cover Title Color accepts both spellings, in any casing', () => {
        for (const key of ['Cover Title Color', 'Cover Title Colour']) {
            for (const spelling of casings(key)) {
                assert.equal(parse(`${spelling}: "#ff0000"`).coverTitleColor, '#ff0000', spelling);
            }
        }
    });

    it('Document Info sub-keys are case-insensitive', () => {
        const upper = parse('Document Info:\n  AUTHOR: Ada\n  STATUS: Released\n  DATE: "2026-01-01"');
        const lower = parse('document info:\n  author: Ada\n  status: Released\n  date: "2026-01-01"');
        for (const fm of [upper, lower]) {
            assert.equal(fm.author, 'Ada');
            assert.equal(fm.status, 'Released');
            assert.equal(fm.date, '2026-01-01');
        }
    });

    it('Revisions row keys are case-insensitive', () => {
        const rows = 'Revisions:\n  - REVISION: 4\n    DATE: "2026-05-05"\n    AUTHOR: Bo\n    REMARKS: hi';
        const fm = parse(rows);
        assert.deepEqual(fm.revisions, [{ revision: '4', date: '2026-05-05', author: 'Bo', remarks: 'hi' }]);
        assert.equal(fm.revision, '4', 'newest revision should become the document revision');
    });

    it('Variables keys keep their own casing — they are substitution names, not settings', () => {
        const fm = parse('VARIABLES:\n  Product: Widget\n  release: "2.0"');
        assert.deepEqual(fm.variables, { Product: 'Widget', release: '2.0' });
    });

    it('Mode is normalised the same way whatever the key casing', () => {
        for (const spelling of casings('Mode')) {
            assert.equal(parse(`${spelling}: PDF, HTML`).mode, 'pdf,html', spelling);
        }
    });

    it('Cover Address accepts a list in any casing', () => {
        for (const spelling of casings('Cover Address')) {
            assert.equal(parse(`${spelling}:\n  - Line one\n  - Line two`).coverAddress, 'Line one\nLine two', spelling);
        }
    });

    it('an exact-case key is not shadowed by a differently-cased duplicate', () => {
        // YAML allows both; the first spelling in the mapping wins, and the
        // result must not depend on Object.entries ordering luck.
        assert.equal(parse('Title: First\ntitle: Second').title, 'First');
    });

    it('an absent key still yields the documented default', () => {
        const fm = parse('Title: Bare');
        assert.equal(fm.lang, 'en');
        assert.equal(fm.revisionsVisible, 3);
        assert.equal(fm.orientation, 'portrait');
        assert.equal(fm.coverPage, true);
        assert.equal(fm.numberedHeadings, false);
        assert.equal(fm.tocDepth, null);
    });
});
