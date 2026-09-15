import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os   from 'os';
import { drawioImgTag, srcOf, parseDrawioSrc, findDrawioImages,
         isProbablyInstalled, renderDrawioDiagrams } from '../drawio';
import { warningCount, resetWarnings, setQuiet } from '../logger';

describe('drawioImgTag', () => {
    const URL = 'data:image/png;base64,AAAA';

    it('adds the marker class when the tag has none', () => {
        const out = drawioImgTag('<img src="arch.drawio" alt="Arch">', URL);
        assert.ok(out.includes('class="drawio-diagram"'));
        assert.ok(out.includes(`src="${URL}"`));
        assert.ok(out.includes('alt="Arch"'));
    });

    it('merges into an existing class instead of emitting two class attributes', () => {
        const out = drawioImgTag('<img class="wide" src="arch.drawio">', URL);
        assert.equal((out.match(/class=/g) ?? []).length, 1);
        assert.ok(out.includes('class="drawio-diagram wide"'), out);
    });

    it('merges into a single-quoted class too', () => {
        // The old merge looked for `class="` only, so a hand-written
        // `class='figure'` came out as a tag with TWO class attributes.
        const out = drawioImgTag("<img class='figure' src='arch.drawio'>", URL);
        assert.equal((out.match(/class=/g) ?? []).length, 1);
        assert.ok(out.includes('class="drawio-diagram figure"'), out);
    });

    it('merges into an unquoted class', () => {
        const out = drawioImgTag('<img class=figure src=arch.drawio>', URL);
        assert.equal((out.match(/class=/g) ?? []).length, 1);
        assert.ok(out.includes('class="drawio-diagram figure"'), out);
    });

    it('rewrites a single-quoted src', () => {
        const out = drawioImgTag("<img src='arch.drawio#page=2'>", URL);
        assert.ok(out.includes(`src="${URL}"`), out);
        assert.ok(!out.includes('arch.drawio'), 'the original reference is gone');
    });

    it('rewrites an unquoted src', () => {
        const out = drawioImgTag('<img src=arch.drawio>', URL);
        assert.ok(out.includes(`src="${URL}"`), out);
        assert.ok(!out.includes('arch.drawio'));
    });

    it('preserves attributes on both sides of src, in any order', () => {
        const out = drawioImgTag('<img id="a" src="arch.drawio" title="t" width="50">', URL);
        for (const attr of ['id="a"', 'title="t"', 'width="50"']) {
            assert.ok(out.includes(attr), `${attr} lost: ${out}`);
        }
    });

    it('produces a single well-formed img element', () => {
        const out = drawioImgTag('<img src="arch.drawio">', URL);
        assert.equal((out.match(/<img/g) ?? []).length, 1);
        assert.ok(out.startsWith('<img') && out.endsWith('>'));
    });

    it('inserts the data URL verbatim, $-patterns included', () => {
        // `String.replace` expands $& and friends in a *string* replacement.
        const out = drawioImgTag('<img src="arch.drawio">', 'data:image/png;base64,a$&b');
        assert.ok(out.includes('src="data:image/png;base64,a$&b"'), out);
    });
});

describe('srcOf', () => {
    it('reads a src in each of the three spellings', () => {
        assert.equal(srcOf('<img src="a.drawio">'), 'a.drawio');
        assert.equal(srcOf("<img src='a.drawio'>"), 'a.drawio');
        assert.equal(srcOf('<img src=a.drawio>'), 'a.drawio');
    });

    it('returns null for a tag with no src', () => {
        assert.equal(srcOf('<img alt="x">'), null);
    });

    it('reads a src containing spaces when it is quoted', () => {
        assert.equal(srcOf('<img src="my diagrams/a.drawio">'), 'my diagrams/a.drawio');
    });
});

describe('parseDrawioSrc', () => {
    it('defaults to the first page', () => {
        assert.deepEqual(parseDrawioSrc('a.drawio'), { file: 'a.drawio', pageIndex: 0 });
    });

    it('turns the 1-based fragment into a 0-based index', () => {
        assert.deepEqual(parseDrawioSrc('a.drawio#page=2'), { file: 'a.drawio', pageIndex: 1 });
    });

    it('keeps a # in the filename that is not a page fragment', () => {
        assert.deepEqual(parseDrawioSrc('weird#name.drawio'), { file: 'weird#name.drawio', pageIndex: 0 });
    });

    it('handles the .xml form', () => {
        assert.deepEqual(parseDrawioSrc('a.drawio.xml#page=3'), { file: 'a.drawio.xml', pageIndex: 2 });
    });
});

