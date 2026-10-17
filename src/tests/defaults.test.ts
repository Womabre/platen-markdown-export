import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { discoveredFrontmatterDefaults, discoveredTemplateRoots, CONFIG_FILENAME, NOT_DEFAULTABLE } from '../projectconfig';
import { withDefaults, extractFrontmatter } from '../frontmatter';
import { FRONTMATTER_KEYS } from '../frontmatter-keys';
import { main } from '../index';
import { setQuiet, resetWarnings, warningCount } from '../logger';

/**
 * `frontmatterDefaults`: a folder's documents share keys without each one
 * restating them. Every walk here passes its own home and environment, so a
 * real user config on the test machine cannot leak in.
 */

setQuiet(true);

let root: string;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-defaults-')); });
after(()  => { fs.rmSync(root, { recursive: true, force: true }); });

/** A directory under the temp root, created, with an optional config in it. */
function folder(rel: string, config?: object): string {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    if (config) fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config));
    return dir;
}

/** The defaults for `dir` with a user config of `user` (or none), isolated from the real machine. */
function defaultsFor(dir: string, user?: object) {
    const home = path.join(root, 'home-' + path.basename(dir));
    const env = { XDG_CONFIG_HOME: path.join(home, '.config') };
    if (user) {
        fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'platen-markdown-export'), { recursive: true });
        fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'platen-markdown-export', 'config.json'), JSON.stringify(user));
    }
    return discoveredFrontmatterDefaults(dir, 'linux', env, home);
}

describe('discoveredFrontmatterDefaults', () => {
    it('is empty without any config', () => {
        assert.deepEqual(defaultsFor(folder('none')), { values: {}, sources: {} });
    });

    it('lets the nearest config win per key, case-insensitively', () => {
        folder('a', { frontmatterDefaults: { Theme: 'modern', Style: 'Cherry', Classification: 'Internal' } });
        const near = folder('a/b', { frontmatterDefaults: { theme: 'default' } });
        const { values, sources } = defaultsFor(near);
        assert.deepEqual(values, { Style: 'Cherry', Classification: 'Internal', theme: 'default' });
        assert.equal(sources.theme, path.join(near, CONFIG_FILENAME));
        assert.equal(sources.Style, path.join(root, 'a', CONFIG_FILENAME));
    });

    it('puts the user config underneath every project config', () => {
        const dir = folder('u', { frontmatterDefaults: { Theme: 'gaia' } });
        const { values } = defaultsFor(dir, { frontmatterDefaults: { Theme: 'modern', Lang: 'nl' } });
        assert.deepEqual(values, { Lang: 'nl', Theme: 'gaia' });
    });

    it('merges Variables per name instead of replacing them', () => {
        const dir = folder('v', { frontmatterDefaults: { Variables: { Customer: 'Acme' } } });
        const { values } = defaultsFor(dir, { frontmatterDefaults: { Variables: { Company: 'Us', Customer: 'Nobody' } } });
        assert.deepEqual(values.Variables, { Company: 'Us', Customer: 'Acme' });
    });

    it('refuses the keys a default may not set, and warns', () => {
        resetWarnings();
        const dir = folder('nd', { frontmatterDefaults: { Mode: 'pdf', Title: 'x', 'document info': {}, Theme: 'gaia' } });
        const { values } = defaultsFor(dir);
        assert.deepEqual(values, { Theme: 'gaia' });
        assert.equal(warningCount(), 3);
    });

    it('warns about a misspelled default key, naming the file', () => {
        resetWarnings();
        defaultsFor(folder('typo', { frontmatterDefaults: { Clasification: 'Internal' } }));
        assert.equal(warningCount(), 1);
    });

    it('warns and ignores a frontmatterDefaults that is not an object', () => {
        resetWarnings();
        assert.deepEqual(defaultsFor(folder('bad', { frontmatterDefaults: ['Theme'] })).values, {});
        assert.equal(warningCount(), 1);
    });

    it('only refuses keys the exporter knows', () => {
        const known = new Set(FRONTMATTER_KEYS.flatMap(k => [k.key, ...(k.aliases ?? [])]).map(k => k.toLowerCase()));
        for (const key of NOT_DEFAULTABLE) assert.ok(known.has(key.toLowerCase()), key);
    });
});

describe('discoveredTemplateRoots', () => {
    it('resolves templatePaths against the config file', () => {
        const dir = folder('t', { templatePaths: ['./my-templates'] });
        const home = path.join(root, 'home-t');
        assert.deepEqual(discoveredTemplateRoots(dir, 'linux', {}, home), [path.join(dir, 'my-templates')]);
    });
});

describe('withDefaults', () => {
    it('fills in only what the document does not set, in any casing', () => {
        assert.deepEqual(withDefaults({ theme: 'gaia', Title: 'T' }, { Theme: 'modern', Style: 'Navy' }),
            { theme: 'gaia', Title: 'T', Style: 'Navy' });
    });

    it('lets the document override single variables', () => {
        assert.deepEqual(withDefaults({ Variables: { Customer: 'Mine' } }, { Variables: { Customer: 'Acme', Site: 'Borne' } }),
            { Variables: { Customer: 'Mine', Site: 'Borne' } });
    });

    it('treats frontmatter that is not a mapping as empty', () => {
        assert.deepEqual(withDefaults(undefined, { Theme: 'gaia' }), { Theme: 'gaia' });
    });

    it('feeds extractFrontmatter', () => {
        const fm = extractFrontmatter('virtual.md', '---\nTitle: T\n---\n', { Theme: 'gaia', Classification: 'Internal' });
        assert.equal(fm.theme, 'gaia');
        assert.equal(fm.classification, 'Internal');
    });
});

describe('main() with frontmatter defaults', () => {
    it('exports with the folder\'s defaults, the document winning, and never writes them into it', async () => {
        const dir = folder('export', { frontmatterDefaults: {
            Theme: 'default', Style: 'Navy', Variables: { Customer: 'Acme Manufacturing', Site: 'Borne' },
        } });
        const file = path.join(dir, 'doc.md');
        const source = [
            '---', 'Title: Defaults', 'Mode: html', 'Variables:', '  Site: Hengelo', '---', '',
            '# Defaults', '', 'For {{Customer}} at {{Site}}.', '',
        ].join('\n');
        fs.writeFileSync(file, source);

        await main({ argv: ['--quiet', '--no-bump', '--strict', file] });

        const html = fs.readFileSync(path.join(dir, 'doc.html'), 'utf8');
        assert.match(html, /For Acme Manufacturing at Hengelo\./);
        assert.equal(fs.readFileSync(file, 'utf8'), source, 'the document is untouched');
    });
});
