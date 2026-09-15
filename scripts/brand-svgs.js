#!/usr/bin/env node
/**
 * brand-svgs.js — turns Affinity's SVG exports in brand/ into files whose colour
 * is set in one place, and writes a `-white.svg` copy of each.
 *
 * Affinity writes a colour into every path it draws, so recolouring a mark meant
 * editing each path by hand — and the next export undid it. This rewrites the
 * exports in place instead, so the .af file stays the only thing anyone edits:
 *
 *   - the ink becomes one `fill="currentColor"` on the root <svg>. Inline, the
 *     mark takes the CSS `color` around it; as an <img> it draws black.
 *   - a second colour shared by a whole group (the letter in
 *     platen-icon-filled.svg) becomes one `fill` on that group.
 *   - Affinity's DOCTYPE and unused namespace declarations go.
 *
 * The white copy is the same drawing with the ink white and a white second
 * colour turned black. It exists because CSS cannot reach inside a file loaded
 * through <img> or <picture>, which is how a README shows a logo.
 *
 * It also renders vscode-extension/icon.png from platen-icon-filled.svg: vsce
 * refuses an SVG icon, and a PNG kept by hand would drift from the drawing.
 *
 * Running it twice changes nothing. Run it after every export:  npm run brand
 */

const fs   = require('fs');
const path = require('path');

const BRAND = path.resolve(__dirname, '..', 'brand');
const WHITE_SUFFIX = '-white.svg';
const BLACK = /^(?:#000|#000000|black)$/i;

/** Removes the fill from one <path/> tag, returning the tag and the fill it had. */
function takeFill(tag) {
    let fill = null;
    const out = tag
        .replace(/\sfill="([^"]*)"/, (_, value) => { fill = value; return ''; })
        .replace(/\sstyle="([^"]*)"/, (_, style) => {
            const kept = style.split(';').map(d => d.trim()).filter(Boolean).filter(d => {
                const [name, value] = d.split(':').map(s => s.trim());
                if (name !== 'fill') return true;
                fill = value;
                return false;
            });
            return kept.length ? ` style="${kept.map(d => `${d};`).join('')}"` : '';
        });
    return { tag: out, fill };
}

function normalize(svg, file) {
    let out = svg
        .replace(/<!DOCTYPE[^>]*>\s*/, '')
        .replace(/\s(?:xmlns:xlink|xmlns:serif|xml:space)="[^"]*"/g, '');

    // Black is the ink. Left on a path, it would outrank the root's currentColor.
    out = out.replace(/<path\b[^>]*\/>/g, tag => {
        const { tag: bare, fill } = takeFill(tag);
        return fill !== null && BLACK.test(fill) ? bare : tag;
    });

    // A group whose paths all carry the same fill gets that fill once, on the group.
    out = out.replace(/<g([^>]*)>((?:\s*<path\b[^>]*\/>)+\s*)<\/g>/g, (whole, attrs, body) => {
        const paths = body.match(/<path\b[^>]*\/>/g).map(takeFill);
        const fills = new Set(paths.map(p => p.fill));
        if (fills.size !== 1 || fills.has(null)) return whole;
        const [fill] = fills;
        let i = 0;
        const newBody = body.replace(/<path\b[^>]*\/>/g, () => paths[i++].tag);
        return `<g${attrs.replace(/\sfill="[^"]*"/, '')} fill="${fill}">${newBody}</g>`;
    });

    const stray = out.match(/<path\b[^>]*(?:\sfill="|[";]fill:)[^>]*\/>/);
    if (stray) {
        throw new Error(
            `${file}: a path has its own fill, and it is not shared by the rest of its group.\n` +
            '  This script only knows how to move a colour that a whole group shares onto that group.\n' +
            '  In Affinity, group the shapes that share a colour, then export again.',
        );
    }

    return out.replace(/<svg\b([^>]*)>/, (_, attrs) =>
        `<svg fill="currentColor"${attrs.replace(/\sfill="[^"]*"/, '')}>`);
}

function whiteCopy(svg) {
    return svg
        .replace(/(<g\b[^>]*\s)fill="(?:#fff|#ffffff|white)"/gi, '$1fill="#000"')
        .replace('<svg fill="currentColor"', '<svg fill="#fff"');
}

function writeIfChanged(file, content) {
    const full = path.join(BRAND, file);
    if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') === content) return false;
    fs.writeFileSync(full, content);
    return true;
}

const files = fs.readdirSync(BRAND).filter(f => f.endsWith('.svg'));
const sources = files.filter(f => !f.endsWith(WHITE_SUFFIX));

for (const file of sources) {
    let svg;
    try {
        svg = normalize(fs.readFileSync(path.join(BRAND, file), 'utf8'), file);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    const white = file.replace(/\.svg$/, WHITE_SUFFIX);
    const changed = [writeIfChanged(file, svg) && file, writeIfChanged(white, whiteCopy(svg)) && white];
    console.log(`${file}: ${changed.filter(Boolean).join(', ') || 'up to date'}`);
}

// A white copy whose source was deleted or renamed would otherwise ship forever.
for (const white of files.filter(f => f.endsWith(WHITE_SUFFIX))) {
    if (!sources.includes(white.replace(WHITE_SUFFIX, '.svg'))) {
        fs.unlinkSync(path.join(BRAND, white));
        console.log(`${white}: removed (no ${white.replace(WHITE_SUFFIX, '.svg')})`);
    }
}

// The extension icon. 256 px covers the Marketplace's 128 px slot on high-DPI screens.
const EXTENSION_ICON = path.resolve(__dirname, '..', 'vscode-extension', 'icon.png');

require('sharp')(fs.readFileSync(path.join(BRAND, 'platen-icon-filled.svg')))
    .resize(256, 256)
    .png()
    .toBuffer()
    .then(png => {
        const same = fs.existsSync(EXTENSION_ICON) && fs.readFileSync(EXTENSION_ICON).equals(png);
        if (!same) fs.writeFileSync(EXTENSION_ICON, png);
        console.log(`vscode-extension/icon.png: ${same ? 'up to date' : 'rendered from platen-icon-filled.svg'}`);
    })
    .catch(err => {
        console.error(err.message);
        process.exit(1);
    });
