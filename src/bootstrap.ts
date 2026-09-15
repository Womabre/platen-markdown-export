/**
 * bootstrap.ts
 *
 * WeasyPrint discovery and opt-in installation (`platen-markdown-export --setup`).
 * npm dependencies are managed via package.json — no runtime install needed.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDrawioCli } from './drawio';
import { windowsAppDir } from './fsutil';

// ── Internal helpers ──────────────────────────────────────────────────────────

const ts = (): string => new Date().toISOString().replace('T', ' ').substring(0, 19);
const tag = (label: string, out: (s: string) => void) => (msg: string) => out(`${ts()} - [${label}] ${msg}`);

const log  = tag('setup', console.log);
// `warn` was an alias of `log`, so nothing it said ever reached stderr — every
// "install failed, falling back…" line was indistinguishable from progress.
const warn = tag('setup', console.error);
// The explicit `(msg: string) => never` annotation on the *variable* is what
// makes TypeScript treat a `fail(...)` call as terminating control flow. A bare
// `const fail = (msg: string): never => …` does not narrow at call sites, which
// is how `python` stayed `string | null` after the "Python 3 not found" branch —
// harmless only while the command was a template string that stringified null.
const fail: (msg: string) => never = (msg) => {
    console.error(`${ts()} - [setup] ERROR: ${msg}`);
    process.exit(1);
};

/**
 * Every external command in this file goes through `execFile`, never a shell.
 *
 * This module is the one place that builds commands out of values it did not
 * write: `%LOCALAPPDATA%`, `$HOME`, a Homebrew prefix, the output of `which`.
 * Passing those through a shell means a user whose account is `O'Brien` — or
 * whose path holds a space, `&`, or `^` — gets a broken install or worse. An
 * argv array has no metacharacters at all, which is the same reason
 * `openCommand()` in index.ts stopped shelling out to `cmd /c start`.
 */
function run(file: string, args: string[], opts: object = {}): string {
    return execFileSync(file, args, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
}

function runVisible(file: string, args: string[]): void {
    execFileSync(file, args, { stdio: 'inherit' });
}

// ── Injectable effects ────────────────────────────────────────────────────────

/**
 * The side effects the Windows installer performs, as an injectable seam.
 *
 * This module downloads an executable over the network, hashes it, unpacks it
 * and puts it on disk, with a fallback ladder underneath every step — and none
 * of that ladder could be reached from a test, because reaching it needs a
 * Windows machine, a network, and a deliberately corrupted download. It was the
 * least covered and highest consequence code in the repo: the branch that
 * decides whether an archive failing its checksum still gets unpacked is the one
 * branch you would most like a test to hold.
 *
 * Same device `watch.ts` uses for the same reason. Injected rather than
 * monkey-patched so there is no global mutable state and a test cannot leak into
 * the next one.
 *
 * Deliberately scoped to the Windows path and {@link runWithSudo}: those are
 * where an unverified binary is fetched and executed, and where a missing
 * terminal can hang the process forever. The macOS and Linux installers go
 * through Homebrew, apt and snap, which verify their own packages, and are left
 * calling the real primitives directly.
 */
export interface BootstrapIo {
    /** Capture a command's stdout; throws on a non-zero exit. */
    run(file: string, args: string[]): string;
    /** Run a command with inherited stdio; throws on a non-zero exit. */
    runVisible(file: string, args: string[]): void;
    exists(p: string): boolean;
    mkdirp(p: string): void;
    rename(from: string, to: string): void;
    /** Recursive, force — used for cleanup, must not throw on a missing path. */
    remove(p: string): void;
    /** Lowercase hex SHA-256 of a file. */
    sha256(p: string): string;
    log(msg: string): void;
    warn(msg: string): void;
    fail(msg: string): never;
    /** Whether stdin is a terminal — decides whether `sudo` can prompt. */
    hasTty: boolean;
    /** `%LOCALAPPDATA%` / `%APPDATA%`, or null; see `windowsAppDir`. */
    appDir(kind: 'Local' | 'Roaming'): string | null;
    tmpdir(): string;
    /** The user's home directory — where pip drops its `--user` scripts on macOS. */
    homedir(): string;
    /** Prepended to PATH after an install puts a new binary somewhere. */
    prependPath(dir: string): void;
}

/** The real effects. Every production call path uses this. */
export const REAL_IO: BootstrapIo = {
    run:        (file, args) => run(file, args),
    runVisible: (file, args) => runVisible(file, args),
    exists:     p => fs.existsSync(p),
    mkdirp:     p => { fs.mkdirSync(p, { recursive: true }); },
    rename:     (from, to) => fs.renameSync(from, to),
    remove:     p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } },
    sha256:     sha256File,
    log,
    warn,
    fail,
    get hasTty() { return Boolean(process.stdin.isTTY); },
    appDir:     kind => windowsAppDir(kind),
    tmpdir:     () => os.tmpdir(),
    homedir:    () => os.homedir(),
    // `path.delimiter`, not a literal ';'. This was Windows-only when it was
    // written and hardcoded that separator; the macOS installer now uses the
    // same seam, where ';' would have produced one unusable PATH entry instead
    // of two usable ones. Identical to the old behaviour on Windows.
    prependPath: dir => { process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`; },
};

/**
 * Quotes a value as a PowerShell single-quoted string literal.
 *
 * `execFile` removes the *shell's* parsing, but `powershell -Command <script>`
 * hands the script to PowerShell's own parser, so a path interpolated into a
 * literal still has to be escaped for it. Inside single quotes PowerShell
 * treats every character literally except `'` itself, which is escaped by
 * doubling — the identical rule `openCommand()` applies to `-LiteralPath`.
 *
 * Exported for testing: the paths that trigger it (`C:\Users\O'Brien\…`) exist
 * only on a Windows machine, which is never the one running the suite.
 */
export function psSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Reads a persisted Windows PATH scope from the registry, via PowerShell.
 *
 * A freshly-installed tool lands in the persisted PATH but not in this already-
 * running process's copy, so `winget install` followed by a lookup would miss it
 * without re-reading these.
 */
function readWindowsPath(scope: 'Machine' | 'User', io: BootstrapIo = REAL_IO): string {
    return io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `[System.Environment]::GetEnvironmentVariable('PATH','${scope}')`,
    ]);
}

