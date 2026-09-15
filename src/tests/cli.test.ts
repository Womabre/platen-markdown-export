import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { parseArgs, parseModes, resolveThemeRoots } from '../cli';
import { setThemeRoots, themeRoots } from '../theme';
import { ExitError } from '../errors';

// Swap process.argv for the duration of each test and restore it afterwards.
let savedArgv: string[];

beforeEach(() => { savedArgv = process.argv; });
afterEach(()  => { process.argv = savedArgv; });

function args(...a: string[]): void {
    process.argv = ['node', 'platen-markdown-export', ...a];
}

describe('parseArgs', () => {
    it('returns the positional argument as inputFile', () => {
        args('doc.md');
        const r = parseArgs();
        assert.equal(r.inputFile, 'doc.md');
    });

    it('-i / --input flag sets inputFile', () => {
        args('--input', 'file.html');
        assert.equal(parseArgs().inputFile, 'file.html');
    });

    it('--input=value= form sets inputFile', () => {
        args('--input=file.md');
        assert.equal(parseArgs().inputFile, 'file.md');
    });

    it('-s sets stylesheetPath', () => {
        args('-s', 'style.css', 'doc.md');
        assert.equal(parseArgs().stylesheetPath, 'style.css');
    });

    it('--stylesheet=value form sets stylesheetPath', () => {
        args('--stylesheet=custom.css', 'doc.md');
        assert.equal(parseArgs().stylesheetPath, 'custom.css');
    });

    it('two positionals: first is stylesheet, second is input', () => {
        args('theme.css', 'doc.md');
        const r = parseArgs();
        assert.equal(r.inputFile, 'doc.md');
        assert.equal(r.stylesheetPath, 'theme.css');
    });

    it('-o sets output path', () => {
        args('-o', 'out.pdf', 'doc.md');
        assert.equal(parseArgs().output, 'out.pdf');
    });

    it('--output=value form sets output path', () => {
        args('--output=result.pdf', 'doc.md');
        assert.equal(parseArgs().output, 'result.pdf');
    });

    it('--mode sets mode and lowercases it', () => {
        args('--mode', 'PDF', 'doc.md');
        assert.equal(parseArgs().mode, 'pdf');
    });

    it('--mode=debug form sets mode', () => {
        args('--mode=debug', 'doc.md');
        assert.equal(parseArgs().mode, 'debug');
    });

    it('--dpi sets dpi as a number', () => {
        args('--dpi', '150', 'doc.md');
        assert.equal(parseArgs().dpi, 150);
    });

    it('--dpi=value form sets dpi', () => {
        args('--dpi=72', 'doc.md');
        assert.equal(parseArgs().dpi, 72);
    });

    it('-q / --quiet sets quiet to true', () => {
        args('-q', 'doc.md');
        assert.equal(parseArgs().quiet, true);
        args('--quiet', 'doc.md');
        assert.equal(parseArgs().quiet, true);
    });

    it('--open sets open to true', () => {
        args('--open', 'doc.md');
        assert.equal(parseArgs().open, true);
    });

    it('--no-bump sets noBump to true', () => {
        args('--no-bump', 'doc.md');
        assert.equal(parseArgs().noBump, true);
    });

    // Two different questions: --no-bump means "touch nothing", while
    // --no-revision-bump means "stamp the date but do not cut a release" —
    // which is what an export triggered by a file save has to do.
    it('--no-revision-bump sets noRevisionBump without setting noBump', () => {
        args('--no-revision-bump', 'doc.md');
        const r = parseArgs();
        assert.equal(r.noRevisionBump, true);
        assert.equal(r.noBump, false, 'the date stamp must still happen');
    });

    it('the two bump flags are independent and combine', () => {
        args('--no-bump', '--no-revision-bump', 'doc.md');
        const r = parseArgs();
        assert.equal(r.noBump, true);
        assert.equal(r.noRevisionBump, true);
    });

    it('neither bump flag is set by default', () => {
        args('doc.md');
        const r = parseArgs();
        assert.equal(r.noBump, false);
        assert.equal(r.noRevisionBump, false);
    });

    it('defaults: no stylesheet, no output, no mode, no dpi, not quiet, not open, bump enabled', () => {
        args('doc.md');
        const r = parseArgs();
        assert.equal(r.stylesheetPath, null);
        assert.equal(r.output, null);
        assert.equal(r.mode, null);
        assert.equal(r.dpi, null);
        assert.equal(r.quiet, false);
        assert.equal(r.open, false);
        assert.equal(r.noBump, false);
    });

    it('-i takes precedence over positional for input file', () => {
        args('-i', 'explicit.md', 'positional.md');
        assert.equal(parseArgs().inputFile, 'explicit.md');
    });
});

