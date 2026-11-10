import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLimiter, mapPool } from '../concurrency';
import { writeFileAtomic, windowsAppDir } from '../fsutil';

const defer = () => new Promise<void>(r => setImmediate(r));

describe('createLimiter', () => {
    it('never runs more than `limit` tasks at once', async () => {
        const run = createLimiter(3);
        let active = 0;
        let peak   = 0;

        await Promise.all(Array.from({ length: 20 }, () => run(async () => {
            peak = Math.max(peak, ++active);
            await defer();
            active--;
        })));

        assert.equal(peak, 3);
        assert.equal(active, 0);
    });

    it('treats a limit below 1 as 1', async () => {
        const run = createLimiter(0);
        let active = 0;
        let peak   = 0;

        await Promise.all(Array.from({ length: 5 }, () => run(async () => {
            peak = Math.max(peak, ++active);
            await defer();
            active--;
        })));

        assert.equal(peak, 1);
    });

    it('releases the slot when a task rejects, so the gate never wedges', async () => {
        const run = createLimiter(1);

        await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);

        // A wedged limiter would leave this pending forever.
        assert.equal(await run(async () => 'still works'), 'still works');
    });

    it('starts queued tasks in submission order', async () => {
        const run   = createLimiter(1);
        const order: number[] = [];

        await Promise.all([1, 2, 3, 4].map(n => run(async () => {
            order.push(n);
            await defer();
        })));

        assert.deepEqual(order, [1, 2, 3, 4]);
    });
});

describe('mapPool', () => {
    it('preserves input order regardless of completion order', async () => {
        const delays = [40, 5, 30, 1, 20];
        const out = await mapPool(delays, 2, async (ms, i) => {
            await new Promise(r => setTimeout(r, ms));
            return i;
        });
        assert.deepEqual(out, [0, 1, 2, 3, 4]);
    });

    it('passes the index alongside the item', async () => {
        const out = await mapPool(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
        assert.deepEqual(out, ['0:a', '1:b', '2:c']);
    });

    it('caps in-flight work below the item count', async () => {
        let active = 0;
        let peak   = 0;
        await mapPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
            peak = Math.max(peak, ++active);
            await defer();
            active--;
        });
        assert.equal(peak, 4);
    });

    it('rejects on the first task failure, like Promise.all', async () => {
        await assert.rejects(
            mapPool([1, 2, 3], 2, async n => { if (n === 2) throw new Error('nope'); return n; }),
            /nope/,
        );
    });

    it('returns an empty array for no items', async () => {
        assert.deepEqual(await mapPool([], 4, async () => 1), []);
    });
});