/**
 * Runs a command as root, or explains it when there is no way to ask for a password.
 *
 * `sudo` prompts on the controlling terminal. `--setup` run from a shell has
 * one; run from the VS Code extension — which spawns the CLI with piped stdio —
 * it does not, and the process either fails immediately or blocks forever on a
 * prompt nobody can see. Printing the exact command is the honest outcome there.
 *
 * @returns whether the command actually ran to completion.
 */
export function runWithSudo(args: string[], what: string, io: BootstrapIo = REAL_IO): boolean {
    if (!io.hasTty) {
        io.warn(
            `${what} needs administrator rights, and this run has no terminal to ask for a password.\n` +
            '  Run it yourself, then re-run --setup:\n' +
            `    sudo ${args.join(' ')}`
        );
        return false;
    }
    try {
        io.runVisible('sudo', args);
        return true;
    } catch {
        return false;
    }
}

/** Locates an executable on PATH, or returns null. `where` on Windows, `which` elsewhere. */
function whichBinary(name: string, io: BootstrapIo = REAL_IO): string | null {
    try {
        const found = io.run(process.platform === 'win32' ? 'where' : 'which', [name])
            .split('\n')[0]
            .trim();
        return found || null;
    } catch {
        return null;   // not on PATH
    }
}

// ── WeasyPrint path resolution ────────────────────────────────────────────────

export function findWeasyprint(): string | null {
    const platform = process.platform;
    // A per-user candidate is dropped when there is no directory to build it
    // from, rather than degrading to a relative path resolved against the
    // user's document folder — see `windowsAppDir`.
    const local   = windowsAppDir('Local');
    const roaming = windowsAppDir('Roaming');
    const candidates: string[] = platform === 'win32'
        ? [
            'C:\\Program Files\\WeasyPrint\\weasyprint.exe',
            local   && path.join(local,   'Programs', 'WeasyPrint', 'weasyprint.exe'),
            roaming && path.join(roaming, 'Python', 'Scripts', 'weasyprint.exe'),
            roaming && path.join(roaming, 'Scripts', 'weasyprint.exe'),
        ].filter((c): c is string => Boolean(c))
        : [
            '/opt/homebrew/bin/weasyprint',
            '/usr/local/bin/weasyprint',
            '/usr/bin/weasyprint',
            '/usr/local/sbin/weasyprint',
        ];

    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }

    const onPath = whichBinary('weasyprint');
    if (onPath && fs.existsSync(onPath)) return onPath;

    return null;
}

