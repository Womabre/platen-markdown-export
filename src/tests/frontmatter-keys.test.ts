import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as path from 'path';
import {
    FRONTMATTER_KEYS, REVISION_ROW_KEYS, STYLE_OBJECT_KEYS, COVER_LOGO_KEYS,
    suggestKey, unknownKeyWarnings, frontmatterJsonSchema,
} from '../frontmatter-keys';
import { editDistance } from '../strings';
import { frontmatterTemplate } from '../frontmatter';

const SRC = path.join(__dirname, '..', '..', 'src');
const declared = new Set(FRONTMATTER_KEYS.flatMap(k => [k.key, ...(k.aliases ?? [])]).map(k => k.toLowerCase()));

// ── The table is complete ─────────────────────────────────────────────────────

describe('FRONTMATTER_KEYS', () => {
    // The point of the table is that it cannot fall behind the reader. A key
    // wired into extractFrontmatter without an entry here would be reported as
    // unknown in every document that uses it — so this fails first.
    it('declares every top-level key extractFrontmatter reads', () => {
        const source = fs.readFileSync(path.join(SRC, 'frontmatter.ts'), 'utf8');
        const body = /export function extractFrontmatter[\s\S]*?\n\}/.exec(source);
        assert.ok(body, 'extractFrontmatter should still exist');

        const read = [...body[0].matchAll(/\bat\(([^)]*)\)/g)]
            .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(q => q[1]));
        assert.ok(read.length > 20, `expected to find the reader calls, found ${read.length}`);
        for (const key of read) assert.ok(declared.has(key.toLowerCase()), `"${key}" is read but not declared`);
    });

    it('declares the keys resolveRevision reads', () => {
        for (const key of ['Document Info', 'Revisions', 'Version', 'Revision'])
            assert.ok(declared.has(key.toLowerCase()), key);
    });

    it('declares the "Export On Save" key the VS Code extension reads', () => {
        const core = fs.readFileSync(path.join(SRC, '..', 'vscode-extension', 'src', 'core.ts'), 'utf8');
        assert.match(core, /Export On Save/);
        assert.ok(declared.has('export on save'));
    });

    it('declares every key the --init scaffold writes', () => {
        const keys = frontmatterTemplate('2026-01-02').split('\n')
            .filter(l => /^[A-Z]/.test(l))
            .map(l => l.split(':')[0].trim());
        for (const key of keys) assert.ok(declared.has(key.toLowerCase()), key);
    });

    it('has no duplicate keys, case-insensitively', () => {
        const all = FRONTMATTER_KEYS.flatMap(k => [k.key, ...(k.aliases ?? [])]).map(k => k.toLowerCase());
        assert.equal(new Set(all).size, all.length);
    });

    it('gives every key a description', () => {
        for (const spec of FRONTMATTER_KEYS) assert.ok(spec.description.length > 10, spec.key);
    });
});

// ── editDistance transpositions ───────────────────────────────────────────────

describe('editDistance', () => {
    it('counts a swap as two edits by default, as before', () => {
        assert.equal(editDistance('titel', 'title'), 2);
    });

    it('counts a swap as one edit with transpositions', () => {
        assert.equal(editDistance('titel', 'title', { transpositions: true }), 1);
        assert.equal(editDistance('ab', 'ba', { transpositions: true }), 1);
    });

    it('agrees with plain Levenshtein when nothing is swapped', () => {
        for (const [a, b] of [['kitten', 'sitting'], ['', 'abc'], ['revison', 'revision'], ['same', 'same']])
            assert.equal(editDistance(a, b, { transpositions: true }), editDistance(a, b), `${a}/${b}`);
    });
});

// ── Near-miss detection ───────────────────────────────────────────────────────

describe('suggestKey', () => {
    const known = FRONTMATTER_KEYS.map(k => k.key);

    it('catches the slips a person makes', () => {
        assert.equal(suggestKey('Revison', known), 'Revision');
        assert.equal(suggestKey('Titel', known), 'Title');
        assert.equal(suggestKey('Clasification', known), 'Classification');
        assert.equal(suggestKey('Numbred Headings', known), 'Numbered Headings');
        assert.equal(suggestKey('Revisions Visable', known), 'Revisions Visible');
    });

    it('catches separators the reader does not fold', () => {
        // The reader is case-insensitive but not separator-insensitive, so these
        // were silently ignored before.
        assert.equal(suggestKey('cover_title_color', known), 'Cover Title Color');
        assert.equal(suggestKey('TOC-Depth', known), 'TOC Depth');
        assert.equal(suggestKey('PageSize', known), 'Page Size');
    });

    it("leaves other tools' keys alone", () => {
        for (const key of ['tags', 'tag', 'aliases', 'draft', 'type', 'marp', 'paginate', 'size', 'math',
                           'layout', 'slug', 'description', 'categories', 'subtitle', 'toc', 'class', 'weight'])
            assert.equal(suggestKey(key, known), null, key);
    });
});

