import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as path from 'path';
import { documentLabels } from '../labels';
import { applyCaptions } from '../markdown-extras';
import { buildGlossary } from '../markdown';
import { listThemes, THEMES_DIR } from '../theme';

describe('documentLabels', () => {
    it('returns the Dutch labels for nl', () => {
        const nl = documentLabels('nl');
        assert.equal(nl.table, 'Tabel');
        assert.equal(nl.figure, 'Figuur');
        assert.equal(nl.listOfTables, 'Lijst van tabellen');
    });

    it('reads only the primary subtag, in any case', () => {
        for (const lang of ['nl-NL', 'NL', 'nl_BE', ' nl ']) {
            assert.equal(documentLabels(lang).table, 'Tabel', lang);
        }
    });

    it('falls back to English for an unknown or missing language', () => {
        for (const lang of ['xx', '', null, undefined]) {
            assert.equal(documentLabels(lang).listOfTables, 'List of Tables', String(lang));
        }
    });
});

describe('applyCaptions follows the document language', () => {
    const table  = '<table><tr><td>1</td></tr></table><p>Table: cijfers</p>';
    const figure = '<p><img src="x.png" alt="x"></p><p>Figure: plaatje</p>';

    it('labels a Dutch table caption "Tabel"', () => {
        assert.match(applyCaptions(table, 'nl'), /<span class="caption-label">Tabel 1\.<\/span> cijfers/);
    });

    it('labels a Dutch figure caption "Figuur"', () => {
        assert.match(applyCaptions(figure, 'nl'), /<span class="caption-label">Figuur 1\.<\/span> plaatje/);
    });

    it('stays English without a language', () => {
        assert.match(applyCaptions(table), /Table 1\.<\/span>/);
    });
});

describe('buildGlossary reads the shared label table', () => {
    it('localises a regional Dutch tag too', () => {
        const html = buildGlossary('*[API]: Application Programming Interface', 'nl-NL');
        assert.ok(html.includes('<h2>Afkortingen</h2>'));
        assert.ok(html.includes('<th>Afkorting</th><th>Omschrijving</th>'));
    });
});

describe('every theme gives the caption indexes a page number WeasyPrint can resolve', () => {
    // WeasyPrint 70 resolves target-counter() to 0 inside a flex item's
    // pseudo-element. The TOC was moved off flex for exactly that; the List of
    // Tables / Figures kept it and printed page 0 for every entry. Each theme
    // must put the page number in a leader() rule, the shape the TOC uses.
    for (const name of listThemes()) {
        const file = path.join(THEMES_DIR, name, 'css', 'theme.css');
        if (!fs.existsSync(file)) continue;

        it(`${name} uses leader() + target-counter() for nav.caption-index`, () => {
            const css = fs.readFileSync(file, 'utf8');
            assert.match(css,
                /nav\.caption-index a::after\s*\{[^}]*content:\s*leader\(dotted\) target-counter\(attr\(href\), page\)/,
                `${name}: caption index has no leader()/target-counter() rule`);
        });
    }
});