// ── Exit paths ────────────────────────────────────────────────────────────────
// parseArgs throws ExitError rather than calling process.exit, so every one of
// these is reachable from a test. Before that they could only be exercised by
// spawning the CLI.

/** Runs parseArgs on an explicit argv and returns the ExitError it threw. */
function exitOf(...argv: string[]): ExitError {
    try {
        parseArgs(argv);
    } catch (err) {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${String(err)}`);
        return err;
    }
    throw new Error(`parseArgs(${JSON.stringify(argv)}) did not exit`);
}

describe('parseArgs usage errors', () => {
    it('exits 2 with no input file', () => {
        const e = exitOf();
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /no input file specified/);
    });

    it('exits 2 on an unknown option, and includes the help text', () => {
        const e = exitOf('--bogus', 'doc.md');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /unknown option "--bogus"/);
        assert.match(e.message, /Usage: platen-markdown-export/);
    });

    it('exits 2 when a value flag is last with no value', () => {
        const e = exitOf('doc.md', '--theme');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /option "--theme" requires a value/);
    });

    it('exits 2 on an invalid --mode and names the bad value', () => {
        const e = exitOf('--mode', 'docx', 'doc.md');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /got "docx"/);
    });

    it('exits 2 on a non-numeric --dpi', () => {
        assert.equal(exitOf('--dpi', 'lots', 'doc.md').exitCode, 2);
    });

    it('exits 2 on a zero or negative --dpi', () => {
        assert.equal(exitOf('--dpi', '0', 'doc.md').exitCode, 2);
        assert.equal(exitOf('--dpi', '-5', 'doc.md').exitCode, 2);
    });

    it('never calls process.exit', () => {
        // A regression guard: if parseArgs went back to exiting, the test
        // runner itself would die here rather than this assertion failing.
        const saved = process.exitCode;
        assert.throws(() => parseArgs(['--bogus']), ExitError);
        assert.equal(process.exitCode, saved);
    });
});

describe('parseArgs informational flags', () => {
    it('--help exits 0 with the usage text', () => {
        const e = exitOf('--help');
        assert.equal(e.exitCode, 0);
        assert.match(e.message, /Usage: platen-markdown-export/);
    });

    it('-h behaves like --help', () => {
        assert.equal(exitOf('-h').exitCode, 0);
    });

    it('--version exits 0 with a version string', () => {
        const e = exitOf('--version');
        assert.equal(e.exitCode, 0);
        assert.match(e.message, /^\d+\.\d+\.\d+/);
    });

    it('--list-themes exits 0 and lists the built-in themes', () => {
        const e = exitOf('--list-themes');
        assert.equal(e.exitCode, 0);
        assert.match(e.message, /Available themes:/);
        assert.match(e.message, /default/);
    });

    it('--list-styles exits 0 and lists the theme styles', () => {
        const e = exitOf('--list-styles');
        assert.equal(e.exitCode, 0);
        assert.match(e.message, /Available styles in theme "Default"/);
    });

    it('--list-styles honours --theme regardless of flag order', () => {
        // The bug this pre-pass fixes: handling these inside the argument loop
        // made the result depend on whether --theme came first.
        const before = exitOf('--theme', 'modern', '--list-styles').message;
        const after  = exitOf('--list-styles', '--theme', 'modern').message;
        assert.equal(before, after);
        assert.match(before, /Available styles in theme "Modern"/);
        assert.match(before, /Cherry/);
    });

    it('--list-styles honours the --theme=value form too', () => {
        assert.match(exitOf('--list-styles', '--theme=modern').message, /"Modern"/);
    });

    it('informational flags win over an otherwise invalid command line', () => {
        // `--help` with no input file must print help, not "no input file".
        assert.equal(exitOf('--help').exitCode, 0);
    });
});

describe('parseArgs --setup', () => {
    it('sets setup and needs no input file', () => {
        const r = parseArgs(['--setup']);
        assert.equal(r.setup, true);
        assert.equal(r.inputFile, '');
    });

    it('is false for a normal export', () => {
        assert.equal(parseArgs(['doc.md']).setup, false);
    });
});

describe('parseArgs argv injection', () => {
    it('accepts an explicit argv instead of process.argv', () => {
        assert.equal(parseArgs(['explicit.md']).inputFile, 'explicit.md');
    });

    it('falls back to process.argv when none is given', () => {
        process.argv = ['node', 'platen-markdown-export', 'from-process.md'];
        assert.equal(parseArgs().inputFile, 'from-process.md');
    });
});

describe('parseModes', () => {
    it('splits a comma-separated list', () => {
        assert.deepEqual(parseModes('pdf,html'), { modes: ['pdf', 'html'], unknown: [] });
    });

    it('tolerates whitespace around the separators', () => {
        assert.deepEqual(parseModes('pdf , html').modes, ['pdf', 'html']);
    });

    it('separates unknown values from valid ones instead of dropping them silently', () => {
        assert.deepEqual(parseModes('pdf,docx,html'), { modes: ['pdf', 'html'], unknown: ['docx'] });
    });

    it('returns empty arrays for null and for an empty string', () => {
        assert.deepEqual(parseModes(null),  { modes: [], unknown: [] });
        assert.deepEqual(parseModes(''),    { modes: [], unknown: [] });
        assert.deepEqual(parseModes(',,,'), { modes: [], unknown: [] });
    });

    it('accepts debug as a mode', () => {
        assert.deepEqual(parseModes('debug').modes, ['debug']);
    });
});

// ── Argument-value handling ───────────────────────────────────────────────────

describe('a flag value is never mistaken for a flag', () => {
    it('does not print help when "-h" is the value of --output', () => {
        // `argv.includes('-h')` cannot tell an option from an option's value, so
        // naming an output file `-h` printed the usage text and exited 0.
        args('--output', '-h', 'doc.md');
        assert.equal(parseArgs().output, '-h');
    });

    it('does not print the version when "-v" is the value of --theme', () => {
        args('--theme', '-v', 'doc.md');
        assert.equal(parseArgs().theme, '-v');
    });

    it('still honours a real --help anywhere in the line', () => {
        assert.equal(exitOf('--theme', 'modern', '--help').exitCode, 0);
    });
});

describe('--dpi is validated as a whole value', () => {
    it('rejects trailing garbage instead of salvaging a prefix', () => {
        // parseInt('300abc') is 300, so this used to be accepted silently.
        const e = exitOf('--dpi', '300abc', 'doc.md');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /300abc/);
    });

    it('rejects exponent and decimal forms', () => {
        assert.equal(exitOf('--dpi', '1e3', 'doc.md').exitCode, 2);
        assert.equal(exitOf('--dpi', '150.5', 'doc.md').exitCode, 2);
    });

    it('rejects the same values in the --dpi=value form', () => {
        assert.equal(exitOf('--dpi=300abc', 'doc.md').exitCode, 2);
    });

    it('still accepts a plain positive integer, with surrounding space', () => {
        args('--dpi', ' 150 ', 'doc.md');
        assert.equal(parseArgs().dpi, 150);
    });
});

describe('--pdf-variant', () => {
    it('is null when not given', () => {
        args('doc.md');
        assert.equal(parseArgs().pdfVariant, null);
    });

    it('accepts a PDF/A conformance level', () => {
        args('--pdf-variant', 'pdf/a-2b', 'doc.md');
        assert.equal(parseArgs().pdfVariant, 'pdf/a-2b');
    });

    it('accepts PDF/UA and PDF/X levels too', () => {
        args('--pdf-variant', 'pdf/ua-1', 'doc.md');
        assert.equal(parseArgs().pdfVariant, 'pdf/ua-1');
        args('--pdf-variant', 'pdf/x-4', 'doc.md');
        assert.equal(parseArgs().pdfVariant, 'pdf/x-4');
    });

    it('lower-cases the value, so PDF/A-2B matches WeasyPrint\'s own lowercase enum', () => {
        args('--pdf-variant', 'PDF/A-2B', 'doc.md');
        assert.equal(parseArgs().pdfVariant, 'pdf/a-2b');
    });

    it('accepts the --pdf-variant=value form', () => {
        args('--pdf-variant=pdf/a-3b', 'doc.md');
        assert.equal(parseArgs().pdfVariant, 'pdf/a-3b');
    });

    it('rejects a value WeasyPrint does not recognise, naming the valid ones', () => {
        const e = exitOf('--pdf-variant', 'pdf/a-99z', 'doc.md');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /pdf\/a-99z/);
        assert.match(e.message, /pdf\/a-2b/); // the error lists the valid set
    });

    it('rejects an empty value', () => {
        assert.equal(exitOf('--pdf-variant', '', 'doc.md').exitCode, 2);
    });
});

describe('--infographic-icons', () => {
    it('is null when not given, so the configured default applies', () => {
        args('doc.md');
        assert.equal(parseArgs().infographicIcons, null);
    });

    for (const provider of ['iconify', 'weavefox', 'none']) {
        it(`accepts ${provider}`, () => {
            args('--infographic-icons', provider, 'doc.md');
            assert.equal(parseArgs().infographicIcons, provider);
        });
    }

    it('lower-cases the value', () => {
        args('--infographic-icons', 'WeaveFox', 'doc.md');
        assert.equal(parseArgs().infographicIcons, 'weavefox');
    });

    it('accepts the --infographic-icons=value form', () => {
        args('--infographic-icons=none', 'doc.md');
        assert.equal(parseArgs().infographicIcons, 'none');
    });

    it('rejects an unknown provider, naming the valid ones', () => {
        const e = exitOf('--infographic-icons', 'google', 'doc.md');
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /"google"/);
        assert.match(e.message, /iconify, weavefox, none/);
    });

    it('rejects an empty value', () => {
        assert.equal(exitOf('--infographic-icons', '', 'doc.md').exitCode, 2);
    });

    it('is documented in --help, with the warning about where WeaveFox data goes', () => {
        const help = exitOf('--help').message;
        assert.match(help, /--infographic-icons <iconify\|weavefox\|none>/);
        assert.match(help, /CHINA/i);
        assert.match(help, /EXPORT_INFOGRAPHIC_ICONS/);
    });
});

// ── --watch ───────────────────────────────────────────────────────────────────

describe('--watch', () => {
    it('defaults to off', () => {
        args('doc.md');
        assert.equal(parseArgs().watch, false);
    });

    it('is set by the flag', () => {
        args('--watch', 'doc.md');
        assert.equal(parseArgs().watch, true);
    });

    it('combines with the other flags', () => {
        args('--watch', '--mode', 'html', '--quiet', 'doc.md');
        const r = parseArgs();
        assert.equal(r.watch, true);
        assert.equal(r.mode, 'html');
        assert.equal(r.quiet, true);
    });

    it('is off for --setup, which takes no document', () => {
        args('--setup', '--watch');
        assert.equal(parseArgs().watch, false);
    });

    it('is listed in the help text', () => {
        assert.match(exitOf('--help').message, /--watch/);
    });
});

// ── One splitter, not two ─────────────────────────────────────────────────────
//
// `parseArgs` and the `--help`/`--list-*` pre-pass used to parse argv two
// different ways: the pre-pass through `tokenize`, the main loop through its own
// fourteen `--flag=value` branches, with VALUE_FLAGS naming the value-taking
// options a third time. Three lists that had to agree by hand — and the reason
// `tokenize` exists at all is that they once did not. These lock the agreement.

describe('both argv forms mean the same thing', () => {
    const pairs: Array<[string, string[], string[]]> = [
        ['input',      ['--input', 'a.md'],          ['--input=a.md']],
        ['stylesheet', ['--stylesheet', 's.css'],    ['--stylesheet=s.css']],
        ['output',     ['--output', 'o.pdf'],        ['--output=o.pdf']],
        ['theme',      ['--theme', 'modern'],        ['--theme=modern']],
        ['mode',       ['--mode', 'html'],           ['--mode=html']],
        ['dpi',        ['--dpi', '150'],             ['--dpi=150']],
    ];

    for (const [what, spaced, equals] of pairs) {
        it(`parses --${what} the same either way`, () => {
            assert.deepEqual(parseArgs([...spaced, 'doc.md']), parseArgs([...equals, 'doc.md']));
        });
    }

    it('lowercases --mode in both forms', () => {
        assert.equal(parseArgs(['--mode', 'HTML', 'doc.md']).mode, 'html');
        assert.equal(parseArgs(['--mode=HTML', 'doc.md']).mode, 'html');
    });

    it('does not mistake a flag\'s value for a flag', () => {
        // The confusion `tokenize` was written to remove: `-h` here is a file
        // name, not a request for the help text.
        const args = parseArgs(['--output', '-h', 'doc.md']);
        assert.equal(args.output, '-h');
        assert.equal(args.inputFile, 'doc.md');
    });

    it('does not care what order the flags come in', () => {
        const a = parseArgs(['--theme', 'modern', '--dpi=150', '--quiet', 'doc.md']);
        const b = parseArgs(['--quiet', '--dpi', '150', '--theme=modern', 'doc.md']);
        assert.deepEqual(a, b);
    });

    it('rejects a value on a boolean flag rather than silently dropping it', () => {
        assert.throws(
            () => parseArgs(['--quiet=true', 'doc.md']),
            (err: unknown) => err instanceof ExitError && err.exitCode === 2
                && /option "--quiet" takes no value/.test(err.message),
        );
    });

    it('reports a missing value for every option that needs one', () => {
        for (const flag of ['--input', '--stylesheet', '--output', '--theme', '--mode', '--dpi']) {
            assert.throws(
                () => parseArgs([flag]),
                (err: unknown) => err instanceof ExitError && err.exitCode === 2
                    && new RegExp(`option "\\${flag}" requires a value`).test(err.message),
                `${flag} should be a usage error naming the flag`,
            );
        }
    });
});

// ── --dry-run / --clear-cache ─────────────────────────────────────────────────

describe('parseArgs --dry-run', () => {
    it('is off unless asked for', () => {
        assert.equal(parseArgs(['doc.md']).dryRun, false);
    });

    it('sets dryRun and still requires a document', () => {
        assert.equal(parseArgs(['--dry-run', 'doc.md']).dryRun, true);
        // Unlike --setup and --clear-cache: there is nothing to validate without one.
        assert.throws(() => parseArgs(['--dry-run']), /no input file specified/);
    });

    it('takes no value', () => {
        assert.throws(() => parseArgs(['--dry-run=yes', 'doc.md']), /takes no value/);
    });

    it('composes with the other flags', () => {
        const r = parseArgs(['--dry-run', '--theme', 'modern', '--mode', 'pdf', 'doc.md']);
        assert.equal(r.dryRun, true);
        assert.equal(r.theme, 'modern');
        assert.equal(r.mode, 'pdf');
    });
});

describe('parseArgs --clear-cache', () => {
    it('needs no input file — it reads no document', () => {
        const r = parseArgs(['--clear-cache']);
        assert.equal(r.clearCache, true);
        assert.equal(r.inputFile, '');
    });

    it('is off otherwise, and never set by --setup', () => {
        assert.equal(parseArgs(['doc.md']).clearCache, false);
        assert.equal(parseArgs(['--setup']).clearCache, false);
        assert.equal(parseArgs(['--clear-cache']).setup, false);
    });

    it('takes no value', () => {
        assert.throws(() => parseArgs(['--clear-cache=all']), /takes no value/);
    });
});

describe('parseArgs --strict', () => {
    it('is off unless asked for', () => {
        assert.equal(parseArgs(['doc.md']).strict, false);
    });

    it('sets strict and composes with the other flags', () => {
        assert.equal(parseArgs(['--strict', 'doc.md']).strict, true);
        const r = parseArgs(['--strict', '--dry-run', '--mode', 'pdf', 'doc.md']);
        assert.equal(r.strict, true);
        assert.equal(r.dryRun, true);
    });

    it('takes no value', () => {
        assert.throws(() => parseArgs(['--strict=yes', 'doc.md']), /takes no value/);
    });

    it('is never set by the document-free flags', () => {
        assert.equal(parseArgs(['--setup']).strict, false);
        assert.equal(parseArgs(['--clear-cache']).strict, false);
    });
});

describe('parseArgs — the document-free modes reject what they would ignore', () => {
    // Both used to accept anything and silently drop half of it: --setup
    // --clear-cache ran the setup and never touched the cache, and
    // --clear-cache doc.md cleared the cache while saying nothing about the
    // document it was handed.
    it('refuses --setup and --clear-cache together', () => {
        assert.throws(() => parseArgs(['--setup', '--clear-cache']), /one at a time/);
        assert.throws(() => parseArgs(['--clear-cache', '--setup']), /one at a time/);
    });

    it('refuses an input file it would not read', () => {
        assert.throws(() => parseArgs(['--setup', 'doc.md']), /"--setup" takes no input file/);
        assert.throws(() => parseArgs(['--clear-cache', 'doc.md']), /"--clear-cache" takes no input file/);
        assert.throws(() => parseArgs(['--setup', '-i', 'doc.md']), /takes no input file/);
    });

    it('still accepts each on its own', () => {
        assert.equal(parseArgs(['--setup']).setup, true);
        assert.equal(parseArgs(['--clear-cache']).clearCache, true);
    });
});

// ── Theme search path ─────────────────────────────────────────────────────────

describe('parseArgs --theme-path', () => {
    afterEach(() => setThemeRoots([]));

    it('collects a single root', () => {
        args('--theme-path', '/a', 'doc.md');
        assert.deepEqual(parseArgs().themePaths, ['/a']);
    });

    it('is repeatable, keeping the order written', () => {
        args('--theme-path', '/a', '--theme-path', '/b', 'doc.md');
        assert.deepEqual(parseArgs().themePaths, ['/a', '/b']);
    });

    it('splits a PATH-style value', () => {
        args('--theme-path', ['/a', '/b'].join(path.delimiter), 'doc.md');
        assert.deepEqual(parseArgs().themePaths, ['/a', '/b']);
    });

    it('accepts the --flag=value form', () => {
        args('--theme-path=/a', 'doc.md');
        assert.deepEqual(parseArgs().themePaths, ['/a']);
    });

    it('requires a value', () => {
        args('--theme-path', 'doc.md');
        // The value is consumed, leaving no input file — which is the error the
        // user actually needs to see.
        assert.throws(() => parseArgs(), (e: unknown) => e instanceof ExitError && e.exitCode === 2);
    });

    it('installs the roots before any theme is read', () => {
        // `--list-themes` runs in the pre-pass; without this it would print a
        // different set from the one the very next export resolves against.
        args('--theme-path', '/somewhere', 'doc.md');
        parseArgs();
        assert.deepEqual(themeRoots(), [path.resolve('/somewhere')]);
    });

    it('puts argv roots ahead of the environment', () => {
        args('--theme-path', '/from-args', 'doc.md');
        const saved = process.env.EXPORT_THEME_PATH;
        process.env.EXPORT_THEME_PATH = '/from-env';
        try {
            parseArgs();
            assert.deepEqual(themeRoots(), [path.resolve('/from-args'), path.resolve('/from-env')]);
        } finally {
            if (saved === undefined) { delete process.env.EXPORT_THEME_PATH; } else { process.env.EXPORT_THEME_PATH = saved; }
        }
    });
});

// ── --release-note ────────────────────────────────────────────────────────────

describe('parseArgs --release-note', () => {
    it('is carried through with --release', () => {
        args('--release', '--release-note', 'signed off', 'doc.md');
        const r = parseArgs();
        assert.equal(r.release, true);
        assert.equal(r.releaseNote, 'signed off');
    });

    it('is null when not given', () => {
        args('--release', 'doc.md');
        assert.equal(parseArgs().releaseNote, null);
    });

    it('is a usage error without --release', () => {
        // The note a person just typed would otherwise vanish while the export
        // looked like it succeeded.
        args('--release-note', 'signed off', 'doc.md');
        assert.throws(() => parseArgs(), (e: unknown) =>
            e instanceof ExitError && e.exitCode === 2 && /only means something with --release/.test(e.message));
    });

    it('accepts a note that looks like a flag', () => {
        args('--release', '--release-note=--not-a-flag', 'doc.md');
        assert.equal(parseArgs().releaseNote, '--not-a-flag');
    });

    it('keeps an empty note distinguishable from an absent one', () => {
        args('--release', '--release-note=', 'doc.md');
        // Empty is rejected as a missing value, like every other value flag.
        assert.throws(() => parseArgs(), (e: unknown) => e instanceof ExitError && e.exitCode === 2);
    });
});

// ── --inspect / --answers ─────────────────────────────────────────────────────

describe('parseArgs --inspect', () => {
    it('sets the flag and still requires a document', () => {
        args('--inspect', 'doc.md');
        const r = parseArgs();
        assert.equal(r.inspect, true);
        assert.equal(r.inputFile, 'doc.md');
    });

    it('takes no value', () => {
        args('--inspect=yes', 'doc.md');
        assert.throws(() => parseArgs(), (e: unknown) => e instanceof ExitError && e.exitCode === 2);
    });
});

describe('parseArgs --answers', () => {
    it('is a usage error without --init', () => {
        args('--answers', 'a.json', 'doc.md');
        assert.throws(() => parseArgs(), (e: unknown) =>
            e instanceof ExitError && e.exitCode === 2 && /only means something with --init/.test(e.message));
    });

    it('reports a missing answers file as a file error, not a crash', () => {
        args('--init', '--answers', '/no/such/answers.json');
        assert.throws(() => parseArgs(), (e: unknown) =>
            e instanceof ExitError && e.exitCode === 3 && /could not read --answers/.test(e.message));
    });

    it('reports malformed JSON as a usage error', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-answers-cli-'));
        try {
            const f = path.join(dir, 'a.json');
            fs.writeFileSync(f, '{ not json');
            args('--init', '--answers', f);
            assert.throws(() => parseArgs(), (e: unknown) =>
                e instanceof ExitError && e.exitCode === 2 && /not valid JSON/.test(e.message));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects a JSON array — the answers must be an object', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-answers-cli-'));
        try {
            const f = path.join(dir, 'a.json');
            fs.writeFileSync(f, '[1,2]');
            args('--init', '--answers', f);
            assert.throws(() => parseArgs(), (e: unknown) =>
                e instanceof ExitError && e.exitCode === 2 && /must hold a JSON object/.test(e.message));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prints the filled scaffold and exits 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-answers-cli-'));
        try {
            const f = path.join(dir, 'a.json');
            fs.writeFileSync(f, JSON.stringify({ title: 'Wizard Doc', author: 'W' }));
            args('--init', '--answers', f);
            assert.throws(() => parseArgs(), (e: unknown) => {
                assert.ok(e instanceof ExitError);
                assert.equal((e as ExitError).exitCode, 0, 'printing is a successful run');
                assert.match((e as ExitError).message, /^Title: Wizard Doc$/m);
                assert.match((e as ExitError).message, /^    Author: W$/m);
                return true;
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── --list-themes --json ──────────────────────────────────────────────────────

describe('parseArgs --list-themes --json', () => {
    it('prints parseable JSON carrying each theme\'s directory', () => {
        // A UI has to parse this; scraping the human listing would make its
        // wording load-bearing, and an external theme's directory — the thing a
        // settings page needs — has nowhere to appear in it.
        args('--list-themes', '--json');
        assert.throws(() => parseArgs(), (e: unknown) => {
            assert.ok(e instanceof ExitError);
            assert.equal((e as ExitError).exitCode, 0);
            const parsed = JSON.parse((e as ExitError).message) as Array<Record<string, string>>;
            assert.ok(Array.isArray(parsed) && parsed.length > 0);
            for (const entry of parsed) {
                assert.ok(entry.name && entry.dir && entry.root);
                assert.ok(entry.source === 'builtin' || entry.source === 'external');
            }
            assert.ok(parsed.some(e2 => e2.name === 'default'));
            return true;
        });
    });

    it('still prints the human listing without --json', () => {
        args('--list-themes');
        assert.throws(() => parseArgs(), (e: unknown) =>
            e instanceof ExitError && /^Available themes:/.test(e.message));
    });
});


describe('resolveThemeRoots precedence', () => {
    it('puts flags ahead of the environment, and both ahead of config files', () => {
        // The more deliberate the source, the more it wins: something typed on
        // this command line beats something set for the shell, which beats a
        // file somebody committed months ago.
        const roots = resolveThemeRoots(['/from-flag'],
                                        { EXPORT_THEME_PATH: '/from-env' },
                                        path.join(os.tmpdir(), 'tmex-no-config-here'));
        assert.deepEqual(roots.slice(0, 2), ['/from-flag', '/from-env']);
    });

    it('works with no flags at all — the case a CLI task hits', () => {
        // The reported failure: the extension passes --theme-path, a task does
        // not, and the same document then fails to resolve its theme.
        const roots = resolveThemeRoots([], {}, path.join(os.tmpdir(), 'tmex-no-config-here'));
        assert.deepEqual(roots, []);
    });

    it('picks up a config beside the document with no flags and no env', () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tmex-cli-cfg-'));
        try {
            fs.writeFileSync(path.join(d, 'platen-markdown-export.json'),
                             JSON.stringify({ themePaths: ['./brand'] }));
            assert.deepEqual(resolveThemeRoots([], {}, d), [path.join(d, 'brand')]);
        } finally {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });
});
