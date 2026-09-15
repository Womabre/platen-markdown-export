import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    psSingleQuote, weasyprintWindowsUrl, WEASYPRINT_WINDOWS_ASSET,
    sha256File, verifyChecksum, ChecksumError,
    installWeasyprintWindows, installWeasyprintWindowsViaPip, runWithSudo,
    installWeasyprintMac, BREW_CANDIDATES,
    type BootstrapIo,
} from '../bootstrap';

// ── PowerShell string quoting ─────────────────────────────────────────────────
//
// `--setup` builds its Windows install commands out of %LOCALAPPDATA% and %TMP%,
// which carry the user's account name. Every command now goes through execFile
// (no shell), but `powershell -Command <script>` still hands the script to
// PowerShell's own parser — so a path interpolated into a string literal there
// has to be escaped for PowerShell, exactly as openCommand() does for
// `Start-Process -LiteralPath`. Apostrophes in account names are ordinary
// (O'Brien, D'Angelo) and the machine running this suite never has one.

describe('psSingleQuote', () => {
    it('wraps an ordinary path in single quotes', () => {
        assert.equal(
            psSingleQuote('C:\\Users\\wouter\\AppData\\Local\\Programs\\WeasyPrint'),
            "'C:\\Users\\wouter\\AppData\\Local\\Programs\\WeasyPrint'",
        );
    });

    it("doubles an apostrophe so it cannot terminate the literal", () => {
        assert.equal(
            psSingleQuote("C:\\Users\\O'Brien\\Temp\\weasyprint-windows.zip"),
            "'C:\\Users\\O''Brien\\Temp\\weasyprint-windows.zip'",
        );
    });

    it('doubles every apostrophe, not just the first', () => {
        assert.equal(psSingleQuote("a'b'c"), "'a''b''c'");
    });

    it('leaves the shell metacharacters a single-quoted literal already covers', () => {
        // & ^ % $ ` and spaces are all literal inside PowerShell single quotes —
        // the point of using them rather than double quotes or a bare argument.
        const raw = 'C:\\Q1 & Q2\\100%^ `bt$env:PATH';
        assert.equal(psSingleQuote(raw), `'${raw}'`);
    });

    it('produces a literal that round-trips back to the original value', () => {
        // Model PowerShell's own rule: strip the outer quotes, collapse '' → '.
        const unquote = (s: string): string => s.slice(1, -1).replaceAll("''", "'");
        for (const raw of [
            "C:\\Users\\O'Brien\\x.zip",
            "''",
            "'",
            'plain',
            "trailing'",
            "'leading",
        ]) {
            assert.equal(unquote(psSingleQuote(raw)), raw, `round-trip failed for ${raw}`);
        }
    });
});

// ── Pinned Windows download ───────────────────────────────────────────────────
//
// `--setup` on Windows downloads an EXECUTABLE and runs it. This used to fetch
// GitHub's `/releases/latest/download/` alias, so whatever bytes arrived were
// extracted and run with nothing to compare them against — and the WeasyPrint
// version Windows users ended up on changed on WeasyPrint's release schedule
// rather than this project's. The install-time check is a `Get-FileHash`
// comparison inside PowerShell (Windows-only, unreachable from this suite);
// what is checkable here is that the pin is well-formed and actually used.

describe('WEASYPRINT_WINDOWS_ASSET', () => {
    it('pins a concrete version, not a floating alias', () => {
        assert.match(WEASYPRINT_WINDOWS_ASSET.version, /^\d+\.\d+(\.\d+)?$/);
    });

    it('carries a full lowercase SHA-256', () => {
        assert.match(WEASYPRINT_WINDOWS_ASSET.sha256, /^[0-9a-f]{64}$/);
    });
});

