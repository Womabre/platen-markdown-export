import * as fs from 'fs';
import type { ParsedArgs, FrontmatterAnswers } from './types';
import { listThemes, listThemeEntries, loadTheme, DEFAULT_THEME,
         setThemeRoots, themeRootsFromEnv, splitThemePath } from './theme';
import { frontmatterTemplate } from './frontmatter';
import { discoveredThemeRoots } from './projectconfig';
import { ExitError } from './errors';
import { PREVIEW_FORMATS, runPreviewKit, type PreviewFormat } from './preview-kit';
import { PDF_VARIANTS, INFOGRAPHIC_ICON_PROVIDERS, type InfographicIconProvider } from './config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

const HELP = `
Usage: platen-markdown-export [options] [stylesheet.css] <file.md|file.html>

Options:
  -i, --input <file>       Input .md or .html file (overrides positional)
  -s, --stylesheet <file>  CSS stylesheet to inline (default: the active theme's
                           stylesheet; pass "none" to export without a stylesheet)
  -o, --output <file>      Output PDF path (default: derived from input + revision)
      --theme <name|dir>   Brand package to use (default: default). Overrides the
                           Theme frontmatter field and the EXPORT_THEME env var
      --theme-path <dir>   Extra directory to search for themes, each holding
                           theme folders the way themes/ does. Repeatable, and a
                           value may itself be a PATH-style list. An external
                           theme of the same name shadows a built-in one
      --inspect            Print the document's resolved frontmatter as JSON and
                           exit. Reads the document, renders nothing, writes
                           nothing. Meant for tooling — the VS Code extension asks
                           this whether the revision it is about to release
                           already carries a note
      --mode <pdf|html|debug>   Override the Mode frontmatter field
      --dpi <number>       Override WeasyPrint DPI (default: 300)
      --pdf-variant <id>   Tag the PDF as a conformance level WeasyPrint itself
                           produces — PDF/A (archival), PDF/UA (accessible), or
                           PDF/X (print production) — instead of an ordinary
                           PDF. One of: ${PDF_VARIANTS.filter(v => v !== 'debug').join(', ')}.
                           Passed straight through to WeasyPrint's own
                           --pdf-variant; unset produces an ordinary PDF
      --infographic-icons <iconify|weavefox|none>
                           Where \`\`\`infographic icons come from (default: iconify).
                           iconify sends only a well-formed icon name
                           (mdi/home) to Iconify's public API. weavefox sends
                           the icon names and search terms a document uses to
                           Ant Group's WeaveFox service: DATA MAY GO TO
                           SERVERS IN CHINA.
                           none makes no request; icons are left out
      --open               Open the PDF in the default viewer after export
      --watch              Re-export whenever the document, or anything it reads,
                           changes — until interrupted (Ctrl-C). Includes, local
                           images, draw.io sources and the stylesheet all count;
                           the set follows the document as it changes
      --release-note <text>  Set the Remarks of the revision being released — the
                           current last Revisions row, the one describing the work
                           being signed off. Only with --release
      --release            Cut a release: after the export, append a Revisions row,
                           bump every Revision field and reset Status to Work In
                           Progress. Only does this for a document whose Status is
                           Released (or Vrijgegeven). No export does it without
                           this flag
      --no-bump            Don't modify the source markdown at all — skips the
                           revision-date stamp and the TOC attribute cleanup as well
                           as the release. Useful in CI
      --strict             Exit 6 if the run raised any warning — a missing image,
                           an unresolved include, a font that failed to fetch.
                           The output is still written; the exit code is what
                           changes, so a pipeline can refuse to ship it
      --dry-run            Validate the document and report what it would write,
                           without rendering or writing anything. Checks the theme,
                           styles, colours, assets and output paths — and, for a
                           document whose mode includes pdf, that WeasyPrint is
                           installed
      --clear-cache        Delete the on-disk cache of immutable remote assets
                           (icon-font CSS, Twemoji) and exit. Everything in it is
                           re-fetched on the next export
      --no-revision-bump   Accepted and ignored. It used to suppress the release
                           bump an ordinary export performed; --release is now the
                           only thing that cuts one
      --init               Print a starter frontmatter block on stdout and exit.
                           Redirect it into a new document:
                             platen-markdown-export --init > report.md
      --answers <file.json>  With --init: fill the block in from a JSON object
                           instead of the placeholders. Keys mirror the
                           frontmatter (title, author, theme, style, mode, …)
      --preview-kit <dir>  Write live-preview stylesheets for every theme and style
                           on the search path into <dir> and exit — the export's
                           own CSS, for a Markdown previewer to show a document
                           in its theme while it is written. The VS Code
                           extension does this for its built-in preview
      --preview-format <css|mpe>  With --preview-kit (default: css). css writes
                           index.json, one stylesheet per theme/style and
                           preview-plugin.js; mpe writes a parser.js for a
                           Markdown Preview Enhanced .crossnote folder, with
                           --theme and EXPORT_THEME baked into it
      --list-themes        Print available brand packages (themes) and exit
      --list-styles        Print the active theme's cover styles and exit
      --json               With --list-themes / --list-styles / --check-setup:
                           print JSON instead of the human listing
      --setup              Install WeasyPrint, Playwright Chromium and draw.io if
                           missing, then exit
      --check-setup        Report which of those --setup would install, install
                           nothing, and exit
  -q, --quiet              Suppress progress output; warnings and result line always shown
  -v, --version            Print version and exit
  -h, --help               Show this help message

Environment variables:
  EXPORT_THEME               Brand package to use (same as --theme; default: default)
  EXPORT_THEME_PATH          Extra theme directories (same as --theme-path), as a
                             PATH-style list
  EXPORT_PDF_DPI             Override WeasyPrint DPI (same as --dpi)
  EXPORT_PDF_VARIANT         Default --pdf-variant when the flag is not given
  EXPORT_INFOGRAPHIC_ICONS   Default --infographic-icons when the flag is not given
  EXPORT_PDF_TIMEOUT_MS      Network fetch timeout in ms  (default: 15000)
  EXPORT_PDF_LOGO            Override page header/footer logo path
  EXPORT_PDF_LOGO_WHITE      Override cover page (white) logo path
  EXPORT_PDF_IMAGE_QUALITY   JPEG quality for oversized body images (1–100, default: 88)
  EXPORT_PDF_CONCURRENCY     Max diagrams/images rendered at once (1–64, default: 4)
  EXPORT_PDF_MAX_RESPONSE_MB Ceiling on a single remote fetch (1–2048, default: 50)
  EXPORT_PDF_ALLOW_PRIVATE_HOSTS  Allow fetches to loopback/private/link-local
                             addresses (default: off — a document must not be
                             able to reach localhost or a metadata endpoint)

Exit codes:
  0  Success
  1  Unexpected error
  2  CLI usage error (bad flags)
  3  Input file or required asset not found
  4  WeasyPrint or Chromium not found or failed
  5  Network or fetch error
  6  Warnings were raised and --strict was given
`.trim();