// ── Python resolution ─────────────────────────────────────────────────────────

function resolvePython(io: BootstrapIo = REAL_IO): string | null {
    for (const candidate of ['python3', 'python']) {
        const found = whichBinary(candidate, io);
        if (!found) continue;
        try {
            if (io.run(found, ['--version']).startsWith('Python 3')) return found;
        } catch { /* present but not runnable */ }
    }
    return null;
}

// ── WeasyPrint installation ───────────────────────────────────────────────────

// Tried newest-first: an unversioned "Python.Python.3" isn't resolvable on every
// winget catalog/source configuration, so fall through a few real released versions.
const PYTHON_WINGET_IDS = ['Python.Python.3.13', 'Python.Python.3.12', 'Python.Python.3.11', 'Python.Python.3'];

/**
 * The Windows standalone build, pinned to a version and a hash.
 *
 * WeasyPrint's own docs recommend this executable as the easiest way to run
 * WeasyPrint on Windows: a PyInstaller build that statically bundles
 * Pango/Cairo/GDK-Pixbuf/GObject, so unlike `pip install weasyprint` it needs
 * neither a separate Python install nor the GTK runtime.
 *
 * This used to fetch GitHub's `/releases/latest/download/` alias, on the
 * reasoning that it never needs bumping by hand. Two problems with that. It is
 * an unverifiable download of an executable — whatever bytes arrive get
 * extracted and run, with nothing to compare them against. And "latest" means
 * Windows users silently get a different WeasyPrint version from the one this
 * project tests against, changing rendering under them on WeasyPrint's release
 * schedule rather than ours.
 *
 * To bump: pick the release, then take the digest GitHub publishes for the
 * asset (`.assets[] | select(.name=="weasyprint-windows.zip") | .digest` from
 * `https://api.github.com/repos/Kozea/WeasyPrint/releases/latest`) — or hash
 * the download yourself with `shasum -a 256`. `src/tests/bootstrap.test.ts`
 * asserts the shape, not the value; the value is checked at install time.
 */
export const WEASYPRINT_WINDOWS_ASSET = {
    version: '69.0',
    sha256:  '330101ff3ea50ebde4abf805283b6d703d5f3d71c77c983db94357ec4524a3ef',
} as const;

/** Download URL for a pinned WeasyPrint Windows release. */
export function weasyprintWindowsUrl(version: string = WEASYPRINT_WINDOWS_ASSET.version): string {
    return `https://github.com/Kozea/WeasyPrint/releases/download/v${version}/weasyprint-windows.zip`;
}

/** Lowercase hex SHA-256 of a file on disk. */
export function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Raised when a download's hash does not match the pin. Distinguishable in a catch. */
export class ChecksumError extends Error {
    constructor(public readonly expected: string, public readonly actual: string, what: string) {
        super(`SHA-256 mismatch for ${what}: expected ${expected}, got ${actual}`);
        this.name = 'ChecksumError';
    }
}

/**
 * Throws unless `filePath` hashes to `expected`.
 *
 * Hashing happens here rather than in PowerShell's `Get-FileHash` for two
 * reasons. A `throw` inside `powershell -Command` writes to the inherited
 * stderr, so its text never reaches `err.message` — and because `runVisible`
 * puts the whole command line into "Command failed: …", the mismatch message
 * would appear there on *every* failure of that call, including a network one.
 * Detecting the mismatch by matching that string would have reported a blocked
 * proxy as a checksum failure. A typed error thrown from Node cannot be confused
 * with anything else, and this is unit-testable off Windows.
 */
export function verifyChecksum(
    filePath: string,
    expected: string,
    what: string,
    sha256: (p: string) => string = sha256File,
): void {
    const actual = sha256(filePath);
    if (actual !== expected.toLowerCase()) throw new ChecksumError(expected, actual, what);
}

