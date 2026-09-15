import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { cacheDir, cacheRoot, clearCache, readCache, writeCache } from '../cache';

/**
 * The on-disk cache for immutable remote assets.
 *
 * Its security property is the interesting one: entries are trusted on the next
 * read and inlined straight into a PDF, so the directory must not be somewhere
 * another user can write. Three of the four platform branches are unreachable
 * from the machine running this suite, which is why they are parameters.
 */

describe('cacheDir', () => {
    it('is under the user\'s own home, never the shared temp directory', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
            const dir = cacheDir('icon-cache', platform, {}, '/home/someone');
            assert.ok(!dir.startsWith(os.tmpdir()), `${platform}: ${dir}`);
            assert.ok(dir.includes('/home/someone') || dir.includes('\\home\\someone'), dir);
        }
    });

    // `cacheDir` takes the platform as a parameter so the three branches can be
    // asserted from one machine — but it still joins with the HOST's separator,
    // because in production the two always agree. So these compare against a
    // `path.join` of the components rather than against a literal containing
    // `/`: a hardcoded separator asserts the machine running the suite, not the
    // branch under test, and these two failed on the Windows CI leg for exactly
    // that reason while passing everywhere else.
    it('follows each platform\'s own cache convention', () => {
        assert.equal(cacheDir('icon-cache', 'darwin', {}, '/Users/w'),
                     path.join('/Users/w', 'Library', 'Caches', 'platen-markdown-export', 'icon-cache'));
        assert.equal(cacheDir('icon-cache', 'linux', {}, '/home/w'),
                     path.join('/home/w', '.cache', 'platen-markdown-export', 'icon-cache'));
        assert.equal(cacheDir('icon-cache', 'win32', {}, 'C:\\Users\\w'),
                     path.join('C:\\Users\\w', 'AppData', 'Local', 'platen-markdown-export', 'icon-cache'));
    });

    it('honours XDG_CACHE_HOME on Linux', () => {
        assert.equal(cacheDir('emoji', 'linux', { XDG_CACHE_HOME: '/xdg' }, '/home/w'),
                     path.join('/xdg', 'platen-markdown-export', 'emoji'));
    });

    it('honours LOCALAPPDATA on Windows', () => {
        assert.equal(cacheDir('emoji', 'win32', { LOCALAPPDATA: 'D:\\cache' }, 'C:\\Users\\w'),
                     path.join('D:\\cache', 'platen-markdown-export', 'emoji'));
    });

    it('separates namespaces', () => {
        assert.notEqual(cacheDir('icon-cache', 'linux', {}, '/home/w'),
                        cacheDir('emoji',      'linux', {}, '/home/w'));
    });

    it('falls back to a private temp subdirectory when there is no home', () => {
        const dir = cacheDir('emoji', 'linux', {}, '');
        assert.ok(dir.startsWith(os.tmpdir()), dir);
        assert.ok(dir !== os.tmpdir(), 'still its own directory, not the shared root');
    });
});

describe('readCache / writeCache', () => {
    // Redirect HOME so the round-trip lands in a temp directory rather than the
    // developer's real cache.
    const withTempHome = <T>(fn: () => T): T => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-cache-'));
        const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CACHE_HOME, LAD: process.env.LOCALAPPDATA };
        process.env.XDG_CACHE_HOME = home;
        process.env.LOCALAPPDATA   = home;
        process.env.HOME           = home;
        try { return fn(); }
        finally {
            process.env.HOME = saved.HOME;
            if (saved.XDG === undefined) { delete process.env.XDG_CACHE_HOME; } else { process.env.XDG_CACHE_HOME = saved.XDG; }
            if (saved.LAD === undefined) { delete process.env.LOCALAPPDATA; }  else { process.env.LOCALAPPDATA = saved.LAD; }
            fs.rmSync(home, { recursive: true, force: true });
        }
    };

    it('returns null for a key that was never written', () => {
        assert.equal(readCache('emoji', 'https://example.com/never-seen.svg'), null);
    });

    it('never throws when the cache cannot be written', () => {
        // A cache that fails must not fail the export it was meant to speed up.
        assert.doesNotThrow(() => writeCache('\0invalid', 'k', 'v'));
    });

    it('keys by content, so two URLs never collide', () => {
        withTempHome(() => {
            writeCache('emoji', 'https://cdn/a.svg', 'AAA');
            writeCache('emoji', 'https://cdn/b.svg', 'BBB');
            assert.equal(readCache('emoji', 'https://cdn/a.svg'), 'AAA');
            assert.equal(readCache('emoji', 'https://cdn/b.svg'), 'BBB');
        });
    });

    it('round-trips a value a URL could never be a filename for', () => {
        withTempHome(() => {
            const key = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/1f680.svg';
            writeCache('emoji', key, 'data:image/svg+xml;base64,AAAA');
            assert.equal(readCache('emoji', key), 'data:image/svg+xml;base64,AAAA');
        });
    });

    it('keeps namespaces apart for the same key', () => {
        withTempHome(() => {
            writeCache('emoji',      'k', 'from-emoji');
            writeCache('icon-cache', 'k', 'from-icons', '.css');
            assert.equal(readCache('emoji', 'k'), 'from-emoji');
            assert.equal(readCache('icon-cache', 'k', '.css'), 'from-icons');
        });
    });
});

// ── cacheRoot / clearCache ────────────────────────────────────────────────────

describe('cacheRoot', () => {
    it('is the parent every namespace lives under', () => {
        // So clearing it clears all of them, with nothing left to guess at.
        const home = '/home/x';
        for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
            const root = cacheRoot(platform, {}, home);
            for (const ns of ['icon-cache', 'emoji']) {
                assert.equal(path.dirname(cacheDir(ns, platform, {}, home)), root, `${platform}/${ns}`);
            }
        }
    });

    it('ends in a directory of our own, never a bare cache dir', () => {
        // Removing it must not take the user's whole ~/.cache with it.
        assert.equal(path.basename(cacheRoot('linux', {}, '/home/x')), 'platen-markdown-export');
    });
});

describe('clearCache', () => {
    it('reports the directory and that there was nothing there', () => {
        // Nothing in the cache is authored — every entry is a re-fetchable
        // remote asset — so clearing an absent one is a no-op, not an error.
        const before = clearCache();
        assert.equal(before.dir, cacheRoot());
        const after = clearCache();
        assert.equal(after.existed, false, 'a second clear finds nothing');
    });

    it('removes a written entry, and a later read misses', () => {
        writeCache('emoji', 'https://example.invalid/a.svg', 'data:image/svg+xml;base64,AAA');
        assert.ok(readCache('emoji', 'https://example.invalid/a.svg'), 'precondition: the entry is there');

        const { existed } = clearCache();
        assert.equal(existed, true);
        assert.equal(readCache('emoji', 'https://example.invalid/a.svg'), null);
    });
});