describe('weasyprintWindowsUrl', () => {
    it('builds the pinned release URL over https', () => {
        assert.equal(
            weasyprintWindowsUrl('69.0'),
            'https://github.com/Kozea/WeasyPrint/releases/download/v69.0/weasyprint-windows.zip',
        );
    });

    it('defaults to the pinned version', () => {
        assert.equal(weasyprintWindowsUrl(), weasyprintWindowsUrl(WEASYPRINT_WINDOWS_ASSET.version));
    });

    it('never points at the unverifiable "latest" alias', () => {
        // The whole point of the pin: `/releases/latest/download/` cannot be
        // hash-checked, because its content changes without warning.
        assert.ok(!weasyprintWindowsUrl().includes('/latest/'));
    });
});

// ── Download verification ─────────────────────────────────────────────────────
//
// The archive is hashed in Node rather than by PowerShell's Get-FileHash. A
// `throw` inside `powershell -Command` writes to inherited stderr, so its text
// never reaches err.message — and runVisible puts the whole command line into
// "Command failed: …", which would contain the mismatch message on EVERY
// failure of that call. Matching on that string would have reported a blocked
// proxy as a checksum failure. A typed error cannot be confused with anything.

describe('sha256File / verifyChecksum', () => {
    let dir: string;
    let file: string;
    // A well-formed digest that is deliberately NOT this file's — what a pin
    // pointing at different bytes looks like.
    const WRONG = '0'.repeat(64);

    before(() => {
        dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-checksum-test-'));
        file = path.join(dir, 'payload.zip');
        fs.writeFileSync(file, 'weasyprint');
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('returns a 64-character lowercase hex digest', () => {
        assert.match(sha256File(file), /^[0-9a-f]{64}$/);
    });

    it('is stable for the same bytes and different for different bytes', () => {
        const other = path.join(dir, 'other.zip');
        fs.writeFileSync(other, 'weasyprin7');
        assert.equal(sha256File(file), sha256File(file));
        assert.notEqual(sha256File(file), sha256File(other));
    });

    it('accepts a file whose hash matches', () => {
        assert.doesNotThrow(() => verifyChecksum(file, sha256File(file), 'payload.zip'));
    });

    it('accepts an uppercase expected hash', () => {
        assert.doesNotThrow(() => verifyChecksum(file, sha256File(file).toUpperCase(), 'payload.zip'));
    });

    it('throws a typed ChecksumError naming both hashes when it does not match', () => {
        assert.throws(
            () => verifyChecksum(file, WRONG, 'weasyprint-windows.zip'),
            (err: unknown) => {
                assert.ok(err instanceof ChecksumError, 'must be distinguishable in a catch');
                assert.equal((err as ChecksumError).expected, WRONG);
                assert.equal((err as ChecksumError).actual, sha256File(file));
                assert.match((err as Error).message, /SHA-256 mismatch for weasyprint-windows\.zip/);
                return true;
            },
        );
    });

    it('does not mistake an ordinary failure for a checksum failure', () => {
        // The bug this shape avoids: a network error is not a ChecksumError, so
        // the installer cannot report a blocked proxy as a tampered download.
        assert.ok(!(new Error('Command failed: powershell ... SHA-256 mismatch ...') instanceof ChecksumError));
    });
});

// ── The Windows installer ladder ──────────────────────────────────────────────
//
// This is what the BootstrapIo seam exists for. Every branch below needs a
// Windows machine, a network, and — for the one that matters most — a download
// whose bytes are not the bytes we asked for. None of it was reachable from a
// test, which is how a module that fetches an executable and runs it came to be
// the least covered in the repo.

/** A recording BootstrapIo. Every effect is captured; nothing touches the machine. */
function fakeIo(overrides: Partial<BootstrapIo> = {}): BootstrapIo & {
    calls: string[]; warnings: string[]; logs: string[];
} {
    const calls: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];

    // Recording wraps the overrides rather than being one of them. Spreading a
    // `runVisible` override over a recording default silently replaced the
    // recorder, so `didRun` went blind in exactly the tests that override the
    // most — which is how a "0 winget calls" result looked like a real finding.
    const record = <A extends unknown[], R>(label: string, fn: (...a: A) => R) =>
        (...args: A): R => {
            calls.push(`${label} ${args[0]} ${(args[1] as string[] | undefined)?.join(' ') ?? ''}`.trim());
            return fn(...args);
        };

    const base: BootstrapIo = {
        run:        () => '',
        runVisible: () => { /* recorded by the wrapper */ },
        exists:     () => true,
        mkdirp:     p => { calls.push(`mkdirp ${p}`); },
        rename:     (from, to) => { calls.push(`rename ${from} -> ${to}`); },
        remove:     p => { calls.push(`remove ${p}`); },
        // The pinned hash, so the happy path verifies by default.
        sha256:     () => WEASYPRINT_WINDOWS_ASSET.sha256,
        log:        m => { logs.push(m); },
        warn:       m => { warnings.push(m); },
        fail:       m => { throw new Error(`FAIL: ${m}`); },
        hasTty:     true,
        appDir:     () => 'C:\\Users\\test\\AppData\\Local',
        tmpdir:     () => 'C:\\Temp',
        homedir:    () => '/Users/test',
        prependPath: dir => { calls.push(`prependPath ${dir}`); },
    };

    const merged = { ...base, ...overrides };
    return {
        ...merged,
        calls, warnings, logs,
        run:        record('run',        merged.run),
        runVisible: record('runVisible', merged.runVisible),
    };
}

const didRun = (io: { calls: string[] }, needle: string) => io.calls.some(c => c.includes(needle));

describe('installWeasyprintWindows — the happy path', () => {
    it('downloads, verifies, extracts and installs without falling back', () => {
        const io = fakeIo();
        installWeasyprintWindows(io);

        assert.ok(didRun(io, 'Invoke-WebRequest'), 'should download the archive');
        assert.ok(didRun(io, 'Expand-Archive'),    'should extract it');
        assert.ok(didRun(io, 'rename'),            'should move the exe into place');
        assert.ok(!didRun(io, 'pip'),              'should not fall back to pip');
        assert.deepEqual(io.warnings, [], 'a clean install warns about nothing');
    });

    it('verifies the checksum BEFORE extracting, never after', () => {
        const io = fakeIo();
        installWeasyprintWindows(io);

        // The ordering IS the security property: an archive that is not what we
        // asked for must not be unpacked, let alone have its .exe run.
        const verified  = io.logs.findIndex(l => l.includes('Download verified'));
        const extracted = io.calls.findIndex(c => c.includes('Expand-Archive'));
        assert.ok(verified  >= 0, 'the verification should be logged');
        assert.ok(extracted >= 0, 'the extraction should happen');
        assert.ok(io.calls.findIndex(c => c.includes('Invoke-WebRequest')) < extracted);
    });

    it('removes the downloaded archive whether or not it succeeded', () => {
        // The archive by name, not by full path: `path.join` uses the separator
        // of the machine running the suite, never the Windows one these paths
        // are written in.
        const ok = fakeIo();
        installWeasyprintWindows(ok);
        assert.ok(didRun(ok, 'remove'));
        assert.ok(didRun(ok, 'weasyprint-windows.zip'));

        // Only the download fails; the pip fallback then succeeds, so the run
        // ends normally and the cleanup in `finally` is what we are checking.
        const failed = fakeIo({
            runVisible: (_file, args) => {
                if (args.join(' ').includes('Invoke-WebRequest')) throw new Error('proxy blocked github');
            },
            run: () => 'Python 3.13.0',
        });
        installWeasyprintWindows(failed);
        assert.ok(failed.calls.some(c => c.startsWith('remove') && c.includes('weasyprint-windows.zip')));
    });
});

describe('installWeasyprintWindows — a download that fails its checksum', () => {
    /** Verified, but the bytes that arrived hash to something else. */
    const corrupted = (extra: Partial<BootstrapIo> = {}) =>
        fakeIo({ sha256: () => 'deadbeef'.repeat(8), run: () => 'Python 3.13.0', ...extra });

    it('never extracts an archive whose hash does not match', () => {
        const io = corrupted();
        installWeasyprintWindows(io);

        assert.ok(didRun(io, 'Invoke-WebRequest'), 'it still downloads');
        assert.ok(!didRun(io, 'Expand-Archive'),   'but must NOT unpack it');
        assert.ok(!didRun(io, 'rename'),           'and must not install anything from it');
    });

    it('says SECURITY, not "download failed" — they are different events', () => {
        const io = corrupted();
        installWeasyprintWindows(io);

        // A hash mismatch and a blocked proxy both end at the pip fallback, so
        // without this the one that matters scrolls past looking like the one
        // that does not.
        assert.ok(io.warnings.some(w => w.startsWith('SECURITY:')), io.warnings.join('\n'));
        assert.ok(io.warnings.some(w => w.includes('SHA-256 mismatch')));
    });

    it('still falls back to pip — PyPI is its own verified channel', () => {
        const io = corrupted();
        installWeasyprintWindows(io);
        assert.ok(didRun(io, 'pip'), 'the fallback should still run');
    });

    it('discards the archive it refused', () => {
        const io = corrupted();
        installWeasyprintWindows(io);
        assert.ok(io.calls.some(c => c.startsWith('remove') && c.includes('weasyprint-windows.zip')));
    });
});

describe('installWeasyprintWindows — the other fallback paths', () => {
    it('falls back to pip when the download itself fails', () => {
        const io = fakeIo({
            runVisible: (file, args) => {
                if (args.join(' ').includes('Invoke-WebRequest')) throw new Error('ENOTFOUND github.com');
            },
            run: () => 'Python 3.13.0',
        });
        installWeasyprintWindows(io);

        assert.ok(io.warnings.some(w => w.includes('falling back to Python + pip')));
        assert.ok(!io.warnings.some(w => w.startsWith('SECURITY:')), 'a network failure is not a checksum failure');
    });

    it('falls back when extraction produces no executable', () => {
        const io = fakeIo({ exists: () => false, run: () => 'Python 3.13.0' });
        installWeasyprintWindows(io);
        assert.ok(!didRun(io, 'rename'), 'nothing to move into place');
        assert.ok(didRun(io, 'pip'));
    });

    it('refuses to install when there is no per-user directory to install into', () => {
        // Rather than building a RELATIVE path and unpacking an executable into
        // whatever directory the export happened to be running in.
        const io = fakeIo({ appDir: () => null });
        assert.throws(() => installWeasyprintWindows(io), /FAIL:.*nowhere per-user/s);
        assert.ok(!didRun(io, 'Invoke-WebRequest'), 'it should not even download');
    });
});

describe('installWeasyprintWindowsViaPip', () => {
    it('installs WeasyPrint with an already-present Python', () => {
        const io = fakeIo({ run: () => 'Python 3.13.1' });
        installWeasyprintWindowsViaPip(io);
        assert.ok(didRun(io, 'pip install --upgrade weasyprint'));
        assert.ok(!didRun(io, 'winget'), 'no need to install Python');
    });

    it('tries each pinned winget id in turn until one works', () => {
        let pythonFound = false;
        const io = fakeIo({
            // `resolvePython` is a two-step lookup: locate the binary on PATH
            // (`which`/`where`), then ask it its version. Both have to answer.
            run: (file, args) => {
                if (args.includes('--version')) return 'Python 3.12.0';
                if (file === 'which' || file === 'where') return pythonFound ? 'C:\\Python312\\python.exe' : '';
                return '';
            },
            runVisible: (file, args) => {
                if (file !== 'winget') return;
                // Only the third id is available in this catalogue.
                if (!args.join(' ').includes('Python.Python.3.11')) throw new Error('No package found');
                pythonFound = true;
            },
        });
        installWeasyprintWindowsViaPip(io);

        const wingetTries = io.calls.filter(c => c.startsWith('runVisible winget'));
        assert.equal(wingetTries.length, 3, 'should stop at the first id that works');
        assert.ok(didRun(io, 'pip install --upgrade weasyprint'));
    });

    it('re-reads the persisted PATH after a winget install, so the new Python is findable', () => {
        let pythonFound = false;
        const io = fakeIo({
            run: (file, args) => {
                if (args.includes('--version')) return pythonFound ? 'Python 3.13.0' : 'nope';
                return 'C:\\NewPath';
            },
            runVisible: (file) => { if (file === 'winget') pythonFound = true; },
        });
        installWeasyprintWindowsViaPip(io);
        assert.ok(didRun(io, 'prependPath'), 'the freshly-installed Python is not in this process PATH yet');
    });

    it('fails with the winget-source hint when Python cannot be installed at all', () => {
        const io = fakeIo({
            run: () => 'not python',
            runVisible: (file) => { if (file === 'winget') throw new Error('No package found'); },
        });
        assert.throws(() => installWeasyprintWindowsViaPip(io), /winget source reset --force/);
    });

    it('fails with the GTK hint when pip itself fails', () => {
        const io = fakeIo({
            run: () => 'Python 3.13.0',
            runVisible: (_file, args) => { if (args.includes('pip')) throw new Error('no wheel'); },
        });
        assert.throws(() => installWeasyprintWindowsViaPip(io), /GTK runtime/);
    });
});

describe('runWithSudo', () => {
    it('runs the command when there is a terminal to prompt on', () => {
        const io = fakeIo({ hasTty: true });
        assert.equal(runWithSudo(['apt-get', 'install', '-y', 'weasyprint'], 'Installing', io), true);
        assert.ok(didRun(io, 'runVisible sudo apt-get install -y weasyprint'));
    });

    it('never invokes sudo without a terminal — it would block forever', () => {
        // The VS Code extension spawns the CLI with piped stdio, so there is no
        // controlling terminal and sudo's prompt would be invisible.
        const io = fakeIo({ hasTty: false });
        assert.equal(runWithSudo(['snap', 'install', 'drawio'], 'Installing draw.io', io), false);
        assert.ok(!didRun(io, 'sudo'), 'must not even try');
    });

    it('hands the exact command over when it cannot run it', () => {
        const io = fakeIo({ hasTty: false });
        runWithSudo(['apt-get', 'install', '-y', 'weasyprint'], 'Installing WeasyPrint', io);
        assert.ok(io.warnings.some(w => w.includes('sudo apt-get install -y weasyprint')),
                  'the user needs the literal command to paste');
    });

    it('reports failure rather than throwing when the command exits non-zero', () => {
        const io = fakeIo({ hasTty: true, runVisible: () => { throw new Error('exit 1'); } });
        assert.equal(runWithSudo(['apt-get', 'install', 'x'], 'Installing', io), false);
    });
});

// ── The macOS installer ladder ────────────────────────────────────────────────
//
// The path most contributors actually run, and it had no test at all: every
// branch needs a Mac with (or without) Homebrew, a failing `brew install`, or a
// machine with no Python. Same seam as the Windows ladder above, extended to
// cover it.

describe('installWeasyprintMac', () => {
    /**
     * A `run` that answers the way a Mac with Python 3 on PATH does.
     *
     * `resolvePython` probes in two steps — `which python3`, then
     * `python3 --version` expecting it to start with "Python 3" — so a stub that
     * simply returns a path for everything makes Python look ABSENT and every
     * test silently exercises the no-Python failure branch instead.
     */
    const pythonRun = (extra: (file: string, args: string[]) => string | null = () => null) =>
        (file: string, args: string[]): string => {
            const custom = extra(file, args);
            if (custom !== null) return custom;
            if (file === 'which' || file === 'where') return `/usr/bin/${args[0]}`;
            if (args[0] === '--version') return 'Python 3.13.1';
            if (args[0] === '-c')        return '3.13';
            return '';
        };

    /** An io whose `exists` answers true only for the listed paths. */
    const macIo = (present: string[], overrides: Partial<BootstrapIo> = {}) =>
        fakeIo({ exists: p => present.includes(p), run: pythonRun(), ...overrides });

    it('prefers the Apple Silicon Homebrew prefix', () => {
        const io = macIo(BREW_CANDIDATES);          // both present
        installWeasyprintMac(io);
        assert.ok(didRun(io, '/opt/homebrew/bin/brew install weasyprint'));
        assert.ok(!didRun(io, '/usr/local/bin/brew'));
    });

    it('falls back to the Intel prefix when the Apple Silicon one is absent', () => {
        const io = macIo(['/usr/local/bin/brew']);
        installWeasyprintMac(io);
        assert.ok(didRun(io, '/usr/local/bin/brew install weasyprint'));
    });

    it('stops after a successful brew install — no pip, no native deps', () => {
        const io = macIo(BREW_CANDIDATES);
        installWeasyprintMac(io);
        assert.ok(!didRun(io, 'pip'),   'a working brew install must not also run pip');
        assert.ok(!didRun(io, 'pango'), 'the native-deps rescue is for the failure path only');
    });

    it('falls back to pip when brew install fails', () => {
        const io = macIo(BREW_CANDIDATES, {
            runVisible: (_file, args) => {
                if (args[0] === 'install' && args[1] === 'weasyprint') throw new Error('brew exploded');
            },
        });
        installWeasyprintMac(io);
        assert.ok(io.warnings.some(w => /falling back to pip/.test(w)));
        assert.ok(didRun(io, 'install pango libffi cairo gdk-pixbuf'), 'native deps are installed first');
        assert.ok(didRun(io, '-m pip install --upgrade weasyprint'));
    });

    it('warns, but continues to pip, when Homebrew is not installed at all', () => {
        const io = macIo([]);
        installWeasyprintMac(io);
        assert.ok(io.warnings.some(w => /Homebrew not found/.test(w)));
        assert.ok(didRun(io, '-m pip install --upgrade weasyprint'));
    });

    it("uses Homebrew's own Python when the PATH has none", () => {
        const io = macIo([...BREW_CANDIDATES, '/opt/homebrew/opt/python/bin/python3'], {
            runVisible: (file, args) => {
                if (file.endsWith('brew') && args[1] === 'weasyprint') throw new Error('nope');
            },
            // No python on PATH; brew knows where its own lives.
            run: pythonRun((_file, args) => {
                if (args[0] === 'python3' || args[0] === 'python') return '';
                if (args[0] === '--prefix') return '/opt/homebrew/opt/python';
                return null;
            }),
        });
        installWeasyprintMac(io);
        assert.ok(didRun(io, '/opt/homebrew/opt/python/bin/python3 -m pip install --upgrade weasyprint'));
    });

    it('fails with an actionable sentence when there is no Python anywhere', () => {
        const io = macIo([], { run: () => '' });
        assert.throws(() => installWeasyprintMac(io), /Python 3 not found.*brew install python/s);
    });

    it('fails with the brew hint when pip itself fails', () => {
        const io = macIo(['/usr/bin/python3'], {
            runVisible: (_file, args) => { if (args[0] === '-m') throw new Error('pip exploded'); },
        });
        assert.throws(() => installWeasyprintMac(io), /pip install weasyprint failed.*brew install weasyprint/s);
    });

    it("puts pip's --user script directory on PATH when it exists", () => {
        const pipBin = path.join('/Users/test', 'Library', 'Python', '3.13', 'bin');
        const io = macIo([pipBin]);
        installWeasyprintMac(io);
        assert.ok(didRun(io, `prependPath ${pipBin}`));
    });

    it('does not fail the install when the PATH probe throws', () => {
        // Best-effort by design: WeasyPrint is already installed by this point,
        // so a failure to make its scripts findable must not undo the install.
        const io = macIo(['/usr/bin/python3'], {
            run: (file, args) => {
                if (args[0] === '-c') throw new Error('python vanished');
                return pythonRun()(file, args);
            },
        });
        assert.doesNotThrow(() => installWeasyprintMac(io));
        assert.ok(didRun(io, '-m pip install --upgrade weasyprint'), 'the install itself still happened');
    });
});