export function installWeasyprintWindows(io: BootstrapIo = REAL_IO): void {
    const { version, sha256 } = WEASYPRINT_WINDOWS_ASSET;
    io.log(`Downloading the standalone WeasyPrint ${version} executable for Windows (bundles all native dependencies — no Python or GTK runtime needed)...`);

    // Never a relative path: this directory is CREATED and an executable
    // unpacked into it, so an empty %LOCALAPPDATA% used to scatter the install
    // through whatever directory the export happened to be running in.
    const local = io.appDir('Local');
    if (!local)
        io.fail('Cannot install WeasyPrint: neither %LOCALAPPDATA% nor a home directory is set,\n' +
                '  so there is nowhere per-user to install it. Set %LOCALAPPDATA% and re-run --setup.');

    const installDir = path.join(local, 'Programs', 'WeasyPrint');
    const finalExe   = path.join(installDir, 'weasyprint.exe');
    const zipPath    = path.join(io.tmpdir(), 'weasyprint-windows.zip');

    try {
        io.mkdirp(installDir);
        // `zipPath` and `installDir` are built from %TMP% / %LOCALAPPDATA%, so they
        // carry the user's account name — psSingleQuote is what keeps an apostrophe
        // in it (`C:\Users\O'Brien\…`) from ending the PowerShell string literal.
        io.runVisible('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            '$ProgressPreference = \'SilentlyContinue\'; ' +
            '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ' +
            `Invoke-WebRequest -Uri ${psSingleQuote(weasyprintWindowsUrl())} -OutFile ${psSingleQuote(zipPath)}`,
        ]);

        // Before Expand-Archive, never after: an archive that is not what we
        // asked for must not be unpacked, let alone have its .exe run.
        verifyChecksum(zipPath, sha256, 'weasyprint-windows.zip', io.sha256);
        io.log(`Download verified (SHA-256 ${sha256.slice(0, 12)}…)`);
        io.runVisible('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -Path ${psSingleQuote(zipPath)} -DestinationPath ${psSingleQuote(installDir)} -Force`,
        ]);

        const extractedExe = path.join(installDir, 'dist', 'weasyprint.exe');
        if (!io.exists(extractedExe)) {
            throw new Error(`expected ${extractedExe} after extraction`);
        }
        io.rename(extractedExe, finalExe);
        io.remove(path.join(installDir, 'dist'));
    } catch (err: unknown) {
        // A hash mismatch is not the same event as a proxy blocking GitHub, and
        // must not scroll past looking like one — falling back to pip is still
        // the right move (PyPI is its own verified channel), but the user should
        // be told the bytes that arrived were not the bytes we asked for.
        if (err instanceof ChecksumError) {
            io.warn('SECURITY: the WeasyPrint download did not match its expected SHA-256 and was discarded.');
            io.warn(err.message);
            io.warn('Falling back to Python + pip...');
        } else {
            io.warn('Downloading the standalone WeasyPrint executable failed — falling back to Python + pip...');
        }
        installWeasyprintWindowsViaPip(io);
        return;
    } finally {
        io.remove(zipPath);
    }

    if (!io.exists(finalExe)) {
        io.warn('WeasyPrint download finished but the executable is missing — falling back to Python + pip...');
        installWeasyprintWindowsViaPip(io);
    }
}

/** Fallback if the standalone executable can't be downloaded (e.g. GitHub blocked by a proxy). */
export function installWeasyprintWindowsViaPip(io: BootstrapIo = REAL_IO): void {
    let python = resolvePython(io);
    if (!python) {
        io.log('Python not found — attempting to install via winget...');
        let installed = false;
        for (const id of PYTHON_WINGET_IDS) {
            try {
                io.runVisible('winget', ['install', '--id', id, '--accept-source-agreements', '--accept-package-agreements']);
                installed = true;
                break;
            } catch { /* try the next known id */ }
        }

        if (installed) {
            try {
                const machine = readWindowsPath('Machine', io);
                const user    = readWindowsPath('User', io);
                io.prependPath(`${machine};${user}`);
            } catch { /* best-effort */ }
            python = resolvePython(io);
        }

        if (!python) {
            io.fail(
                'Python is required to install WeasyPrint but could not be installed automatically via winget.\n' +
                '  If winget reported "No package found", your winget install may only have the "msstore"\n' +
                '  source registered — try: winget source reset --force\n' +
                '  Or install Python 3 manually from https://www.python.org/downloads/\n' +
                '  (tick "Add Python to PATH"), then re-run this script.'
            );
        }
    }

    io.log(`Using Python: ${python}`);
    io.log('Installing WeasyPrint via pip...');
    try {
        io.runVisible(python, ['-m', 'pip', 'install', '--upgrade', 'weasyprint']);
    } catch {
        io.fail(
            'pip install weasyprint failed.\n' +
            '  WeasyPrint on Windows also requires the GTK runtime.\n' +
            '  Download it from: https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases\n' +
            '  Alternatively, use WSL2: wsl --install && sudo apt install weasyprint'
        );
    }

    try {
        const scripts = io.run(python, ['-c', "import sysconfig; print(sysconfig.get_path('scripts'))"]);
        if (scripts) io.prependPath(scripts);
    } catch { /* best-effort */ }
}