describe('findDrawioImages', () => {
    // Whether a tag is recognised is invisible in the output — an unrecognised
    // reference and one whose file is missing both leave the html untouched.
    // That is precisely how two of the three spellings went unnoticed.

    it('finds a double-quoted reference — what markdown emits', () => {
        assert.deepEqual(findDrawioImages('<p><img src="arch.drawio" alt="a"></p>'),
                         ['<img src="arch.drawio" alt="a">']);
    });

    it('finds a single-quoted reference', () => {
        assert.equal(findDrawioImages("<img src='arch.drawio'>").length, 1);
    });

    it('finds an unquoted reference', () => {
        assert.equal(findDrawioImages('<img src=arch.drawio>').length, 1);
    });

    it('finds the .xml and #page= forms in every spelling', () => {
        const html = `<img src="a.drawio.xml"><img src='b.drawio#page=2'><img src=c.drawio.xml#page=3>`;
        assert.equal(findDrawioImages(html).length, 3);
    });

    it('finds a reference with attributes on both sides of src', () => {
        assert.equal(findDrawioImages('<img class="w" src=\'a.drawio\' width="10">').length, 1);
    });

    it('finds every reference in the document, not just the first', () => {
        assert.equal(findDrawioImages('<img src="a.drawio"><img src="b.drawio">').length, 2);
    });

    it('ignores an image that merely has drawio in its name', () => {
        assert.deepEqual(findDrawioImages('<img src="drawio-screenshot.png">'), []);
        assert.deepEqual(findDrawioImages("<img src='my.drawio.png'>"), []);
    });

    it('ignores an img with no src at all', () => {
        assert.deepEqual(findDrawioImages('<img alt="a.drawio">'), []);
    });
});

describe('renderDrawioDiagrams', () => {
    it('returns the html untouched when there are no .drawio references', async () => {
        // No matches means the CLI is never probed, so this holds on a machine
        // with draw.io installed and on one without.
        const html = '<p>No diagrams here</p><img src="photo.png">';
        assert.equal(await renderDrawioDiagrams(html, os.tmpdir(), 'png'), html);
    });

    it('ignores an img whose src merely contains the word drawio', async () => {
        const html = '<img src="drawio-screenshot.png">';
        assert.equal(await renderDrawioDiagrams(html, os.tmpdir(), 'svg'), html);
    });

    it('leaves a reference to a missing .drawio file in place', async () => {
        // Whether the CLI exists or not, a file that is not on disk cannot be
        // exported — the export continues and the tag survives.
        const html = '<img src="definitely-not-here.drawio">';
        assert.equal(await renderDrawioDiagrams(html, os.tmpdir(), 'png'), html);
    });

    // ── The --strict invariant ────────────────────────────────────────────────
    //
    // A .drawio reference that cannot be rendered must raise a COUNTED warning,
    // so `--strict` refuses the document instead of shipping it with the diagram
    // silently missing. `logger.ts` counts a line only when it starts with
    // `WARNING:` at column zero, and this path used to log
    // `  WARNING: draw.io file not found: …` — two leading spaces, so it was not
    // counted, went to stdout rather than stderr, and `--quiet` swallowed it.
    //
    // Asserted as an invariant rather than against one message because which
    // branch runs depends on the machine: without the draw.io CLI the run stops
    // at the "not installed" warning, with it the per-file check is reached. Both
    // must warn, and CI has no draw.io while a developer's laptop may.
    describe('warns whenever a diagram cannot be rendered', () => {
        let realLog: typeof console.log;
        let realError: typeof console.error;

        beforeEach(() => {
            realLog = console.log; realError = console.error;
            console.log = () => {}; console.error = () => {};
            resetWarnings();
        });

        afterEach(() => {
            console.log = realLog; console.error = realError;
            setQuiet(false);
            resetWarnings();
        });

        it('counts a warning for a .drawio file that is not on disk', async () => {
            await renderDrawioDiagrams('<img src="definitely-not-here.drawio">', os.tmpdir(), 'png');
            assert.ok(warningCount() >= 1,
                'an unrenderable diagram must fail a --strict run');
        });

        it('counts one in svg mode too, not just png', async () => {
            await renderDrawioDiagrams('<img src="definitely-not-here.drawio">', os.tmpdir(), 'svg');
            assert.ok(warningCount() >= 1);
        });

        it('raises nothing when there is no diagram to render', async () => {
            await renderDrawioDiagrams('<p>no diagrams</p>', os.tmpdir(), 'png');
            assert.equal(warningCount(), 0);
        });
    });
});

describe('isProbablyInstalled', () => {
    // Each probe launches a whole Electron app, so candidates that cannot exist
    // are ruled out with a stat first.

    it('always probes a bare command name — only PATH can answer', () => {
        assert.equal(isProbablyInstalled('drawio'), true);
    });

    it('skips an absolute path that does not exist', () => {
        assert.equal(isProbablyInstalled('/nope/definitely/not/draw.io'), false);
    });

    it('skips a Windows path when running elsewhere', () => {
        assert.equal(isProbablyInstalled('C:\\Program Files\\draw.io\\draw.io.exe'), false);
    });

    it('skips the relative path the Windows per-user candidate degrades to', () => {
        // %LOCALAPPDATA% is unset off Windows, so path.join yields a *relative*
        // "Programs/draw.io/draw.io.exe" — which isAbsolute would have missed.
        assert.equal(isProbablyInstalled('Programs/draw.io/draw.io.exe'), false);
    });

    it('probes a path that does exist', () => {
        assert.equal(isProbablyInstalled(process.execPath), true);
    });
});