describe('writeFileAtomic', () => {
    const withTmpDir = <T>(fn: (dir: string) => T): T => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-atomic-'));
        try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };

    it('creates a new file', () => withTmpDir(dir => {
        const target = path.join(dir, 'new.md');
        writeFileAtomic(target, 'hello');
        assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    }));

    it('replaces an existing file', () => withTmpDir(dir => {
        const target = path.join(dir, 'doc.md');
        fs.writeFileSync(target, 'old', 'utf8');
        writeFileAtomic(target, 'new');
        assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    }));

    it('leaves no temp file behind on success', () => withTmpDir(dir => {
        writeFileAtomic(path.join(dir, 'doc.md'), 'x');
        assert.deepEqual(fs.readdirSync(dir), ['doc.md']);
    }));

    it('preserves the existing file mode', { skip: process.platform === 'win32' }, () => withTmpDir(dir => {
        const target = path.join(dir, 'doc.md');
        fs.writeFileSync(target, 'old', 'utf8');
        fs.chmodSync(target, 0o640);
        writeFileAtomic(target, 'new');
        assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    }));

    it('leaves the original intact and cleans up when the write fails', () => withTmpDir(dir => {
        const target = path.join(dir, 'doc.md');
        fs.writeFileSync(target, 'original', 'utf8');

        // A directory where the temp file wants to be: writeFileSync throws EISDIR.
        fs.mkdirSync(path.join(dir, `.doc.md.${process.pid}.tmp`));

        assert.throws(() => writeFileAtomic(target, 'replacement'));
        assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    }));

    // rename() replaces the name it is given, so writing "atomically" onto a
    // symlink used to swap the link for a regular file and leave the document it
    // pointed at unchanged.
    it('writes through a symlink instead of replacing it', { skip: process.platform === 'win32' }, () => withTmpDir(dir => {
        const real = path.join(dir, 'real.md');
        const link = path.join(dir, 'link.md');
        fs.writeFileSync(real, 'old', 'utf8');
        fs.symlinkSync(real, link);

        writeFileAtomic(link, 'new');

        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link must still be a link');
        assert.equal(fs.readFileSync(real, 'utf8'), 'new', 'the target must receive the write');
        assert.deepEqual(fs.readdirSync(dir).sort(), ['link.md', 'real.md']);
    }));

    it('puts the temp file beside a symlink\'s target, not beside the link', { skip: process.platform === 'win32' }, () => withTmpDir(dir => {
        fs.mkdirSync(path.join(dir, 'elsewhere'));
        const real = path.join(dir, 'elsewhere', 'real.md');
        const link = path.join(dir, 'link.md');
        fs.writeFileSync(real, 'old', 'utf8');
        fs.symlinkSync(real, link);

        writeFileAtomic(link, 'new');

        assert.equal(fs.readFileSync(real, 'utf8'), 'new');
        assert.deepEqual(fs.readdirSync(dir).sort(), ['elsewhere', 'link.md']);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'elsewhere')), ['real.md']);
    }));

    it('still creates a file through a dangling symlink\'s own path', { skip: process.platform === 'win32' }, () => withTmpDir(dir => {
        const link = path.join(dir, 'link.md');
        fs.symlinkSync(path.join(dir, 'missing.md'), link);
        writeFileAtomic(link, 'new');
        assert.equal(fs.readFileSync(link, 'utf8'), 'new');
    }));

    it('round-trips UTF-8 content', () => withTmpDir(dir => {
        const target = path.join(dir, 'doc.md');
        const body   = '# Café — naïve ✓\n\nBøx\n';
        writeFileAtomic(target, body);
        assert.equal(fs.readFileSync(target, 'utf8'), body);
    }));
});

// ── windowsAppDir ─────────────────────────────────────────────────────────────

describe('windowsAppDir', () => {
    // The point of this function is the null. Callers used to write
    // `path.join(process.env.LOCALAPPDATA ?? '', …)`, which does not degrade to
    // "no candidate" but to a RELATIVE path resolved against the working
    // directory — the user's document folder. `findWeasyprint` merely looked
    // there; `installWeasyprintWindows` created it and unpacked an executable
    // into it. Every branch is unreachable from the machine running this suite,
    // which is why the environment and home are parameters.
    it('prefers the environment variable when it is set', () => {
        assert.equal(windowsAppDir('Local',   { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\x'), 'C:\\L');
        assert.equal(windowsAppDir('Roaming', { APPDATA:      'C:\\R' }, 'C:\\Users\\x'), 'C:\\R');
    });

    it('falls back to the standard path under the home directory', () => {
        assert.equal(windowsAppDir('Local',   {}, '/home/x'), path.join('/home/x', 'AppData', 'Local'));
        assert.equal(windowsAppDir('Roaming', {}, '/home/x'), path.join('/home/x', 'AppData', 'Roaming'));
    });

    it('reads each kind from its own variable, never the other', () => {
        assert.equal(windowsAppDir('Local', { APPDATA: 'C:\\R' }, '/home/x'),
                     path.join('/home/x', 'AppData', 'Local'));
    });

    it('returns null — never a relative path — when there is nothing to build from', () => {
        assert.equal(windowsAppDir('Local',   {}, ''), null);
        assert.equal(windowsAppDir('Roaming', {}, ''), null);
    });

    it('treats an empty variable as unset', () => {
        assert.equal(windowsAppDir('Local', { LOCALAPPDATA: '' }, '/home/x'),
                     path.join('/home/x', 'AppData', 'Local'));
    });
});