/** Where Homebrew puts its `brew`, Apple Silicon first. */
export const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/**
 * The macOS installer's fallback ladder: Homebrew, then pip, then a reason.
 *
 * Takes the {@link BootstrapIo} seam for the same reason the Windows one does.
 * This ladder had no test at all — every branch needs a Mac with (or without)
 * Homebrew, a failing `brew install`, or a machine with no Python — and it is
 * the path most contributors to this project will actually run. The two
 * outcomes worth pinning are that a successful `brew install` does NOT go on to
 * run pip, and that a machine with neither Homebrew nor Python fails with the
 * sentence that tells you what to install rather than a stack trace.
 */
export function installWeasyprintMac(io: BootstrapIo = REAL_IO): void {
    const brewPath = BREW_CANDIDATES.find(p => io.exists(p)) ?? null;

    if (brewPath) {
        io.log('Installing WeasyPrint via Homebrew (recommended)...');
        try {
            io.runVisible(brewPath, ['install', 'weasyprint']);
            return;
        } catch {
            io.warn('brew install weasyprint failed, falling back to pip...');
        }
        io.log('Installing native dependencies (pango, cairo) via Homebrew...');
        try { io.runVisible(brewPath, ['install', 'pango', 'libffi', 'cairo', 'gdk-pixbuf']); } catch { /* continue */ }
    } else {
        io.warn('Homebrew not found. For best results install it first: https://brew.sh');
    }

    io.log('Installing WeasyPrint via pip...');
    let python = resolvePython(io);
    if (!python) {
        // Was `brew --prefix python 2>/dev/null || true` — shell constructs that
        // have no argv equivalent. Without a shell the failure is simply caught here.
        let brewPython = '';
        if (brewPath) {
            try { brewPython = io.run(brewPath, ['--prefix', 'python']); } catch { /* no brewed python */ }
        }
        if (brewPython && io.exists(`${brewPython}/bin/python3`)) {
            python = `${brewPython}/bin/python3`;
        } else {
            io.fail('Python 3 not found. Install it with: brew install python');
        }
    }

    try {
        io.runVisible(python, ['-m', 'pip', 'install', '--upgrade', 'weasyprint']);
    } catch {
        io.fail('pip install weasyprint failed. Try: brew install weasyprint');
    }

    try {
        const ver = io.run(python, ['-c', "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
        const pipBin = path.join(io.homedir(), 'Library', 'Python', ver, 'bin');
        if (io.exists(pipBin)) io.prependPath(pipBin);
    } catch { /* best-effort */ }
}

function ensureWeasyprint(): void {
    if (findWeasyprint()) return;

    warn('WeasyPrint not found — attempting automatic installation...');

    if (process.platform === 'win32') {
        installWeasyprintWindows();
    } else if (process.platform === 'darwin') {
        installWeasyprintMac();
    } else {
        log('Installing WeasyPrint on Linux...');
        try {
            // Needs no root, so it is tried first and usually ends here.
            runVisible('pip3', ['install', '--upgrade', 'weasyprint']);
        } catch {
            if (!runWithSudo(['apt-get', 'install', '-y', 'weasyprint'], 'Installing WeasyPrint via apt'))
                fail('Could not install WeasyPrint. Try: sudo apt install weasyprint  or  pip3 install weasyprint');
        }
    }

    if (findWeasyprint()) {
        log('WeasyPrint installed successfully');
    } else {
        warn(
            'WeasyPrint was installed but could not be located on PATH.\n' +
            '  The export will attempt to run anyway; if it fails, restart your terminal and try again.'
        );
    }
}

// ── Playwright Chromium (Mermaid rendering) ──────────────────────────────────

function ensurePlaywrightChromium(): void {
    log('Ensuring Playwright Chromium is installed (used for Mermaid rendering)...');
    try {
        // Invoke the local playwright CLI directly rather than `npx playwright`: npx
        // resolves relative to the CALLER's cwd, which when this runs via the VS Code
        // extension is the open workspace folder, not this package's directory. Unable to
        // see a local install from there, npx fetches a throwaway copy from the registry,
        // and that copy refuses to download browsers ("you haven't installed your project's
        // dependencies") since it has no lockfile context of its own.
        // `cli.js` isn't in playwright's package.json "exports" map, so it can't be
        // require.resolve()'d directly — resolve the package root (which IS exported) instead.
        const pkgRoot = path.dirname(require.resolve('playwright/package.json'));
        const cliPath = path.join(pkgRoot, 'cli.js');
        if (!fs.existsSync(cliPath)) throw new Error(`playwright cli.js not found at ${cliPath}`);
        runVisible(process.execPath, [cliPath, 'install', 'chromium']);
    } catch {
        warn(
            'Could not install Playwright Chromium automatically — Mermaid diagrams will fail to render.\n' +
            '  Install it manually with: npx playwright install chromium'
        );
    }
}

// ── draw.io desktop app (diagram rendering) ──────────────────────────────────

function ensureDrawio(): void {
    if (findDrawioCli()) return;

    warn('draw.io desktop app not found — attempting automatic installation (only needed if your documents embed .drawio diagrams)...');

    const manualHint =
        'Install it manually from: https://github.com/jgraph/drawio-desktop/releases\n' +
        '  (only needed if your documents embed .drawio diagrams — safe to skip otherwise)';

    try {
        if (process.platform === 'win32') {
            runVisible('winget', ['install', '--id', 'JGraph.Draw', '--accept-source-agreements', '--accept-package-agreements']);
        } else if (process.platform === 'darwin') {
            const brewPath = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p)) ?? null;
            if (!brewPath) {
                warn(`Homebrew not found. ${manualHint}`);
                return;
            }
            runVisible(brewPath, ['install', '--cask', 'drawio']);
        } else if (!runWithSudo(['snap', 'install', 'drawio'], 'Installing draw.io via snap')) {
            warn(manualHint);
            return;
        }
    } catch {
        warn(`Automatic draw.io install failed. ${manualHint}`);
        return;
    }

    if (findDrawioCli(true)) {
        log('draw.io installed successfully');
    } else {
        warn(
            'draw.io was installed but could not be located on PATH.\n' +
            '  Restart your terminal (or VS Code) and try again.'
        );
    }
}

