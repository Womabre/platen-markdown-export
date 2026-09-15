import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    INFOGRAPHIC_FONT_STACK, BOLD_WIDTH_FACTOR,
    stripProcessingInstructions, normalizeFontFamily, parseInlineStyle, decodeEntities,
    normalizeFontWeight, wrapText, wrapBoldText, convertForeignObjects, postProcessInfographicSvg, injectStyle,
    type MeasureText,
} from '../infographic-svg';

/** One px per character: line breaks become easy to reason about. */
const len = (s: string): number => s.length;

/** Half an em per character — every glyph the same width. */
const halfEm: MeasureText = (text, fontSize) => text.length * fontSize * 0.5;

/** A foreignObject exactly as the library emits one: a single styled span. */
const fo = (attrs: string, style: string, text: string): string =>
    `<foreignObject ${attrs} overflow="visible"><span style="${style}" xmlns="http://www.w3.org/1999/xhtml">${text}</span></foreignObject>`;

const tspans = (svg: string): Array<{ x: string; y: string; text: string }> =>
    [...svg.matchAll(/<tspan x="([^"]+)" y="([^"]+)">([^<]*)<\/tspan>/g)].map(m => ({ x: m[1], y: m[2], text: m[3] }));

describe('stripProcessingInstructions', () => {
    it('removes the XML prologue and the remote font stylesheets', () => {
        const raw = '<?xml version="1.0" encoding="UTF-8"?>\n'
                  + '<?xml-stylesheet href="https://example.com/font.css" type="text/css"?>\n'
                  + '<svg><rect/></svg>';
        assert.equal(stripProcessingInstructions(raw), '<svg><rect/></svg>');
    });

    it('leaves an SVG without any unchanged', () => {
        assert.equal(stripProcessingInstructions('<svg><text>?</text></svg>'), '<svg><text>?</text></svg>');
    });
});

describe('normalizeFontFamily', () => {
    it('replaces a double-quoted font-family', () => {
        assert.equal(normalizeFontFamily('<g font-family="Alibaba PuHuiTi">'),
            `<g font-family="${INFOGRAPHIC_FONT_STACK}">`);
    });

    it('replaces a single-quoted one', () => {
        assert.equal(normalizeFontFamily("<g font-family='Alibaba PuHuiTi'>"),
            `<g font-family="${INFOGRAPHIC_FONT_STACK}">`);
    });

    it('replaces every occurrence', () => {
        const out = normalizeFontFamily('<g font-family="a"><text font-family="b">x</text></g>');
        assert.equal(out.split(INFOGRAPHIC_FONT_STACK).length - 1, 2);
    });

    it('does not touch an attribute that merely ends in font-family', () => {
        const tag = '<g data-font-family="keep">';
        assert.equal(normalizeFontFamily(tag), tag);
    });
});

describe('parseInlineStyle', () => {
    it('maps lowercased properties to trimmed values', () => {
        assert.deepEqual(parseInlineStyle(' Color : #262626 ;font-size:14px'),
            { color: '#262626', 'font-size': '14px' });
    });

    it('keeps a colon inside a value', () => {
        assert.equal(parseInlineStyle('background:url(a:b)').background, 'url(a:b)');
    });

    it('skips empty and malformed declarations', () => {
        assert.deepEqual(parseInlineStyle(';;nonsense;:x;color:red;'), { color: 'red' });
    });
});

describe('decodeEntities', () => {
    it('decodes the named entities a serializer emits', () => {
        assert.equal(decodeEntities('&lt;b&gt; &quot;q&quot; &apos;a&#39;'), `<b> "q" 'a'`);
    });

    it('decodes &nbsp; to a no-break space, not a plain one', () => {
        assert.equal(decodeEntities('10&nbsp;ms'), '10\u00a0ms');
    });

    it('decodes numeric references, decimal and hex', () => {
        assert.equal(decodeEntities('&#65;&#x42;&#X43;'), 'ABC');
    });

    it('decodes &amp; last, so an escaped entity stays escaped once', () => {
        assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    });
});

