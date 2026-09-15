import * as fs from 'fs';
import * as path from 'path';

/**
 * The extension's logic that does not touch the editor.
 *
 * `extension.ts` imports `vscode` at its top, so nothing in it can be loaded by
 * a plain `node --test` process — which is why 600-odd lines of it, including
 * two functions carrying an "exported for testing" comment, had never been
 * tested by anything. The rules that decide whether a save triggers an export,
 * and whether a discovered `dist/index.js` is safe to run, are ordinary string
 * and filesystem work; they live here so they can be asserted directly.
 */

// ── Frontmatter reading ───────────────────────────────────────────────────────

/**
 * The document's YAML frontmatter block, or null when it has none.
 *
 * Deliberately a regex rather than a YAML parse: the extension has no YAML
 * dependency and this runs on every save. A BOM before the opening delimiter is
 * ordinary in files written on Windows.
 */
export function frontmatterBlock(text: string): string | null {
    const m = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return m ? m[1] : null;
}

/**
 * True when the document declares a top-level `Mode` key.
 *
 * `^Mode` (no leading whitespace, `m` flag) matches the CLI's own top-level
 * lookup, so an indented `Mode:` nested under `Document Info:` correctly does
 * not count — the CLI would not read it either.
 */
export function declaresExportMode(text: string): boolean {
    const block = frontmatterBlock(text);
    return block ? /^Mode[ \t]*:/im.test(block) : false;
}

/**
 * True when the document opts out of save-triggered exports with
 * `Export On Save: false`.
 *
 * The per-document escape hatch for the `exportOnSave` setting. Without it the
 * only way to stop one document exporting on every save was to remove its
 * `Mode:` key — which also stops the explicit Export command from knowing what
 * to produce. Read by the extension alone; the CLI ignores it, because "on
 * save" is not a concept the CLI has.
 *
 * The false vocabulary matches the CLI's own (`false`/`no`/`off`/`0`), so a
 * document does not have to remember a second set of spellings.
 */