/** Options that consume the following argument as their value. */
const VALUE_FLAGS = ['-i', '--input', '-s', '--stylesheet', '-o', '--output', '--theme', '--mode', '--dpi',
                     '--pdf-variant', '--infographic-icons', '--theme-path', '--release-note', '--answers',
                     '--preview-kit', '--preview-format'];

interface ArgToken {
    /** The option itself, with any `=value` split off. */
    flag: string;
    /** Its value, from either the `--flag value` or `--flag=value` form. */
    value: string | null;
}

/**
 * Splits argv into options and the values they consume.
 *
 * The pre-pass used to ask `argv.includes('-h')`, which cannot tell an option
 * from an option's *value*: `--output -h doc.md` names an output file called
 * `-h`, and printed the help text instead. Pairing each value-taking flag with
 * the token after it removes that whole class of confusion, and folds the
 * `--flag=value` form into the same shape so callers stop handling it twice.
 */
function tokenize(argv: string[]): ArgToken[] {
    const tokens: ArgToken[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (VALUE_FLAGS.includes(arg)) {
            tokens.push({ flag: arg, value: argv[++i] ?? null });
            continue;
        }
        const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(arg);
        tokens.push(eq ? { flag: eq[1], value: eq[2] } : { flag: arg, value: null });
    }
    return tokens;
}