describe('normalizeFontWeight', () => {
    const cases: Array<[string | undefined, string, boolean]> = [
        [undefined, 'normal', false],
        ['regular', 'normal', false],   // a style name the library emits, not a CSS weight
        ['medium',  '500',    false],
        ['bold',    'bold',   true],
        ['BOLD',    'bold',   true],
        ['400',     '400',    false],
        ['600',     '600',    true],
        ['nonsense', 'normal', false],
    ];
    for (const [raw, weight, bold] of cases) {
        it(`${JSON.stringify(raw)} → ${weight}${bold ? ' (bold)' : ''}`, () => {
            assert.deepEqual(normalizeFontWeight(raw), { weight, bold });
        });
    }
});

describe('wrapText', () => {
    it('keeps text that fits on one line', () => {
        assert.deepEqual(wrapText('hello world', 20, len), ['hello world']);
    });

    it('wraps at spaces', () => {
        assert.deepEqual(wrapText('hello world', 8, len), ['hello', 'world']);
    });

    it('always breaks at an explicit newline', () => {
        assert.deepEqual(wrapText('a\nb', 100, len), ['a', 'b']);
    });

    it('breaks a word wider than the box between characters', () => {
        assert.deepEqual(wrapText('abcdefghij', 4, len), ['abcd', 'efgh', 'ij']);
    });

    it('finishes the line before breaking a long word', () => {
        assert.deepEqual(wrapText('hi abcdefghij', 4, len), ['hi', 'abcd', 'efgh', 'ij']);
    });

    it('collapses runs of whitespace', () => {
        assert.deepEqual(wrapText('a    b', 10, len), ['a b']);
    });

    it('never breaks at a no-break space', () => {
        // "wait 10 ms" does not fit 8: the break goes after "wait", never inside "10 ms".
        assert.deepEqual(wrapText('wait 10\u00a0ms', 8, len), ['wait', '10\u00a0ms']);
    });

    it('allows half a pixel of overrun, as browser rounding does', () => {
        assert.deepEqual(wrapText('abcde', 4.5, len), ['abcde']);
        assert.deepEqual(wrapText('abcde', 4.4, len), ['abcd', 'e']);
    });

    it('wraps only at newlines when there is no box to fit', () => {
        assert.deepEqual(wrapText('  one two  \nthree', 0, len), ['one two', 'three']);
    });

    it('every line it produces fits, for any box a word fits in', () => {
        const text = 'the quick brown fox jumps over the lazy dog and keeps on running';
        for (let width = 5; width <= 40; width++) {
            for (const line of wrapText(text, width, len)) {
                assert.ok(line.length <= width + 0.5, `"${line}" overruns ${width}`);
            }
        }
    });
});

describe('wrapBoldText', () => {
    it('keeps a line the library sized its box for, though bold overhangs it', () => {
        // 100 px regular: the library's box is 101.5 px wide. At bold width (108 px)
        // it no longer fits — but wrapping would push a second line out of a box
        // built for one.
        const tenChars = (s: string): number => s.length * 10;
        assert.deepEqual(wrapBoldText('aaaaaaaaaa', 102, tenChars), ['aaaaaaaaaa']);
    });

    it('wraps text the library did not size for at bold width, so each line fits', () => {
        const tenChars = (s: string): number => s.length * 10;
        const lines = wrapBoldText('aaaa bbbb cccc', 95, tenChars);
        // At regular width "aaaa bbbb" (90 px) would fit 95; at bold (97.2 px) it does not.
        assert.deepEqual(lines, ['aaaa', 'bbbb', 'cccc']);
        for (const line of lines) assert.ok(tenChars(line) * BOLD_WIDTH_FACTOR <= 95.5, line);
    });

    it('decides per paragraph', () => {
        const tenChars = (s: string): number => s.length * 10;
        assert.deepEqual(wrapBoldText('short\naaaa bbbb cccc', 95, tenChars), ['short', 'aaaa', 'bbbb', 'cccc']);
    });

    it('collapses whitespace in a line it keeps whole, as wrapText does', () => {
        assert.deepEqual(wrapBoldText('  a   b ', 100, len), ['a b']);
    });
});