/**
 * `findWeasyprint` only checks the binary exists on disk — it can't tell whether WeasyPrint
 * can actually run. On Windows in particular, `pip install weasyprint` succeeds even when the
 * GTK runtime (Pango/Cairo/GDK-Pixbuf/GObject DLLs) is missing; the failure only surfaces as an
 * OSError the moment WeasyPrint is invoked, since the native libs are dlopen'd at import time —
 * so even `--version` reproduces it. Smoke-testing here catches that during `--setup` instead of
 * mid-export, minutes later, with a much less legible stack trace.
 */
function verifyWeasyprintRuns(weasyprintPath: string): true | string {
    try {
        execFileSync(weasyprintPath, ['--version'], { stdio: 'pipe', encoding: 'utf8', timeout: 15_000 });
        return true;
    } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
        return stderr.trim().split('\n').pop() ?? 'unknown error';
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** Explicit installer, invoked via `platen-markdown-export --setup`. Never runs implicitly. */
export function runBootstrap(): void {
    let existing = findWeasyprint();
    if (existing) {
        log(`WeasyPrint already installed: ${existing}`);
    } else {
        log('WeasyPrint not detected — running setup...');
        ensureWeasyprint();
        existing = findWeasyprint();
    }

    if (existing) {
        const runError = verifyWeasyprintRuns(existing);
        if (runError !== true) {
            warn(
                `WeasyPrint is installed but failed to run: ${runError}\n` +
                (process.platform === 'win32'
                    ? '  This is almost always the missing GTK runtime (Pango/Cairo/GDK-Pixbuf/GObject DLLs) —\n' +
                      '  pip installs the Python wrapper, but the native libraries are a separate download.\n' +
                      '  Install the GTK3 runtime, then restart your terminal (or VS Code) and try again:\n' +
                      '  https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases'
                    : '  Reinstall WeasyPrint\'s native dependencies (pango, cairo, gdk-pixbuf) and try again.')
            );
        }
    }

    ensurePlaywrightChromium();
    ensureDrawio();
    log('Setup complete');
}
