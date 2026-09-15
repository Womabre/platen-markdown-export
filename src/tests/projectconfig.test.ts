import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    CONFIG_FILENAME, expandHome, findProjectConfigs, userConfigPath,
    readConfig, themePathsFrom, discoveredThemeRoots,
} from '../projectconfig';
import { CONFIG_FILENAME as THEME_CONFIG_FILENAME } from '../theme';
import { setQuiet } from '../logger';

/**
 * `--theme-path` made external themes usable; it did not make a document that
 * uses one portable. The flag has to be supplied on every invocation, so the VS
 * Code extension (which passes it from a setting) exported fine while the same
 * document from a task, a terminal or CI failed with "Theme not found" — naming
 * a theme that is installed, just not on that run's search path.
 *
 * A document is not portable if the only place its theme is known is one
 * editor's settings. This is the file that fixes that.
 */

setQuiet(true);

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-cfg-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Creates `sub/` under the scratch dir, with an optional config file in it. */
function make(sub: string, config?: unknown): string {
    const d = path.join(dir, sub);
    fs.mkdirSync(d, { recursive: true });
    if (config !== undefined) {
        fs.writeFileSync(path.join(d, CONFIG_FILENAME),
                         typeof config === 'string' ? config : JSON.stringify(config));
    }
    return d;
}

describe('CONFIG_FILENAME', () => {
    it('agrees with the copy theme.ts names in its error', () => {
        // theme.ts cannot import this module — that would close a cycle, since
        // projectconfig imports splitThemePath from theme — so the constant is
        // duplicated and pinned here instead.
        assert.equal(THEME_CONFIG_FILENAME, CONFIG_FILENAME);
    });
});

describe('expandHome', () => {
    it('expands a leading ~/', () => {
        assert.equal(expandHome('~/Dev/themes', '/Users/x'), path.join('/Users/x', 'Dev/themes'));
    });

    it('expands a bare ~', () => {
        assert.equal(expandHome('~', '/Users/x'), '/Users/x');
    });

    it('leaves a directory that merely starts with ~ alone', () => {
        // `~backup` is a name, not a home reference.
        assert.equal(expandHome('~backup/themes', '/Users/x'), '~backup/themes');
    });

    it('leaves an ordinary path alone', () => {
        assert.equal(expandHome('/abs/themes', '/Users/x'), '/abs/themes');
        assert.equal(expandHome('./rel', '/Users/x'), './rel');
    });
});

describe('findProjectConfigs', () => {
    it('finds a config beside the document', () => {
        const d = make('walk-a', { themePaths: ['./t'] });
        assert.deepEqual(findProjectConfigs(d), [path.join(d, CONFIG_FILENAME)]);
    });

    it('walks up to find one above the document', () => {
        const root = make('walk-b', { themePaths: ['./t'] });
        const deep = make('walk-b/docs/chapters');
        assert.deepEqual(findProjectConfigs(deep), [path.join(root, CONFIG_FILENAME)]);
    });

    it('returns every config on the way up, nearest first', () => {
        // Nearest wins, so the order is the precedence.
        const outer = make('walk-c', { themePaths: ['./outer'] });
        const inner = make('walk-c/docs', { themePaths: ['./inner'] });
        assert.deepEqual(findProjectConfigs(inner),
                         [path.join(inner, CONFIG_FILENAME), path.join(outer, CONFIG_FILENAME)]);
    });

    it('finds nothing when there is nothing to find', () => {
        const d = make('walk-d');
        // The scratch directory is under tmp, which has no config above it.
        assert.deepEqual(findProjectConfigs(d).filter(f => f.startsWith(dir)), []);
    });

    it('ignores a directory that merely shares the name', () => {
        const d = make('walk-e');
        fs.mkdirSync(path.join(d, CONFIG_FILENAME));
        assert.deepEqual(findProjectConfigs(d).filter(f => f.startsWith(dir)), []);
    });
});