describe('convertForeignObjects', () => {
    // font-size 20, line-height 40px: the first baseline sits at
    // top + (40 − 1.117·20)/2 + 0.905·20 = top + 26.93.
    const base = 'font-size:20px;line-height:40px';

    it('rebuilds the span as native text, with no foreignObject left', () => {
        const out = convertForeignObjects(fo('x="10" y="0" width="100" height="40"', `${base};color:#262626`, 'Hi'), halfEm);
        assert.equal(out,
            `<text font-size="20" font-weight="normal" text-anchor="start" font-family="${INFOGRAPHIC_FONT_STACK}" fill="#262626">`
            + '<tspan x="10" y="26.93">Hi</tspan></text>');
    });

    it('replaces the foreignObject in place, inside its transformed group', () => {
        const out = convertForeignObjects(`<g transform="translate(5, 5)">${fo('x="0" y="0" width="100" height="40"', base, 'Hi')}</g>`, halfEm);
        assert.match(out, /^<g transform="translate\(5, 5\)"><text [^>]*><tspan[^>]*>Hi<\/tspan><\/text><\/g>$/);
    });

    describe('horizontal alignment', () => {
        const anchorOf = (style: string) => {
            const out = convertForeignObjects(fo('x="10" y="0" width="100" height="40"', `${base};${style}`, 'Hi'), halfEm);
            return { anchor: /text-anchor="([^"]+)"/.exec(out)![1], x: tspans(out)[0].x };
        };
        it('text-align:center anchors the middle of the box', () => {
            assert.deepEqual(anchorOf('text-align:center'), { anchor: 'middle', x: '60' });
        });
        it('text-align:right anchors its end', () => {
            assert.deepEqual(anchorOf('text-align:right'), { anchor: 'end', x: '110' });
        });
        it('falls back to justify-content when there is no text-align', () => {
            assert.deepEqual(anchorOf('justify-content:flex-end'), { anchor: 'end', x: '110' });
            assert.deepEqual(anchorOf('justify-content:center'), { anchor: 'middle', x: '60' });
        });
        it('defaults to the start', () => {
            assert.deepEqual(anchorOf(''), { anchor: 'start', x: '10' });
        });
    });

    describe('vertical alignment', () => {
        const baselineOf = (style: string) =>
            tspans(convertForeignObjects(fo('x="0" y="0" width="100" height="100"', `${base};${style}`, 'Hi'), halfEm))[0].y;
        it('flex-start puts the first line at the top', () => {
            assert.equal(baselineOf('align-items:flex-start'), '26.93');
        });
        it('center centres the block of lines', () => {
            assert.equal(baselineOf('align-items:center'), '56.93');   // top = (100 − 40) / 2
        });
        it('flex-end puts the last line at the bottom', () => {
            assert.equal(baselineOf('align-items:flex-end'), '86.93'); // top = 100 − 40
        });
        it('falls back to align-content', () => {
            assert.equal(baselineOf('align-content:center'), '56.93');
        });
    });

    it('wraps to the box width, one tspan per line, a line-height apart', () => {
        // 10 px per character at 20 px: "aaaa bbbb" is 90 px, the box 100.
        const out = convertForeignObjects(fo('x="0" y="0" width="100" height="80"', base, 'aaaa bbbb cccc'), halfEm);
        assert.deepEqual(tspans(out), [
            { x: '0', y: '26.93', text: 'aaaa bbbb' },
            { x: '0', y: '66.93', text: 'cccc' },
        ]);
    });

    it('measures bold text the way the library sized its box', () => {
        // 100 px regular in a 102 px box: one line, not two.
        const out = convertForeignObjects(fo('x="0" y="0" width="102" height="40"', `${base};font-weight:bold`, 'aaaaaaaaaa'), halfEm);
        assert.equal(tspans(out).length, 1);
        assert.match(out, /font-weight="bold"/);
    });

    it('turns a style-name weight into a CSS one', () => {
        const out = convertForeignObjects(fo('x="0" y="0" width="100" height="40"', `${base};font-weight:medium`, 'Hi'), halfEm);
        assert.match(out, /font-weight="500"/);
    });

    it('breaks at <br>', () => {
        const out = convertForeignObjects(fo('x="0" y="0" width="500" height="80"', base, 'one<br/>two'), halfEm);
        assert.deepEqual(tspans(out).map(t => t.text), ['one', 'two']);
    });

    it('keeps the words of nested inline markup and drops the tags', () => {
        const out = convertForeignObjects(fo('x="0" y="0" width="500" height="40"', base, 'bold <b>word</b>'), halfEm);
        assert.deepEqual(tspans(out).map(t => t.text), ['bold word']);
    });

    it('decodes the span\'s entities once and escapes the result for SVG', () => {
        const out = convertForeignObjects(fo('x="0" y="0" width="500" height="40"', base, 'A &amp; B &lt;x&gt;'), halfEm);
        assert.equal(tspans(out)[0].text, 'A &amp; B &lt;x&gt;');
    });

    it('escapes a colour it carries into an attribute, quotes included', () => {
        // A single-quoted style can hold a raw `"`; it must not end the fill attribute.
        const input = `<foreignObject x="0" y="0" width="100" height="40"><span style='font-size:20px;color:red" data-x="1'>Hi</span></foreignObject>`;
        const out = convertForeignObjects(input, halfEm);
        assert.match(out, / fill="red&quot; data-x=&quot;1"/);
        assert.ok(!out.includes(' data-x="1"'), out);
    });

    it('drops an empty span rather than leaving an empty element', () => {
        assert.equal(convertForeignObjects(`<g>${fo('x="0" y="0" width="100" height="40"', base, '  ')}</g>`, halfEm), '<g></g>');
    });

    it('falls back to 14 px and no fill when there is no span style', () => {
        const out = convertForeignObjects('<foreignObject x="0" y="0" width="100" height="20">plain</foreignObject>', halfEm);
        assert.match(out, /font-size="14"/);
        assert.ok(!out.includes('fill='), out);
        assert.deepEqual(tspans(out).map(t => t.text), ['plain']);
    });
});

