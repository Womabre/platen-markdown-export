import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as path from 'path';
import {
    parseFrontmatterSchema, frontmatterLines, presentKeys, completionContext,
    keySuggestions, findKey, keyAt, topLevelValue, type SchemaKey,
} from '../frontmatter-schema';

/**
 * The schema the root package commits — the same JSON the CLI prints for
 * `--frontmatter-schema`, so these tests run against the real key list rather
 * than a hand-made one that could agree with this module and nothing else.
 */
const SCHEMA = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'schema', 'frontmatter.schema.json'), 'utf8');
const KEYS = parseFrontmatterSchema(SCHEMA);

const doc = (...body: string[]): string[] => ['---', ...body, '---', '', '# Heading', 'Prose: with a colon'];

describe('parseFrontmatterSchema', () => {
    it('reads every key with its description', () => {
        assert.ok(KEYS.length > 30, `${KEYS.length} keys`);
        const title = findKey(KEYS, 'Title')!;
        assert.match(title.description, /title/i);
        for (const k of KEYS) assert.ok(k.description, `${k.key} has a description`);
    });

    it('collects the values worth suggesting', () => {
        assert.deepEqual(findKey(KEYS, 'Classification')!.values, ['Public', 'Internal', 'Confidential']);
        assert.deepEqual(findKey(KEYS, 'Orientation')!.values, ['portrait', 'landscape']);
        assert.deepEqual(findKey(KEYS, 'Numbered Headings')!.values, ['true', 'false']);
        assert.deepEqual(findKey(KEYS, 'Mode')!.values, ['pdf', 'html', 'debug']);
        assert.deepEqual(findKey(KEYS, 'Cover Slogan')!.values, ['false'], 'an override can be switched off');
        assert.ok(findKey(KEYS, 'PDF Variant')!.values.includes('pdf/a-2b'));
        assert.deepEqual(findKey(KEYS, 'Title')!.values, []);
    });

    it('degrades to no keys for an older CLI or unexpected output', () => {
        for (const bad of [null, '', 'Error: unknown option "--frontmatter-schema"', '[]', '{"properties":[]}', 'null'])
            assert.deepEqual(parseFrontmatterSchema(bad), [], String(bad));
    });
});

describe('frontmatterLines', () => {
    it('finds the lines between the fences', () => {
        assert.deepEqual(frontmatterLines(doc('Title: T', 'Mode: pdf')), { first: 1, last: 2 });
        assert.deepEqual(frontmatterLines(['﻿---', 'Title: T', '...']), { first: 1, last: 1 });
    });

    it('needs both fences, so a leading horizontal rule is not frontmatter', () => {
        assert.equal(frontmatterLines(['---', 'Some prose', 'More prose']), null);
        assert.equal(frontmatterLines(['# Heading', '---', 'Title: T', '---']), null);
        assert.equal(frontmatterLines([]), null);
    });
});

describe('completionContext', () => {
    const lines = doc('Title: Report', 'Numb', 'Classification: In', '  Author: Me', '# Theme: x', '- item');

    it('completes a key on a top-level line before the colon', () => {
        assert.deepEqual(completionContext(lines, 2, 4), { kind: 'key', start: 0 });
    });

    it('completes a value after the colon, starting where the value starts', () => {
        assert.deepEqual(completionContext(lines, 3, 18), { kind: 'value', key: 'Classification', start: 16 });
        assert.deepEqual(completionContext(['---', 'Mode:', '---'], 1, 5), { kind: 'value', key: 'Mode', start: 5 });
    });

    it('offers nothing on indented, comment or list lines', () => {
        assert.equal(completionContext(lines, 4, 6), null);
        assert.equal(completionContext(lines, 5, 3), null);
        assert.equal(completionContext(lines, 6, 3), null);
    });

    it('offers nothing outside the frontmatter, including the fences and the body', () => {
        for (const line of [0, 7, 9, 10]) assert.equal(completionContext(lines, line, 2), null, `line ${line}`);
    });
});

describe('keySuggestions', () => {
    it('leaves out keys the block already sets, in any casing', () => {
        const lines = doc('title: T', 'MODE: pdf', '');
        const offered = keySuggestions(KEYS, presentKeys(lines, 3)).map(k => k.key);
        assert.ok(!offered.includes('Title') && !offered.includes('Mode'));
        assert.ok(offered.includes('Theme'));
    });

    it('still offers the key being typed on the current line', () => {
        const lines = doc('Them');
        assert.ok(keySuggestions(KEYS, presentKeys(lines, 1)).some((k: SchemaKey) => k.key === 'Theme'));
    });

    it('never offers an alias, and an alias counts as setting its key', () => {
        const offered = keySuggestions(KEYS, new Set()).map(k => k.key);
        assert.ok(offered.includes('Cover Title Color') && !offered.includes('Cover Title Colour'));
        assert.ok(offered.includes('Revision') && !offered.includes('Version'));
        const afterAlias = keySuggestions(KEYS, presentKeys(doc('Cover Title Colour: "#fff"'))).map(k => k.key);
        assert.ok(!afterAlias.includes('Cover Title Color'));
        assert.equal(findKey(KEYS, 'cover title colour')!.aliasOf, 'Cover Title Color', 'still found for hover');
    });

    it('does not count nested keys as present', () => {
        assert.ok(!presentKeys(doc('Document Info:', '    Status: Draft')).has('status'));
    });
});

describe('keyAt / topLevelValue', () => {
    const lines = doc('Classification: Internal', 'Theme: "modern"   # brand', '  Author: Me');

    it('names the key under the cursor, only over the key itself', () => {
        assert.equal(keyAt(lines, 1, 3), 'Classification');
        assert.equal(keyAt(lines, 1, 20), null, 'over the value');
        assert.equal(keyAt(lines, 3, 4), null, 'nested');
        assert.equal(keyAt(lines, 7, 1), null, 'body');
    });

    it('reads a top-level value unquoted and without a trailing comment', () => {
        assert.equal(topLevelValue(lines, 'theme'), 'modern');
        assert.equal(topLevelValue(lines, 'Author'), null, 'nested keys are not top-level');
        assert.equal(topLevelValue(doc('Theme:'), 'Theme'), null);
    });
});