describe('themePathsFrom', () => {
    it('resolves a relative path against the config file, not the cwd', () => {
        // What makes a committed {"themePaths": ["./themes"]} work on every
        // machine that checks the repository out.
        const d = make('rel', { themePaths: ['./themes', '../shared'] });
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME)),
                         [path.join(d, 'themes'), path.resolve(d, '../shared')]);
    });

    it('expands ~ in an entry', () => {
        const d = make('tilde', { themePaths: ['~/Dev/t'] });
        // Anchored to the config file's own directory, which is how the
        // implementation resolves it. On Windows a POSIX-rooted path is
        // drive-RELATIVE, so `path.resolve('/Users/x')` would pick up the
        // current drive while the implementation picks up the config's.
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME), '/Users/x'),
                         [path.resolve(d, path.join('/Users/x', 'Dev/t'))]);
    });

    it('accepts a PATH-style entry', () => {
        const d = make('multi', { themePaths: [['/a', '/b'].join(path.delimiter)] });
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME)),
                         [path.resolve(d, '/a'), path.resolve(d, '/b')]);
    });

    it('is empty for a config that declares none', () => {
        const d = make('none', { somethingElse: true });
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME)), []);
    });

    it('ignores a themePaths that is not an array', () => {
        const d = make('badtype', { themePaths: '/a' });
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME)), []);
    });

    it('drops non-string entries rather than failing', () => {
        const d = make('mixed', { themePaths: ['/a', 42, null] });
        assert.deepEqual(themePathsFrom(path.join(d, CONFIG_FILENAME)), [path.resolve(d, '/a')]);
    });
});

describe('readConfig', () => {
    it('warns and continues on malformed JSON', () => {
        // A convenience layer must not refuse to render a document because a
        // file two directories up has a stray comma.
        const d = make('broken', '{ not json');
        assert.deepEqual(readConfig(path.join(d, CONFIG_FILENAME)), {});
    });

    it('ignores a config that is an array', () => {
        const d = make('array', [1, 2]);
        assert.deepEqual(readConfig(path.join(d, CONFIG_FILENAME)), {});
    });

    it('returns nothing for a file that is not there', () => {
        assert.deepEqual(readConfig(path.join(dir, 'nope', CONFIG_FILENAME)), {});
    });
});

describe('userConfigPath', () => {
    it('follows each platform\'s convention', () => {
        assert.equal(userConfigPath('linux', {}, '/home/w'),
                     path.join('/home/w', '.config', 'platen-markdown-export', 'config.json'));
        assert.equal(userConfigPath('darwin', {}, '/Users/w'),
                     path.join('/Users/w', '.config', 'platen-markdown-export', 'config.json'));
        assert.equal(userConfigPath('win32', { APPDATA: 'C:\\AppData' }, 'C:\\Users\\w'),
                     path.join('C:\\AppData', 'platen-markdown-export', 'config.json'));
    });

    it('honours XDG_CONFIG_HOME', () => {
        assert.equal(userConfigPath('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/w'),
                     path.join('/xdg', 'platen-markdown-export', 'config.json'));
    });

    it('is null with no home directory to anchor to', () => {
        assert.equal(userConfigPath('linux', {}, ''), null);
    });
});

describe('discoveredThemeRoots', () => {
    it('collects project configs nearest-first', () => {
        const outer = make('disc/a', { themePaths: ['/outer'] });
        const inner = make('disc/a/docs', { themePaths: ['/inner'] });
        const roots = discoveredThemeRoots(inner, 'linux', {}, path.join(dir, 'nohome'));
        assert.deepEqual(roots.slice(0, 2),
                         [path.resolve(inner, '/inner'), path.resolve(outer, '/outer')]);
    });

    it('appends the user config beneath the project ones', () => {
        // Project beats machine: a repository that ships its own themes should
        // not be overridden by whatever is set globally.
        const home = make('disc-home');
        fs.mkdirSync(path.join(home, '.config', 'platen-markdown-export'), { recursive: true });
        fs.writeFileSync(path.join(home, '.config', 'platen-markdown-export', 'config.json'),
                         JSON.stringify({ themePaths: ['/from-user'] }));
        const project = make('disc/b', { themePaths: ['/from-project'] });

        const userDir = path.join(home, '.config', 'platen-markdown-export');
        assert.deepEqual(discoveredThemeRoots(project, 'linux', {}, home),
                         [path.resolve(project, '/from-project'),
                          path.resolve(userDir, '/from-user')]);
    });

    it('is empty when nothing declares anything', () => {
        const d = make('disc/c');
        assert.deepEqual(discoveredThemeRoots(d, 'linux', {}, path.join(dir, 'nohome')), []);
    });
});