describe('a theme font this tool ships', () => {
    const raw = '<svg font-family="851tegakizatsu"><g>'
              + fo('x="0" y="0" width="100" height="40"', 'font-size:20px;line-height:40px', 'Label')
              + '</g></svg>';
    const font = { family: '851tegakizatsu', faceCss: '@font-face{font-family:"851tegakizatsu";src:url(data:font/woff2;base64,AAA) format("woff2");}' };

    it('leads the stack, quoted, because a CSS family may not start with a digit', () => {
        const out = postProcessInfographicSvg(raw, halfEm, font);
        // Unquoted, the whole declaration is invalid and a browser falls back to
        // its default serif rather than to Arial.
        assert.match(out, /font-family="'851tegakizatsu', Arial, Helvetica, 'Liberation Sans', sans-serif"/);
    });

    it('is embedded in the SVG itself, where both renderers find it', () => {
        const out = postProcessInfographicSvg(raw, halfEm, font);
        assert.match(out, /^<svg [^>]*><defs><style>@font-face\{/);
        assert.ok(out.includes(font.faceCss));
    });

    it('changes nothing when the theme asked for no font we have', () => {
        const out = postProcessInfographicSvg(raw, halfEm);
        assert.ok(!out.includes('@font-face'), 'no face is embedded');
        assert.match(out, /font-family="Arial, Helvetica, 'Liberation Sans', sans-serif"/);
    });
});

describe('injectStyle', () => {
    it('puts the CSS in the SVG\'s own defs, right after the root tag', () => {
        assert.equal(injectStyle('<svg width="10"><g/></svg>', 'X{}'),
            '<svg width="10"><defs><style>X{}</style></defs><g/></svg>');
    });
});

describe('postProcessInfographicSvg', () => {
    it('leaves nothing WeasyPrint cannot draw', () => {
        const raw = '<?xml version="1.0" encoding="UTF-8"?>\n'
                  + '<?xml-stylesheet href="https://example.com/font.css" type="text/css"?>\n'
                  + '<svg font-family="Alibaba PuHuiTi"><g>'
                  + fo('x="0" y="0" width="100" height="40"', 'font-size:20px;line-height:40px;color:#000', 'Label')
                  + '</g></svg>';
        const out = postProcessInfographicSvg(raw, halfEm);
        assert.ok(!out.includes('<?'), 'no processing instructions');
        assert.ok(!out.includes('foreignObject'), 'no foreignObject');
        assert.ok(!out.includes('PuHuiTi'), 'no reference to the remote font');
        assert.match(out, /^<svg font-family="Arial, [^"]+"><g><text [^>]*><tspan [^>]*>Label<\/tspan><\/text><\/g><\/svg>$/);
    });
});