/** The value given to `flag`, in either form, or null. Flag order does not matter. */
function peekFlag(tokens: ArgToken[], flag: string): string | null {
    return tokens.find(t => t.flag === flag)?.value ?? null;
}

/** Every value given to a repeatable flag, in the order they were written. */
function peekAll(tokens: ArgToken[], flag: string): string[] {
    return tokens.filter(t => t.flag === flag && t.value !== null).map(t => t.value as string);
}

/**
 * Installs the external theme roots named by argv and the environment.
 *
 * Runs before anything reads a theme — which includes the `--list-themes` and
 * `--list-styles` pre-pass below, and that is the reason it happens here rather
 * than in `main()`. Listing themes without the roots applied would print a
 * different set from the one the very next export resolves against.
 *
 * Argv wins over the environment by coming first in the search order, on the
 * same reasoning as `--theme` beating `EXPORT_THEME`: the more specific, more
 * deliberate source is the one written on the command line.
 */
export function applyThemeRoots(
    tokens: ArgToken[],
    env: NodeJS.ProcessEnv = process.env,
    fromDir: string = process.cwd(),
): void {
    setThemeRoots(resolveThemeRoots(peekAll(tokens, '--theme-path'), env, fromDir));
}

/**
 * The theme roots in effect, in search order.
 *
 * Pure, and exported, because `main()` has to redo this once the document is
 * known: the pre-pass can only walk up from the working directory, which is
 * wherever the command was run rather than anywhere near the document. A project
 * config beside the document is the one that should decide its theme.
 *
 * Order is precedence: an explicit flag beats the environment, which beats a
 * config file — the more deliberate the source, the more it wins.
 */
export function resolveThemeRoots(
    flagValues: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    fromDir: string = process.cwd(),
): string[] {
    return [
        ...flagValues.flatMap(splitThemePath),
        ...themeRootsFromEnv(env),
        ...discoveredThemeRoots(fromDir),
    ];
}

/**
 * Flags that print something and stop, before any document work happens.
 *
 * Handled in a pre-pass over the whole argv rather than inside the main loop,
 * so that `--theme x --list-styles` and `--list-styles --theme x` behave the
 * same. Doing this inside the loop made the outcome depend on argument order.
 *
 * Each throws `ExitError(text, 0)`: exit code 0 is a successful run whose
 * output happens to be text, so `main().catch` prints it on stdout.
 */