export function optsOutOfExportOnSave(text: string): boolean {
    const block = frontmatterBlock(text);
    if (!block) { return false; }
    const m = /^Export On Save[ \t]*:[ \t]*(.+)$/im.exec(block);
    if (!m) { return false; }
    return /^(false|no|off|0)$/i.test(m[1].trim().replace(/^["']|["']$/g, ''));
}

/** A document already has frontmatter if it begins (after an optional BOM) with a `---` fence. */
export function hasFrontmatter(text: string): boolean {
    return /^\uFEFF?---\r?\n/.test(text);
}

/** A starter frontmatter block, mirroring the keys documented in the README. */
export function frontmatterTemplate(today: string = new Date().toISOString().slice(0, 10)): string {
    return [
        '---',
        'Title: Document Title',
        'Document Info:',
        '    Author: Your Name',
        `    Date: "${today}"`,
        '    Revision: 1',
        '    Status: Work In Progress',
        'Revisions:',
        `    - {Revision: 1, Date: "${today}", Author: Your Name, Remarks: Initial version}`,
        'Revisions Visible: 3',
        'Theme: default',
        'Style: Navy',
        'Header:',
        'Footer:',
        'Mode: pdf, html',
        '# Cover Logo:',
        '#     - Path: assets/logo.png',
        "#     - Background: '#ffffff'",
        '---',
        '',
        '',
    ].join('\n');
}

// ── CLI arguments ─────────────────────────────────────────────────────────────

/** The extension settings that become CLI flags. Plain data, so this is testable. */
export interface ExportSettings {
    theme?: string;
    mode?: string;
    stylesheet?: string;
    dpi?: number;
    openAfterExport?: boolean;
    noBump?: boolean;
    quiet?: boolean;
    strict?: boolean;
    extraArgs?: string[];
    /** Extra theme search roots — `platenMarkdownExport.themePaths`. */
    themePaths?: string[];
    /** Pre-filled author for the new-document wizard — `platenMarkdownExport.defaultAuthor`. */
    defaultAuthor?: string;
    /** Where infographic icons come from — `platenMarkdownExport.infographicIcons`. */
    infographicIcons?: string;
}

/** The icon provider the CLI uses when told nothing. */
export const DEFAULT_INFOGRAPHIC_ICONS = 'iconify';

/**
 * Shown when the icon provider is switched to WeaveFox. The setting's own
 * description says the same, but a description is only read by someone already
 * looking for it; this reaches whoever just made the change.
 */
export const WEAVEFOX_WARNING =
    'Infographic icons will now come from WeaveFox — Ant Group\'s service at www.weavefox.cn. '
    + 'The icon names and search terms your documents use are sent there. '
    + 'Data may go to servers in China.';

/**
 * The CLI argument list for one export.
 *
 * Lifted out of `extension.ts` because it is ordinary data-shaping that decides
 * what actually runs — the difference between exporting a document and cutting a
 * release is one element of this array — and none of it could be reached by a
 * test while it read `vscode.workspace.getConfiguration` directly. `core.ts` was
 * created for exactly this and the split stopped one function short.
 *
 * Order matters at the end: `extraArgs` is the user's own escape hatch and comes
 * last so it can override anything above, and the input file is positional, so it
 * must be the final element.
 */
export function buildCliArgs(
    settings: ExportSettings,
    modeOverride: string | null,
    targetPath: string,
    release: boolean,
    releaseNote?: string | null,
): string[] {
    const args: string[] = [];
    const trimmed = (v: string | undefined) => (v || '').trim();

    // Ahead of --theme, because a theme NAME can only resolve once the roots
    // that hold it are known. Order does not matter to the parser, but it is the
    // order the CLI's own help lists them in and the one a copied command line
    // reads correctly in.
    args.push(...themePathArgs(settings.themePaths));

    if (trimmed(settings.theme))      { args.push('--theme', trimmed(settings.theme)); }

    const mode = modeOverride ?? trimmed(settings.mode);
    if (mode)                         { args.push('--mode', mode); }

    if (trimmed(settings.stylesheet)) { args.push('--stylesheet', trimmed(settings.stylesheet)); }
    if (settings.dpi && settings.dpi > 0) { args.push('--dpi', String(settings.dpi)); }

    // Only when it differs from the CLI's own default: an older CLI behind
    // `cliPath` does not know the flag, and the default must not break every
    // export there; and without the flag, EXPORT_INFOGRAPHIC_ICONS still applies.
    const icons = trimmed(settings.infographicIcons);
    if (icons && icons !== DEFAULT_INFOGRAPHIC_ICONS) { args.push('--infographic-icons', icons); }

    if (settings.openAfterExport) { args.push('--open'); }
    if (settings.noBump)          { args.push('--no-bump'); }
    if (settings.quiet)           { args.push('--quiet'); }
    if (settings.strict)          { args.push('--strict'); }

    // Cutting a release is its own command. No export does it without the flag —
    // not this one, not a save-triggered one, not a colleague's.
    if (release) { args.push('--release'); }

    // Only with --release: the CLI rejects the pair otherwise, and an empty note
    // is the same as none — the user dismissed the prompt or typed nothing, and
    // an empty --release-note value is a usage error.
    if (release && (releaseNote || '').trim()) {
        args.push('--release-note', (releaseNote as string).trim());
    }

    args.push(...(settings.extraArgs ?? []));

    // Input is positional and last (the CLI treats the final positional as the input).
    args.push(targetPath);
    return args;
}

/** True when settings force a mode, which overrides whatever the document says. */
export function hasConfiguredMode(settings: ExportSettings): boolean {
    if ((settings.mode || '').trim()) { return true; }
    return (settings.extraArgs ?? []).some((a) => a === '--mode' || a.startsWith('--mode='));
}

// ── CLI identity ──────────────────────────────────────────────────────────────

/** The `name` in the CLI's own package.json — what an auto-discovered `dist/index.js` must claim to be. */
export const CLI_PACKAGE_NAME = 'platen-markdown-export';

/**
 * Whether an auto-discovered `dist/index.js` is really this tool's CLI.
 *
 * `<workspace>/dist/index.js` is an ordinary path for any JavaScript project,
 * and the discovery has no other way to tell one from ours. Without this check,
 * opening someone else's repository and saving a Markdown file with a `Mode:`
 * key ran THEIR `dist/index.js` through Node with our export flags — silently,
 * on save, and with no error to notice, because a program that ignores the
 * arguments and exits 0 looks exactly like a successful export.
 *
 * The proof asked for is the sibling manifest: `dist/index.js` sits one level
 * below the package root, so `../package.json` must name this tool. That is the
 * same file the CLI itself reads for `--version`, and the bundled copy inside
 * the .vsix carries it too, so one rule covers every `.js` candidate. It is not
 * a security boundary on its own — Workspace Trust is, and the manifest says so
 * — but it removes the accident, which is the case that actually happens.
 */
export function isOwnCli(distIndex: string): boolean {
    // dist/index.js → dist → package root.
    const manifest = path.join(path.dirname(path.dirname(distIndex)), 'package.json');
    try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
        return pkg.name === CLI_PACKAGE_NAME;
    } catch {
        return false;   // no manifest, unreadable, or not JSON — not ours
    }
}

/** An auto-discovered candidate is usable only if it exists AND identifies itself as our CLI. */
export function usableCandidate(distIndex: string): boolean {
    return fs.existsSync(distIndex) && isOwnCli(distIndex);
}

// ── Output ────────────────────────────────────────────────────────────────────

/** Quotes an argument for the echoed command line in the output channel. Display only. */
export function quoteArg(a: string): string {
    return /\s/.test(a) ? `"${a}"` : a;
}

/** Exit codes mirror src/errors.ts in the CLI. */
export const EXIT_MESSAGES: Record<number, string> = {
    1: 'Unexpected error.',
    2: 'CLI usage error (bad flags).',
    3: 'Input file or a required asset was not found.',
    4: 'A runtime dependency (WeasyPrint or Chromium) is missing or failed.',
    5: 'Network or fetch error.',
    6: 'Warnings were raised and --strict was given; the output was still written.',
};


// ── Theme search path ─────────────────────────────────────────────────────────

/**
 * `--theme-path` arguments for the configured roots.
 *
 * One flag per root rather than a single delimiter-joined value: a Windows path
 * carries a drive colon, and joining then re-splitting is a round trip through
 * exactly the ambiguity the CLI's `splitThemePath` exists to survive. Passing
 * them separately means neither side has to guess.
 *
 * Blank entries are dropped — an array setting edited by hand routinely ends up
 * with one, and `--theme-path ""` is a usage error the user did not commit.
 */
export function themePathArgs(paths: readonly string[] | undefined): string[] {
    return (paths ?? [])
        .map(p => (p || '').trim())
        .filter(Boolean)
        .flatMap(p => ['--theme-path', p]);
}

/** One theme as `--list-themes --json` reports it. */
export interface ThemeEntry {
    /** The folder's own name — the identity `--theme` and `Theme:` take. */
    name: string;
    /**
     * The name the theme's manifest declares, which `--theme` also accepts.
     *
     * Optional because an older CLI does not report it: every shipped theme
     * disagrees with its folder (`markedapp-byword` declares `Byword`), and a
     * picker that shows only the folder name leaves you guessing which entry is
     * the brand you recognise.
     */
    displayName?: string;
    dir: string;
    source: 'builtin' | 'external';
    root: string;
}

/**
 * How a theme should read in a picker: the folder name, plus what the theme
 * calls itself when that differs.
 */
export function themeLabel(entry: ThemeEntry): string {
    const alias = entry.displayName;
    return !alias || alias.toLowerCase() === entry.name.toLowerCase()
        ? entry.name
        : `${entry.name} (${alias})`;
}

/**
 * Parses `--list-themes --json`, returning [] for anything unexpected.
 *
 * Defensive rather than trusting: this is the output of a *separate program*
 * whose version the extension does not control — an older CLI on the PATH
 * predates `--json` entirely and prints the human listing, which must degrade to
 * an empty picker rather than throwing inside a command handler.
 */
export function parseThemeList(stdout: string): ThemeEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) { return []; }
    return parsed.filter((e): e is ThemeEntry =>
        typeof e === 'object' && e !== null
        && typeof (e as ThemeEntry).name === 'string'
        && typeof (e as ThemeEntry).dir === 'string'
        && ((e as ThemeEntry).source === 'builtin' || (e as ThemeEntry).source === 'external'));
}

