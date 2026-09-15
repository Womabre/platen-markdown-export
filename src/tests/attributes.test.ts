import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attrOf, setAttr, attrValues, findTags, tagWithAttrValue } from '../attributes';

/**
 * The regression suite for a bug that shipped six times.
 *
 * Three modules each grew their own attribute pattern, each after a user found
 * the previous one silently ignoring a spelling `html: true` allows. Two rules
 * were learned along the way — all three quoting forms, and a leading `\s` so an
 * attribute name is matched whole — and the second was never propagated to
 * images.ts, which is why `<img data-src="x">` was read as an image reference.
 *
 * Both rules now live in one module, and this file is what keeps them there.
 */

describe('attrOf', () => {
    it('reads all three quoting spellings', () => {
        assert.equal(attrOf('<img src="a.png">',  'src'), 'a.png');
        assert.equal(attrOf("<img src='a.png'>",  'src'), 'a.png');
        assert.equal(attrOf('<img src=a.png>',    'src'), 'a.png');
    });

    it('returns null when the attribute is absent', () => {
        assert.equal(attrOf('<img alt="x">', 'src'), null);
    });

    it('keeps a quoted value that contains spaces', () => {
        assert.equal(attrOf('<img src="my diagrams/a.drawio">', 'src'),
                     'my diagrams/a.drawio');
    });

    it('is case-insensitive about the attribute name', () => {
        assert.equal(attrOf('<IMG SRC="a.png">', 'src'), 'a.png');
    });

    it('finds the attribute wherever it sits in the tag', () => {
        assert.equal(attrOf('<img id="a" src="b.png" title="t">', 'src'), 'b.png');
        assert.equal(attrOf('<img src="b.png" id="a">',           'src'), 'b.png');
    });

    // ── The `\s` guard ────────────────────────────────────────────────────────
    //
    // This is the whole reason the module exists. Without the leading
    // whitespace, `src=` matches the tail of `data-src=` and `class=` the tail
    // of `data-class=`.

    it('does not read data-src as src', () => {
        assert.equal(attrOf('<img data-src="lazy.png" alt="x">', 'src'), null);
    });

    it('reads the real src on a tag that also carries data-src', () => {
        assert.equal(attrOf('<img data-src="lazy.png" src="real.png">', 'src'), 'real.png');
    });

    it('reads the real src even when data-src comes second', () => {
        assert.equal(attrOf('<img src="real.png" data-src="lazy.png">', 'src'), 'real.png');
    });

    it('does not read data-class as class', () => {
        assert.equal(attrOf('<p data-class="fa-solid">x</p>', 'class'), null);
    });
});

describe('setAttr', () => {
    it('replaces an existing value, normalising to double quotes', () => {
        assert.equal(setAttr("<img src='a.png'>", 'src', 'b.png'), '<img src="b.png">');
        assert.equal(setAttr('<img src=a.png>',   'src', 'b.png'), '<img src="b.png">');
    });

    it('inserts the attribute after the tag name when it is absent', () => {
        assert.equal(setAttr('<img alt="x">', 'class', 'diagram'),
                     '<img class="diagram" alt="x">');
    });

    it('leaves every other attribute untouched', () => {
        assert.equal(setAttr('<img id="a" src="x.png" width="50">', 'src', 'y.png'),
                     '<img id="a" src="y.png" width="50">');
    });

    it('writes to src, never to a data-src beside it', () => {
        const out = setAttr('<img data-src="placeholder" src="real.png">', 'src', 'data:image/png;base64,AAA');
        assert.equal(out, '<img data-src="placeholder" src="data:image/png;base64,AAA">');
        // The point of the bug: the payload must not land on data-src, and the
        // real src must not survive pointing at a file the output cannot reach.
        assert.ok(!/data-src="data:/.test(out));
        assert.ok(!/\ssrc="real\.png"/.test(out));
    });

    it('inserts a value containing $& verbatim rather than expanding it', () => {
        // String.replace treats `$&` in a string replacement as the whole match.
        assert.equal(setAttr('<img src="a.png">', 'src', 'data:image/png;base64,a$&b'),
                     '<img src="data:image/png;base64,a$&b">');
    });

    it('inserts a $& value verbatim on the absent-attribute path too', () => {
        assert.equal(setAttr('<img alt="x">', 'title', 'Q1 $& Q2'),
                     '<img title="Q1 $& Q2" alt="x">');
    });
});

describe('attrValues', () => {
    it('collects every value of one attribute across a document', () => {
        assert.deepEqual(
            attrValues('<i class="a"></i><i class=\'b\'></i><i class=c></i>', 'class'),
            ['a', 'b', 'c'],
        );
    });

    it('skips data-prefixed lookalikes', () => {
        assert.deepEqual(attrValues('<i data-class="a"></i><i class="b"></i>', 'class'), ['b']);
    });

    it('returns an empty list when nothing matches', () => {
        assert.deepEqual(attrValues('<p>plain</p>', 'class'), []);
    });

    it('does not carry lastIndex between calls', () => {
        const html = '<i class="a"></i>';
        assert.deepEqual(attrValues(html, 'class'), ['a']);
        assert.deepEqual(attrValues(html, 'class'), ['a'], 'second call must agree with the first');
    });
});

describe('findTags', () => {
    it('finds every tag of one type', () => {
        assert.deepEqual(findTags('<p><img src="a"><img src="b"></p>', 'img'),
                         ['<img src="a">', '<img src="b">']);
    });

    it('does not match a longer tag name that starts the same way', () => {
        assert.deepEqual(findTags('<image src="a">', 'img'), []);
    });

    it('is indifferent to attribute order, unlike a pattern that walks past one', () => {
        // The bug this shape retires: `<link href=… rel=stylesheet>` matched
        // nothing while the same element written the other way round matched.
        assert.equal(findTags('<link href="a.css" rel="stylesheet">', 'link').length, 1);
        assert.equal(findTags('<link rel="stylesheet" href="a.css">', 'link').length, 1);
    });
});

describe('tagWithAttrValue', () => {
    const drawio = (): RegExp => tagWithAttrValue('img', 'src', String.raw`\.drawio(?:\.xml)?(?:#page=\d+)?`);

    it('matches the value in all three quoting spellings', () => {
        for (const tag of ['<img src="a.drawio">', "<img src='a.drawio'>", '<img src=a.drawio>'])
            assert.equal(tag.match(drawio())?.length, 1, tag);
    });

    it('allows spaces inside a quoted value', () => {
        assert.equal('<img src="my diagrams/a.drawio">'.match(drawio())?.length, 1);
    });

    it('ignores a tag whose src merely contains the value elsewhere', () => {
        assert.equal('<img src="drawio-screenshot.png">'.match(drawio()), null);
        assert.equal("<img src='my.drawio.png'>".match(drawio()), null);
    });

    it('ignores the value appearing in another attribute', () => {
        assert.equal('<img alt="a.drawio">'.match(drawio()), null);
        assert.equal('<img data-src="a.drawio">'.match(drawio()), null);
    });

    it('hands back a fresh cursor each call', () => {
        const html = '<img src="a.drawio"><img src="b.drawio">';
        assert.equal(html.match(drawio())?.length, 2);
        assert.equal(html.match(drawio())?.length, 2);
    });
});