function handleImmediateFlags(argv: string[]): void {
    const tokens = tokenize(argv);
    const has = (...flags: string[]) => tokens.some(t => flags.includes(t.flag));

    if (has('-h', '--help'))    throw new ExitError(HELP, 0);
    if (has('-v', '--version')) throw new ExitError(version, 0);

    // Before any theme is read — see `applyThemeRoots`.
    applyThemeRoots(tokens);

    // Printed rather than written: the CLI has no business creating or editing a
    // file the user has not named, and `--init > report.md` composes with
    // everything else. The VS Code extension inserts the same block into the
    // open buffer instead, where it is undoable.
    //
    // `--answers <file>` fills it in from a JSON object instead of the
    // placeholders. That is what the extension's new-document wizard runs, so
    // there is exactly one implementation of answers → frontmatter rather than a
    // second one in TypeScript that compiles for the editor.
    // Writes files rather than printing, but only into the directory named on
    // the command line — the one thing `--init` below declines to do is create
    // a file nobody asked for.
    if (has('--preview-format') && !has('--preview-kit'))
        throw new ExitError('Error: --preview-format only means something with --preview-kit\n', 2);
    if (has('--preview-kit')) {
        const dir = peekFlag(tokens, '--preview-kit');
        if (!dir) throw new ExitError('Error: --preview-kit needs a directory\n', 2);
        const format = peekFlag(tokens, '--preview-format') ?? 'css';
        if (!(PREVIEW_FORMATS as readonly string[]).includes(format))
            throw new ExitError(`Error: --preview-format must be one of: ${PREVIEW_FORMATS.join(', ')} (got "${format}")\n`, 2);
        throw new ExitError(runPreviewKit(dir, format as PreviewFormat, {
            forcedTheme: peekFlag(tokens, '--theme'),
            envTheme: process.env.EXPORT_THEME ?? null,
        }), 0);
    }

    if (has('--init')) {
        const answersFile = peekFlag(tokens, '--answers');
        throw new ExitError(frontmatterTemplate(undefined, readAnswers(answersFile)), 0);
    }
    if (has('--answers'))
        throw new ExitError('Error: --answers only means something with --init\n', 2);

    if (has('--list-themes')) {
        // `--json` because a UI has to parse this. Scraping the human list would
        // make its wording load-bearing, and an external theme's directory —
        // which is the thing a settings page needs — has nowhere to appear in it.
        if (has('--json')) throw new ExitError(JSON.stringify(listThemeEntries(), null, 2), 0);
        const entries = listThemeEntries();
        const label = (n: string): string => {
            const e = entries.find(x => x.name === n);
            if (!e) return `  ${n}`;
            // The manifest's own name, when it differs from the folder's. Both
            // resolve, and a document is as likely to write one as the other —
            // `markedapp-byword` calls itself `Byword`.
            const alias = e.displayName.toLowerCase() === e.name.toLowerCase() ? '' : `  (${e.displayName})`;
            return e.source === 'external' ? `  ${n}${alias}  — ${e.dir}` : `  ${n}${alias}`;
        };
        throw new ExitError('Available themes:\n' + listThemes().map(label).join('\n'), 0);
    }

    if (has('--list-styles')) {
        const themeArg = peekFlag(tokens, '--theme') ?? process.env.EXPORT_THEME ?? DEFAULT_THEME;
        const t = loadTheme(themeArg);
        const names = Object.keys(t.styles).filter(s => s !== 'none');
        if (has('--json')) throw new ExitError(JSON.stringify({ theme: t.name, styles: names }, null, 2), 0);
        throw new ExitError(
            `Available styles in theme "${t.name}":\n` + names.map(n => `  ${n}`).join('\n'), 0,
        );
    }
}

/**
 * Reads the `--answers` JSON file, or returns nothing when none was given.
 *
 * A file rather than an inline JSON argument: the answers carry a title and an
 * author, which are free text a person types, and putting that through argv
 * quoting on three platforms is a bug waiting to happen.
 */
function readAnswers(file: string | null): FrontmatterAnswers | undefined {
    if (!file) return undefined;
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        throw new ExitError(`Error: could not read --answers file: ${file}\n`, 3);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: unknown) {
        throw new ExitError(
            `Error: --answers file is not valid JSON (${file}): ${(err as Error).message}\n`, 2);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new ExitError(`Error: --answers file must hold a JSON object: ${file}\n`, 2);
    return parsed as FrontmatterAnswers;
}

const VALID_MODES = new Set(['pdf', 'html', 'debug']);

/**
 * Splits a comma-separated mode string and reports any values that are not
 * modes. Shared by the CLI (which rejects them) and `main()` (which warns,
 * because there the value came from frontmatter and the rest of the document
 * is still exportable).
 */
export function parseModes(raw: string | null): { modes: string[]; unknown: string[] } {
    const parts = raw ? raw.replace(/\s+/g, '').split(',').filter(Boolean) : [];
    return {
        modes:   parts.filter(m => VALID_MODES.has(m)),
        unknown: parts.filter(m => !VALID_MODES.has(m)),
    };
}