// ── Release notes ─────────────────────────────────────────────────────────────

/** The fields of `--inspect` this extension reads. */
export interface DocumentInfo {
    title?: string | null;
    status?: string | null;
    released?: boolean;
    revision?: string | null;
    lastRemarks?: string | null;
    needsReleaseNote?: boolean;
}

/**
 * Parses `--inspect` output, or null when it cannot be trusted.
 *
 * Null rather than a default object: the caller has to tell "the document needs
 * a note" apart from "I could not find out", and those lead to different
 * behaviour — prompt, versus release without prompting rather than blocking on a
 * question we cannot ask sensibly.
 */
export function parseDocumentInfo(stdout: string): DocumentInfo | null {
    try {
        const parsed: unknown = JSON.parse(stdout);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { return null; }
        return parsed as DocumentInfo;
    } catch {
        return null;
    }
}

/**
 * Whether to ask for a release note before cutting this release.
 *
 * Only when the revision being released carries no remark — the request was to
 * prompt "if that is still empty", and prompting every time turns a two-click
 * release into a dialog you learn to dismiss. An unreadable document does not
 * prompt: a question we cannot ask accurately is worse than no question.
 */
export function shouldPromptForReleaseNote(info: DocumentInfo | null): boolean {
    if (!info) { return false; }
    if (typeof info.needsReleaseNote === 'boolean') { return info.needsReleaseNote; }
    // An older CLI without the field: fall back to the two values it implies.
    return info.released === true && !(info.lastRemarks || '').trim();
}