describe('unknownKeyWarnings', () => {
    it('says nothing about a correct document, in any casing', () => {
        assert.deepEqual(unknownKeyWarnings({
            title: 'x', 'DOCUMENT INFO': { Author: 'a', Customer: 'free-form label' },
            Revisions: [{ revision: 1, Date: 'd', Author: 'a', Remarks: 'r' }],
            Style: { name: 'Navy', Image: 'x.jpg' },
            'Cover Title Colour': '#fff',
            'Cover Logo': [{ Path: 'a.png' }, { background: '#fff' }],
            Variables: { Anything: 'goes', Revison: 'is a variable name here' },
        }), []);
    });

    it('reports a top-level near-miss with its suggestion', () => {
        const [w, ...rest] = unknownKeyWarnings({ Title: 'x', Revison: 2 });
        assert.equal(rest.length, 0);
        assert.match(w, /^WARNING: /);
        assert.match(w, /"Revison"/);
        assert.match(w, /did you mean "Revision"/);
    });

    it('reports near-misses inside Revisions rows, Style and Cover Logo', () => {
        const warnings = unknownKeyWarnings({
            Revisions: [{ Revision: 1, Remark: 'x' }],
            Style: { Name: 'Navy', Imgae: 'x.jpg' },
            'Cover Logo': [{ Pth: 'a.png' }],
        });
        assert.equal(warnings.length, 3, warnings.join('\n'));
        assert.match(warnings[0], /"Remark" in Revisions row 1 .*"Remarks"/);
        assert.match(warnings[1], /"Style\.Imgae" .*"Style\.Image"/);
        assert.match(warnings[2], /"Cover Logo\.Pth" .*"Cover Logo\.Path"/);
    });

    it('does not check Document Info or Variables, whose keys are the author\'s own', () => {
        assert.deepEqual(unknownKeyWarnings({ 'Document Info': { Titel: 'x' }, Variables: { Titel: 'x' } }), []);
    });

    it('survives frontmatter that is not a mapping', () => {
        for (const value of [undefined, null, 'text', 42, ['a']]) assert.deepEqual(unknownKeyWarnings(value), []);
    });
});

// ── JSON Schema ───────────────────────────────────────────────────────────────

describe('frontmatterJsonSchema', () => {
    const schema = frontmatterJsonSchema() as { properties: Record<string, { description?: string }>; additionalProperties: unknown };

    it('has a property for every key and alias', () => {
        for (const spec of FRONTMATTER_KEYS) {
            assert.ok(schema.properties[spec.key], spec.key);
            for (const alias of spec.aliases ?? []) {
                assert.ok(schema.properties[alias], alias);
                assert.equal((schema.properties[alias] as Record<string, unknown>)['x-aliasOf'], spec.key);
            }
        }
    });

    it("allows keys it does not know, since documents carry other tools' keys", () => {
        assert.equal(schema.additionalProperties, true);
    });

    it('is plain JSON', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
    });

    it('matches the committed schema file', () => {
        // The file is what an editor or a CI validator points at; it is regenerated
        // with `node dist/index.js --frontmatter-schema > schema/frontmatter.schema.json`.
        const committed = JSON.parse(fs.readFileSync(
            path.join(SRC, '..', 'schema', 'frontmatter.schema.json'), 'utf8'));
        assert.deepEqual(committed, schema);
    });

    it('keeps the nested key lists in step with their schemas', () => {
        const json = JSON.stringify(schema.properties);
        const revisionRow = (schema.properties.Revisions as { items: { properties: object } }).items.properties;
        const styleObject = (schema.properties.Style as { anyOf: Array<{ properties?: object }> })
            .anyOf.find(a => a.properties)!.properties!;
        assert.deepEqual(Object.keys(revisionRow), [...REVISION_ROW_KEYS]);
        assert.deepEqual(Object.keys(styleObject), [...STYLE_OBJECT_KEYS]);
        for (const key of COVER_LOGO_KEYS) assert.ok(schema.properties['Cover Logo'].description!.includes(key), key);
        assert.ok(json.length > 0);
    });
});