/**
 * Parses argv into the export plan.
 *
 * Never calls `process.exit` and never writes to the console: every exit path
 * throws `ExitError`, so the single handler in `main().catch` owns process
 * termination and this function stays callable from a test.
 *
 * @param argv Arguments without the node/script prefix. Defaults to the real
 *             process arguments; passed explicitly by tests.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
    handleImmediateFlags(argv);

    const positional: string[] = [];
    let input:      string | null = null;
    let stylesheet: string | null = null;
    let theme:      string | null = null;
    let output:     string | null = null;
    let mode:       string | null = null;
    let dpiRaw:     string | null = null;
    let pdfVariantRaw: string | null = null;
    let infographicIconsRaw: string | null = null;
    let releaseNote: string | null = null;
    const themePaths: string[] = [];
    let quiet                     = false;
    let open                      = false;
    let watch                     = false;
    let noBump                    = false;
    let release                   = false;
    let noRevisionBump            = false;
    let setup                     = false;
    let dryRun                    = false;
    let clearCacheFlag            = false;
    let strict                    = false;
    let inspect                   = false;
    let checkSetup                = false;
    let json                      = false;

    // Over `tokenize`, the same splitter `handleImmediateFlags` runs on.
    //
    // This loop used to re-implement it: fourteen `arg.startsWith('--x=')`
    // branches beside the `--x value` ones, with VALUE_FLAGS listing the same
    // flags a third time for the error path. Three places had to agree about
    // which options take a value, by hand — and they already disagreed once, in
    // the pre-pass, which is why `tokenize` was written. One splitter, one list.
    const tokens = tokenize(argv);

    /** The value of a flag that requires one. */
    const required = (flag: string, value: string | null): string => {
        if (value === null || value === '') throw new ExitError(`Error: option "${flag}" requires a value\n`, 2);
        return value;
    };

    /** A boolean flag takes no value, so `--quiet=true` is a usage error, not a quiet accept. */
    const bare = (flag: string, value: string | null): true => {
        if (value !== null) throw new ExitError(`Error: option "${flag}" takes no value\n`, 2);
        return true;
    };

    for (const { flag, value } of tokens) {
        switch (flag) {
            case '-i': case '--input':      input      = required(flag, value); break;
            case '-s': case '--stylesheet': stylesheet = required(flag, value); break;
            case '-o': case '--output':     output     = required(flag, value); break;
            case '--theme':                 theme      = required(flag, value); break;
            case '--dpi':                   dpiRaw     = required(flag, value); break;
            case '--pdf-variant':           pdfVariantRaw = required(flag, value).toLowerCase(); break;
            case '--infographic-icons':     infographicIconsRaw = required(flag, value).toLowerCase(); break;
            case '--mode':                  mode       = required(flag, value).toLowerCase(); break;
            // Repeatable, and each value may itself be a PATH-style list.
            case '--theme-path':            themePaths.push(...splitThemePath(required(flag, value))); break;
            case '--release-note':          releaseNote = required(flag, value); break;

            case '-q': case '--quiet':      quiet          = bare(flag, value); break;
            case '--open':                  open           = bare(flag, value); break;
            case '--watch':                 watch          = bare(flag, value); break;
            case '--no-bump':               noBump         = bare(flag, value); break;
            case '--release':               release        = bare(flag, value); break;
            case '--no-revision-bump':      noRevisionBump = bare(flag, value); break;
            case '--setup':                 setup          = bare(flag, value); break;
            case '--dry-run':               dryRun         = bare(flag, value); break;
            case '--strict':                strict         = bare(flag, value); break;
            case '--clear-cache':           clearCacheFlag = bare(flag, value); break;
            case '--inspect':               inspect        = bare(flag, value); break;
            case '--check-setup':           checkSetup     = bare(flag, value); break;
            // The pre-pass consumes --json for the listings; --check-setup reads it below.
            case '--json':                  json           = bare(flag, value); break;
            // Consumed by the pre-pass; accepted here so it is not "unknown".
            case '--init':                  bare(flag, value); break;

            default:
                if (!flag.startsWith('-')) { positional.push(flag); break; }
                throw new ExitError(`Error: unknown option "${flag}"\n\n${HELP}`, 2);
        }
    }

    // None of `--setup`, `--check-setup` or `--clear-cache` reads a document: the
    // first installs the runtime dependencies, the second reports which are
    // missing, the third empties the asset cache. All stop there, so none
    // requires the input file the check below would otherwise demand.
    //
    // They are also mutually exclusive, and they reject a document rather than
    // ignoring one. They used to accept anything and silently drop it:
    // `--setup --clear-cache` ran the setup and never touched the cache, and
    // `--clear-cache doc.md` cleared the cache while saying nothing about the
    // document it was handed. A one-shot action that quietly discards half of
    // what you asked for is worse than one that says it cannot.
    const actions = [setup && '--setup', checkSetup && '--check-setup', clearCacheFlag && '--clear-cache']
        .filter((a): a is string => Boolean(a));
    if (actions.length > 1)
        throw new ExitError(
            `Error: ${actions.join(' and ')} are separate actions; run them one at a time.\n`, 2);

    if (actions.length && (positional.length || input))
        throw new ExitError(`Error: option "${actions[0]}" takes no input file\n`, 2);

    if (actions.length) {
        return { inputFile: '', stylesheetPath: null, theme, mode: null, output: null,
                 dpi: null, quiet, open: false, noBump: false, release: false,
                 noRevisionBump: false, setup, checkSetup, json, watch: false, dryRun: false,
                 clearCache: clearCacheFlag, strict: false, inspect: false,
                 releaseNote: null, themePaths, pdfVariant: null, infographicIcons: null };
    }

    // Positional fallback: [stylesheet] <input>
    input      = input      ?? positional[positional.length - 1] ?? null;
    stylesheet = stylesheet ?? (positional.length >= 2 ? positional[0] : null);

    if (!input)
        throw new ExitError(`Error: no input file specified.\n\n${HELP}`, 2);

    if (mode) {
        const { modes, unknown } = parseModes(mode);
        if (unknown.length)
            throw new ExitError(
                `Error: --mode values must be "pdf", "html", or "debug"; got "${unknown.join('", "')}"\n`, 2,
            );
        mode = modes.join(',');
    }

    // A note with nothing to attach it to is a mistake worth naming rather than
    // dropping: the text a person just typed would otherwise vanish, and the
    // export would look like it succeeded.
    if (releaseNote !== null && !release)
        throw new ExitError('Error: --release-note only means something with --release\n', 2);

    // Validated as a whole string, not by what `parseInt` can salvage from its
    // front: `--dpi 300abc` used to silently become 300, and `--dpi 1e3` 1.
    let dpi: number | null = null;
    if (dpiRaw !== null) {
        if (!/^\d+$/.test(dpiRaw.trim()) || parseInt(dpiRaw, 10) <= 0)
            throw new ExitError(`Error: --dpi must be a positive integer; got "${dpiRaw}"\n`, 2);
        dpi = parseInt(dpiRaw, 10);
    }

    // Validated against WeasyPrint's own enum so a typo fails fast with the
    // full list of valid values, rather than reaching WeasyPrint as a
    // usage error whose remedy is buried in its own --help output.
    if (pdfVariantRaw !== null && !PDF_VARIANTS.includes(pdfVariantRaw as typeof PDF_VARIANTS[number]))
        throw new ExitError(
            `Error: --pdf-variant must be one of: ${PDF_VARIANTS.join(', ')}; got "${pdfVariantRaw}"\n`, 2);

    if (infographicIconsRaw !== null &&
        !(INFOGRAPHIC_ICON_PROVIDERS as readonly string[]).includes(infographicIconsRaw))
        throw new ExitError(
            `Error: --infographic-icons must be one of: ${INFOGRAPHIC_ICON_PROVIDERS.join(', ')}; got "${infographicIconsRaw}"\n`, 2);

    return { inputFile: input, stylesheetPath: stylesheet ?? null, theme, mode, output,
             dpi, quiet, open, noBump, release, noRevisionBump, setup: false, checkSetup: false, json, watch,
             dryRun, clearCache: false, strict, inspect, releaseNote, themePaths,
             pdfVariant: pdfVariantRaw,
             infographicIcons: infographicIconsRaw as InfographicIconProvider | null };
}