// ── New-document wizard ───────────────────────────────────────────────────────

/**
 * The answers the wizard collects, mirroring the CLI's `FrontmatterAnswers`.
 *
 * Kept as plain data so the whole flow is decided here and `extension.ts` only
 * shows the prompts — the same split that lets `buildCliArgs` be tested. The
 * object is written to a temp file and handed to `--init --answers`, so there is
 * exactly one implementation of answers to frontmatter, and it is the one the
 * exporter itself parses.
 */
export interface WizardAnswers {
    title?: string;
    author?: string;
    theme?: string;
    style?: string;
    mode?: string;
    pageSize?: string;
    orientation?: string;
    classification?: string;
    numberedHeadings?: boolean;
    listOfTables?: boolean;
    listOfFigures?: boolean;
    codeLineNumbers?: boolean;
    runningHeader?: boolean;
}

/** The optional document controls the wizard offers, as pickable labels. */
export const WIZARD_FEATURES: ReadonlyArray<{ label: string; key: keyof WizardAnswers; detail: string }> = [
    { label: 'Numbered headings', key: 'numberedHeadings',
      detail: 'Prefixes ##-###### with a hierarchical number; flows into the TOC' },
    { label: 'Running header', key: 'runningHeader',
      detail: 'Top-left margin shows the current section instead of a fixed string' },
    { label: 'List of tables', key: 'listOfTables',
      detail: 'Index after the TOC, built from Table: captions' },
    { label: 'List of figures', key: 'listOfFigures',
      detail: 'Index after the TOC, built from Figure: captions' },
    { label: 'Code line numbers', key: 'codeLineNumbers',
      detail: 'Numbers every line of every fenced code block' },
];

