import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { literal, jsonForScript, editDistance, closestMatch } from '../strings';
import { loadHtmlTemplate } from '../html';
import { loadCssTemplate } from '../css';

// Every string below is a legal thing to write in a document. As a *string*
// replacement each one is `String.replace` template syntax instead, and the
// output silently gains a duplicated match or loses the text entirely.
const DOLLAR_TRAPS = [
    ['$&',        'the whole match'],
    ['$`',        'everything before the match'],
    ["$'",        'everything after the match'],
    ['$1',        'the first capture group'],
    ['$$',        'an escaped dollar'],
    ['Q1 $& Q2',  'a match reference mid-sentence'],
    ['Cost: $5',  'a plain price'],
] as const;

describe('literal', () => {
    it('returns a function, not the string', () => {
        assert.equal(typeof literal('x'), 'function');
    });

    for (const [trap, why] of DOLLAR_TRAPS) {
        it(`inserts ${JSON.stringify(trap)} verbatim (would otherwise expand to ${why})`, () => {
            assert.equal('a[TOKEN]b'.replace('[TOKEN]', literal(trap)), `a${trap}b`);
            assert.equal('x[T]y[T]z'.replaceAll('[T]', literal(trap)), `x${trap}y${trap}z`);
        });
    }

    it('is the fix for a real corruption, not a no-op', () => {
        // Documents the bug being prevented: the bare-string form is wrong.
        assert.equal('a[TOKEN]b'.replace('[TOKEN]', '$&'), 'a[TOKEN]b');
        assert.equal('a[TOKEN]b'.replace('[TOKEN]', literal('$&')), 'a$&b');
    });
});

// ── Template loaders ──────────────────────────────────────────────────────────
// Cover titles, slogans, addresses and running header/footer text all reach the
// output through these two loaders, straight from user frontmatter.

let tmpDir: string;
let htmlTemplate: string;
let cssTemplate: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-strings-'));
    htmlTemplate = path.join(tmpDir, 'cover.html');
    cssTemplate  = path.join(tmpDir, 'page.css');
    fs.writeFileSync(htmlTemplate, '<html><body><h1>{{TITLE}}</h1><p>{{SLOGAN}}</p></body></html>');
    fs.writeFileSync(cssTemplate,  '@page { @top-left { content: "{{HEADER}}"; } }');
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('loadHtmlTemplate token substitution', () => {
    for (const [trap] of DOLLAR_TRAPS) {
        it(`renders a title of ${JSON.stringify(trap)} unchanged`, () => {
            const out = loadHtmlTemplate(htmlTemplate, { TITLE: trap, SLOGAN: 'ok' });
            assert.ok(out.includes(`<h1>${trap}</h1>`), out);
        });
    }

    it('substitutes several dollar-bearing tokens in one pass', () => {
        const out = loadHtmlTemplate(htmlTemplate, { TITLE: 'A$&B', SLOGAN: "C$'D" });
        assert.ok(out.includes('<h1>A$&B</h1>'), out);
        assert.ok(out.includes("<p>C$'D</p>"), out);
    });

    it('leaves an unknown token in place rather than emptying it', () => {
        const out = loadHtmlTemplate(htmlTemplate, { TITLE: 'x' });
        assert.ok(out.includes('{{SLOGAN}}'));
    });
});

describe('loadCssTemplate token substitution', () => {
    for (const [trap] of DOLLAR_TRAPS) {
        it(`renders a running header of ${JSON.stringify(trap)} unchanged`, () => {
            const out = loadCssTemplate(cssTemplate, { HEADER: trap });
            assert.ok(out.includes(`content: "${trap}"`), out);
        });
    }
});

// ── jsonForScript ─────────────────────────────────────────────────────────────
//
// The Mermaid renderer builds a page with the diagram source interpolated into
// an inline <script>. JSON.stringify makes a valid JS literal, but the HTML
// parser reads the element first and ends it at the first `</script>` in the
// raw text — so a node label about HTML truncated the script and spilled the
// rest of the diagram into the page as markup.

describe('jsonForScript', () => {
    /** Where the HTML parser would end a <script> containing this payload. */
    const scriptEndsAt = (payload: string): number =>
        `<script>render(${payload})</script>`.indexOf('</script>');

    it('produces a JS literal that parses back to the original', () => {
        for (const value of ['plain', 'quote " and \\ backslash', 'newline\nhere', '</script>', '']) {
            assert.equal(JSON.parse(jsonForScript(value).replace(/\\u003c/g, '<')), value);
        }
    });

    it('stops a </script> in the value from ending the element early', () => {
        const raw    = JSON.stringify('close tag: </script>');
        const safe   = jsonForScript('close tag: </script>');

        assert.ok(scriptEndsAt(raw) < scriptEndsAt(safe), 'the raw form must end the script early');
        assert.ok(!safe.includes('</script>'));
        assert.match(safe, /\\u003c\/script>/);
    });

    it('escapes the <!--<script double-escape sequence too', () => {
        // `<!--` followed by `<script` puts the HTML parser into a state where a
        // later `</script>` does NOT close the element — a different failure from
        // the one above, closed by the same escape.
        const safe = jsonForScript('<!--<script>x</script>');
        assert.ok(!safe.includes('<'), 'no raw < may survive');
    });

    it('leaves ordinary content untouched — including the > in a mermaid arrow', () => {
        // Only `<` needs escaping: `>` cannot start a tag, so an arrow (`-->`),
        // which appears in essentially every diagram, must survive verbatim.
        assert.equal(jsonForScript('graph TD\n  A --> B'), '"graph TD\\n  A --> B"');
    });

    it('handles a mermaid diagram id, which is also interpolated', () => {
        assert.equal(jsonForScript('mermaid-diag-1'), '"mermaid-diag-1"');
    });
});

describe('editDistance', () => {
    it('counts insertions, deletions and substitutions', () => {
        assert.equal(editDistance('kitten', 'sitting'), 3);
        assert.equal(editDistance('', 'abc'), 3);
        assert.equal(editDistance('abc', ''), 3);
        assert.equal(editDistance('same', 'same'), 0);
    });

    it('is symmetric', () => {
        assert.equal(editDistance('flaw', 'lawn'), editDistance('lawn', 'flaw'));
    });
});

describe('closestMatch', () => {
    const templates = ['list-grid-badge-card', 'list-row-horizontal-icon-arrow', 'chart-column-simple'];

    it('finds the candidate a typo was meant to be', () => {
        assert.equal(closestMatch('list-grid-badge-crad', templates), 'list-grid-badge-card');
    });

    it('ignores case', () => {
        assert.equal(closestMatch('Chart-Column-Simple', templates), 'chart-column-simple');
    });

    it('offers nothing when nothing is close — never a wild guess', () => {
        assert.equal(closestMatch('pie', templates), null);
        assert.equal(closestMatch('something-else-entirely', templates), null);
    });

    it('allows a few edits even for a short name', () => {
        assert.equal(closestMatch('tset', ['test', 'other']), 'test');
    });

    it('offers nothing from an empty list', () => {
        assert.equal(closestMatch('anything', []), null);
    });
});