/**
 * Folds the picked feature labels into the answers.
 *
 * Only the picked ones are set. An unpicked feature stays `undefined` rather
 * than `false`, because the CLI omits an unanswered key entirely — writing
 * `Numbered Headings: false` into a scaffold is noise the author then has to
 * read and decide about.
 */
export function applyWizardFeatures(answers: WizardAnswers, picked: readonly string[]): WizardAnswers {
    const out: WizardAnswers = { ...answers };
    for (const feature of WIZARD_FEATURES) {
        if (picked.includes(feature.label)) { out[feature.key] = true as never; }
    }
    return out;
}

/** Characters no filesystem this runs on will accept in a name. */
const UNSAFE_FILENAME_CHARS = /[<>:"|?*\\/]/g;

/**
 * The filename a document title suggests, or null when nothing usable is left.
 *
 * Only ever a *suggestion* the user edits in a save dialog — which is why an
 * aggressive scrub is safe here and would not be if this named the file
 * outright. Path separators and the Windows-reserved characters go, because the
 * dialog opens on three platforms and the least-common-denominator answer is
 * the one that never surprises anyone.
 */
export function suggestFileName(title: string | undefined): string | null {
    const base = (title || '')
        .replace(UNSAFE_FILENAME_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');          // Windows drops a trailing dot or space
    return base ? base + '.md' : null;
}

/**
 * Rejects a title that cannot be carried through the wizard.
 *
 * Returns the message to show, or null when it is fine. Deliberately permissive
 * about content — a colon or an apostrophe is ordinary in a document title, and
 * `yamlScalar` in the CLI quotes whatever needs quoting — so the only real rule
 * is that there has to be something there.
 */
export function validateTitle(value: string): string | null {
    if (!value.trim()) { return 'A title is required.'; }
    if (value.length > 200) { return 'That is too long for a document title.'; }
    return null;
}


// ── Export on save ────────────────────────────────────────────────────────────

/**
 * Whether saving this document should trigger an export.
 *
 * One predicate, used by both the save handler and the status bar, so what the
 * indicator claims and what actually happens cannot drift. They were separate
 * questions asked in two places, which is how "is this even on?" became
 * unanswerable without reading the source.
 *
 * The rules, in the order they rule a document out:
 *   - the `exportOnSave` setting is off;
 *   - the document declares no top-level `Mode:` and no mode is configured —
 *     without this, saving ANY .md in a workspace (a README, a scratch note)
 *     spawns a Node process that reads the file and exits with nothing to do;
 *   - the document opts out with `Export On Save: false`.
 */
export function shouldExportOnSave(
    text: string,
    settings: ExportSettings,
    exportOnSave: boolean,
): boolean {
    if (!exportOnSave) { return false; }
    if (!declaresExportMode(text) && !hasConfiguredMode(settings)) { return false; }
    return !optsOutOfExportOnSave(text);
}

/**
 * Why a document will not export on save, in the words the status bar uses.
 *
 * Null when it will. Separate from the boolean because "off" and "this document
 * has no Mode" send you to different places, and a tooltip that only says "not
 * exporting" makes you go and find out which.
 */
export function exportOnSaveReason(
    text: string,
    settings: ExportSettings,
    exportOnSave: boolean,
): string | null {
    if (!exportOnSave) { return 'Export on save is off (platenMarkdownExport.exportOnSave)'; }
    if (!declaresExportMode(text) && !hasConfiguredMode(settings)) {
        return 'This document declares no Mode:, so saving it exports nothing';
    }
    if (optsOutOfExportOnSave(text)) { return 'This document sets Export On Save: false'; }
    return null;
}


// ── Runtime dependencies ──────────────────────────────────────────────────────

/** Something an export needs on this machine, and whether it is there. */
export interface Dependency {
    /** `node`, or an id the CLI's `--check-setup --json` reports. */
    id: string;
    name: string;
    installed: boolean;
}

/**
 * The components in `--check-setup --json` output, or null when the output is
 * not that report — a CLI too old to have the flag refuses it, and one that
 * crashed says something else.
 *
 * Tolerates text around the object: the CLI prints it through its result line,
 * which pads it with blank lines and an indent.
 */
export function parseSetupStatus(stdout: string): Dependency[] | null {
    const start = stdout.indexOf('{');
    const end   = stdout.lastIndexOf('}');
    if (start < 0 || end < start) { return null; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
    } catch {
        return null;
    }
    const components = (parsed as { components?: unknown } | null)?.components;
    if (!Array.isArray(components)) { return null; }
    const valid = components.every((c: unknown) => {
        const d = c as Partial<Dependency> | null;
        return typeof d?.id === 'string' && typeof d.name === 'string' && typeof d.installed === 'boolean';
    });
    return valid ? (components as Dependency[]) : null;
}

/**
 * Everything to check when Node.js itself is missing, so the CLI cannot be asked.
 *
 * WeasyPrint and draw.io come from modules the extension loads in-process.
 * Chromium's check needs playwright, and playwright needs a newer Node than the
 * extension host of the oldest VS Code this extension supports, so it is listed
 * as missing. That costs nothing when it is there: `--setup` then finds it
 * installed and moves on.
 */
export function dependenciesWithoutNode(found: { weasyprint: boolean; drawio: boolean }): Dependency[] {
    return [
        { id: 'node',       name: 'Node.js',    installed: false },
        { id: 'weasyprint', name: 'WeasyPrint', installed: found.weasyprint },
        { id: 'chromium',   name: 'Chromium',   installed: false },
        { id: 'drawio',     name: 'draw.io',    installed: found.drawio },
    ];
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
    if (names.length <= 1) { return names.join(''); }
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The one question the extension asks about dependencies, naming all of them. */
export function dependencyPromptMessage(missing: readonly Dependency[]): string {
    return `Platen Markdown Export needs ${joinNames(missing.map(d => d.name))} to export PDFs and render diagrams. `
        + `Install ${missing.length === 1 ? 'it' : 'them'} now?`;
}

/**
 * Whether to ask: something is missing that the user has not declined.
 *
 * "Don't ask again" is remembered per dependency rather than as one switch, so
 * declining draw.io does not also silence the question the day Chromium goes
 * missing — a playwright upgrade leaves the old browser behind, for one.
 */
export function shouldAskAboutDependencies(missing: readonly Dependency[], declined: readonly string[]): boolean {
    return missing.some(d => !declined.includes(d.id));
}

/**
 * What to tell the user when Node.js could not be installed, which stops
 * everything else — the rest is installed by a CLI that runs on it.
 *
 * Linux gets a command rather than an install: `sudo` needs a terminal to ask
 * for the password, and a process the extension starts has none.
 */
export function nodeInstallFailure(platform: NodeJS.Platform): { message: string; command?: string } {
    const lead = 'Platen Markdown Export could not install Node.js, which everything else it needs runs on.';
    if (platform === 'win32') {
        return { message: `${lead} Install it from https://nodejs.org (tick "Add to PATH"), then restart VS Code.` };
    }
    if (platform === 'darwin') {
        return { message: `${lead} Install it from https://nodejs.org, or install Homebrew (https://brew.sh) and try again.` };
    }
    return {
        message: `${lead} Installing it needs administrator rights, which an extension cannot ask for. `
            + 'Run the command in a terminal, then restart VS Code.',
        command: 'sudo apt-get install -y nodejs npm',
    };
}

/** The single message that ends an install. */
export function installResultMessage(installed: readonly string[], failed: readonly string[]): string {
    if (!failed.length) {
        return installed.length
            ? `Platen Markdown Export: installed ${joinNames(installed)}.`
            : 'Platen Markdown Export: setup finished.';
    }
    const also = installed.length ? ` ${joinNames(installed)} ${installed.length === 1 ? 'was' : 'were'} installed.` : '';
    return `Platen Markdown Export could not install ${joinNames(failed)}.${also} The output has the details.`;
}
