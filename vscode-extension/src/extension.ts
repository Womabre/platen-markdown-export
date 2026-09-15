import * as vscode from 'vscode';
import { spawn, spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    hasFrontmatter, frontmatterTemplate,
    usableCandidate, quoteArg, EXIT_MESSAGES,
    buildCliArgs, type ExportSettings,
    themePathArgs, parseThemeList, themeLabel, type ThemeEntry,
    shouldExportOnSave, exportOnSaveReason,
    parseDocumentInfo, shouldPromptForReleaseNote,
    applyWizardFeatures, suggestFileName, validateTitle,
    WIZARD_FEATURES, type WizardAnswers,
    DEFAULT_INFOGRAPHIC_ICONS, WEAVEFOX_WARNING,
} from './core';
import { loadPreviewKit, previewMarkdownItPlugin, type PreviewHost, type PreviewKit } from './preview';

let output: vscode.OutputChannel;

const SUPPORTED_EXT = new Set(['.md', '.markdown', '.html', '.htm']);
const MARKDOWN_ONLY_EXT = new Set(['.md', '.markdown']);

/** Files currently being exported, keyed by fsPath — guards against overlapping
 * runs if the same document is saved again before the previous export finishes
 * (e.g. auto-save, or a quick edit-save-edit-save sequence). */
const exportsInFlight = new Set<string>();

/**
 * Pending debounced save-exports, keyed by fsPath.
 *
 * VS Code's auto-save fires on a delay while you type, so a burst of saves used
 * to mean a burst of exports — each one a WeasyPrint run and possibly a Chromium
 * launch. Coalescing them means the export tracks the pause in typing rather
 * than every keystroke flush.
 */
const pendingSaveExports = new Map<string, NodeJS.Timeout>();
const SAVE_DEBOUNCE_MS = 400;

/** Shared status-bar item — how a save-triggered export reports itself. */
let status: vscode.StatusBarItem;

/**
 * Every export process currently running.
 *
 * Tracked so `deactivate` can end them: the children are spawned detached (see
 * `killTree`), which is what lets us signal the whole tree — and also what would
 * otherwise let a WeasyPrint run outlive the window that started it.
 */
const running = new Set<ReturnType<typeof spawn>>();

/** What `activate` hands back to VS Code — the built-in preview reads `extendMarkdownIt`. */
export interface ExtensionApi {
    extendMarkdownIt(md: MarkdownIt): MarkdownIt;
}

type MarkdownIt = Parameters<ReturnType<typeof previewMarkdownItPlugin>>[0];

export function activate(context: vscode.ExtensionContext): ExtensionApi {
    output = vscode.window.createOutputChannel('Platen Markdown Export');
    context.subscriptions.push(output);

    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'platenMarkdownExport.showOutput';
    status.text = STATUS_IDLE;
    context.subscriptions.push(
        status,
        vscode.commands.registerCommand('platenMarkdownExport.showOutput', () => output.show()),
    );

    const register = (id: string, mode: string | null) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(id, (uri?: vscode.Uri) => runExport(context, uri, mode)),
        );

    register('platenMarkdownExport.export', null);
    register('platenMarkdownExport.exportPdf', 'pdf');
    register('platenMarkdownExport.exportHtml', 'html');
    register('platenMarkdownExport.exportBoth', 'pdf,html');

    // Cutting a release is its own command, because it is its own act: it
    // rewrites the document's revision history. No other path does it.
    context.subscriptions.push(
        vscode.commands.registerCommand('platenMarkdownExport.release',
            (uri?: vscode.Uri) => releaseDocument(context, uri)),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('platenMarkdownExport.setup', () => runSetup(context)),
        vscode.commands.registerCommand('platenMarkdownExport.insertFrontmatter', (uri?: vscode.Uri) => insertFrontmatter(uri)),
        vscode.commands.registerCommand('platenMarkdownExport.installNode', () => forceInstallNode()),
        vscode.commands.registerCommand('platenMarkdownExport.newDocument', () => newDocument(context)),
        vscode.commands.registerCommand('platenMarkdownExport.frontmatterWizard',
            (uri?: vscode.Uri) => frontmatterWizard(context, uri)),
        vscode.commands.registerCommand('platenMarkdownExport.addThemeFolder', () => addThemeFolder(context)),
        vscode.commands.registerCommand('platenMarkdownExport.selectTheme', () => selectTheme(context)),
        vscode.commands.registerCommand('platenMarkdownExport.refreshPreviewThemes',
            () => refreshPreviewKit(context, { announce: true })),
        vscode.commands.registerCommand('platenMarkdownExport.setupMpePreview', () => setupMpePreview(context)),
    );

    // Zero-config auto-export: saving a Markdown document that asked to be
    // exported runs the same export the "Export" command would, with no
    // task/keybinding setup required.
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
            if (!cfg.get<boolean>('exportOnSave')) return;
            if (doc.uri.scheme !== 'file') return;
            if (!MARKDOWN_ONLY_EXT.has(path.extname(doc.uri.fsPath).toLowerCase())) return;

            // Only documents that declare a Mode. Without this, saving ANY .md
            // in the workspace — a README, a scratch note, a changelog — spawned
            // a Node process that read the file, resolved the theme and exited
            // with "Mode not set — nothing to do". The check is a regex over
            // text VS Code already has in memory, so it costs nothing.
            //
            // A mode configured in settings (or forced through extraArgs)
            // overrides the document, so those documents still export.
            // One predicate, shared with the status bar, so the indicator and
            // the behaviour cannot disagree.
            if (!shouldExportOnSave(doc.getText(), readSettings(),
                                    cfg.get<boolean>('exportOnSave') !== false)) return;

            scheduleSaveExport(context, doc.uri);
        }),
    );

    // The status item is the answer to "is this even on?" — see
    // `refreshStatusForActiveEditor`. Kept current as the editor, the document
    // and the settings change.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => refreshStatusForActiveEditor()),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === vscode.window.activeTextEditor?.document) refreshStatusForActiveEditor();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('platenMarkdownExport')) refreshStatusForActiveEditor();
            if (e.affectsConfiguration('platenMarkdownExport.infographicIcons')) void warnIfWeavefox();
            // Anything that changes which themes exist rebuilds the kit; the theme
            // and the switch itself only change what the next render picks.
            if (['themePaths', 'cliPath', 'nodePath', 'env', 'preview.enabled']
                .some(k => e.affectsConfiguration(`platenMarkdownExport.${k}`))) {
                void refreshPreviewKit(context);
            } else if (e.affectsConfiguration('platenMarkdownExport.theme')) {
                void refreshMarkdownPreviews();
            }
        }),
    );
    refreshStatusForActiveEditor();

    void maybePromptForRuntimeDeps(context);

    // The last session's kit serves the first preview straight away; a fresh one
    // replaces it in the background, since themes may have changed in between.
    previewKit = loadPreviewKit(previewKitDir(context));
    void refreshPreviewKit(context);

    return {
        extendMarkdownIt(md: MarkdownIt): MarkdownIt {
            previewMarkdownItPlugin(previewHost)(md);
            return md;
        },
    };
}

// ── Theming the built-in Markdown preview ─────────────────────────────────────

/** The kit the preview plugin reads — null until one has been generated. */
let previewKit: PreviewKit | null = null;

/** The run in progress, and whether another was asked for while it ran. */
let previewKitRun: Promise<void> | null = null;
let previewKitAgain = false;

/**
 * What the preview plugin asks at render time, answered from the live settings.
 *
 * `theme` beats the document here because it does in an export: the extension
 * passes it as `--theme`.
 */
const previewHost: PreviewHost = {
    kit: () => previewKit,
    enabled: () => vscode.workspace.getConfiguration('platenMarkdownExport').get<boolean>('preview.enabled') !== false,
    forcedTheme: () => (vscode.workspace.getConfiguration('platenMarkdownExport').get<string>('theme') || '').trim() || null,
    envTheme: () => buildEnv().EXPORT_THEME ?? null,
};

/** Per-machine, outside every workspace: the kit is generated, never edited. */
function previewKitDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'preview-kit');
}

/** Re-renders open Markdown previews, dropping VS Code's cached tokens. */
async function refreshMarkdownPreviews(): Promise<void> {
    try {
        await vscode.commands.executeCommand('markdown.preview.refresh');
    } catch {
        // The built-in Markdown extension is disabled — there is nothing to refresh.
    }
}

/**
 * Asks the CLI to rebuild the preview kit, then reloads it and refreshes previews.
 *
 * Runs on activation and whenever a setting that decides which themes exist
 * changes. Concurrent requests collapse into one follow-up run, so typing a theme
 * path into settings does not queue a CLI process per keystroke.
 *
 * Quiet unless `announce` (the command): an older CLI without `--preview-kit`, or
 * none at all, just leaves the preview unthemed, with the reason in the log.
 */
async function refreshPreviewKit(context: vscode.ExtensionContext, opts: { announce?: boolean } = {}): Promise<void> {
    if (previewKitRun) {
        previewKitAgain = true;
        return previewKitRun;
    }
    previewKitRun = (async () => {
        do {
            previewKitAgain = false;
            await buildPreviewKit(context, opts.announce === true);
        } while (previewKitAgain);
    })();
    try {
        await previewKitRun;
    } finally {
        previewKitRun = null;
    }
}

async function buildPreviewKit(context: vscode.ExtensionContext, announce: boolean): Promise<void> {
    if (!previewHost.enabled()) {
        if (announce) {
            vscode.window.showInformationMessage(
                'Platen Markdown Export: preview theming is off (platenMarkdownExport.preview.enabled).');
        }
        await refreshMarkdownPreviews();
        return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const anchor = folder?.uri ?? vscode.Uri.file(context.extensionPath);
    const cli = resolveCli(context, anchor);
    if (!cli) {
        output.appendLine('[preview] No CLI found — the Markdown preview stays unthemed.');
        return;
    }

    const dir = previewKitDir(context);
    fs.mkdirSync(dir, { recursive: true });
    // The workspace as cwd, so a platen-markdown-export.json there adds its themes
    // exactly as it does for an export run from that folder.
    const result = await captureCli(cli.command,
        [...cli.baseArgs, ...themePathArgs(readSettings().themePaths), '--preview-kit', dir],
        folder?.uri.fsPath);

    if (result.code !== 0) {
        const reason = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
        output.appendLine(`[preview] Could not build the preview kit: ${reason}`);
        if (announce) {
            vscode.window.showWarningMessage(`Platen Markdown Export: could not build preview themes — ${reason}`);
        }
        return;
    }

    previewKit = loadPreviewKit(dir);
    output.appendLine(`[preview] ${result.stdout.trim()}`);
    if (announce) {
        vscode.window.showInformationMessage(`Platen Markdown Export: ${result.stdout.trim()}`);
    }
    await refreshMarkdownPreviews();
}

/**
 * Writes `.crossnote/parser.js` so Markdown Preview Enhanced themes this
 * workspace's export documents too.
 *
 * A command, never automatic: it writes into the workspace, where a person may
 * have hooks of their own — which the CLI refuses to replace, and whose refusal
 * is shown here rather than buried in the log.
 */
async function setupMpePreview(context: vscode.ExtensionContext): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Platen Markdown Export: open a folder first — MPE reads its parser from the workspace.');
        return;
    }
    const cli = resolveCli(context, folder.uri);
    if (!cli) {
        vscode.window.showErrorMessage('Platen Markdown Export: CLI not found. Check "platenMarkdownExport.cliPath".');
        return;
    }

    const settings = readSettings();
    const theme = (settings.theme || '').trim();
    const result = await captureCli(cli.command, [
        ...cli.baseArgs, ...themePathArgs(settings.themePaths),
        ...(theme ? ['--theme', theme] : []),
        '--preview-kit', path.join(folder.uri.fsPath, '.crossnote'), '--preview-format', 'mpe',
    ], folder.uri.fsPath);

    if (result.code !== 0) {
        const reason = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
        vscode.window.showErrorMessage(`Platen Markdown Export: ${reason}`);
        return;
    }
    output.appendLine(`[preview] ${result.stdout.trim()}`);

    const mpe = vscode.workspace.getConfiguration('markdown-preview-enhanced', folder.uri);
    if (mpe.get<string>('previewTheme') === 'none.css') {
        vscode.window.showInformationMessage(
            'Platen Markdown Export: Markdown Preview Enhanced now previews export documents in their theme. ' +
            'Refresh an open MPE preview to see it.');
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        'Platen Markdown Export: Markdown Preview Enhanced parser written. Its own preview theme still ' +
        'styles the page underneath — switch this workspace to "none.css" so only your theme shows?',
        'Use none.css', 'Leave it');
    if (choice === 'Use none.css') {
        await mpe.update('previewTheme', 'none.css', vscode.ConfigurationTarget.Workspace);
    }
}

/**
 * Shows what saving the active document will do.
 *
 * Export on save is silent by design — it runs on every ⌘S and a notification
 * each time would be unbearable — but silence and "not working" look identical,
 * and that is exactly how it was reported. A document whose output filename had
 * just changed (a release renames `_Rev4` to `_Rev5`) looked like a feature that
 * had stopped firing, with nothing anywhere to say otherwise.
 *
 * So the indicator is present whenever a Markdown document is open, says whether
 * a save will export it, and says why not when it will not. Non-Markdown
 * documents hide it entirely: it has nothing to report about them.
 */
function refreshStatusForActiveEditor(): void {
    // Never over a run in progress — that reporter owns the item until it ends.
    if (activeStatusRuns > 0 || statusHideTimer) { return; }

    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file'
        || !MARKDOWN_ONLY_EXT.has(path.extname(doc.uri.fsPath).toLowerCase())) {
        status.hide();
        return;
    }

    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    const enabled = cfg.get<boolean>('exportOnSave') !== false;
    const reason = exportOnSaveReason(doc.getText(), readSettings(), enabled);

    status.text    = reason ? `$(circle-slash) ${STATUS_LABEL}` : `$(file-pdf) ${STATUS_LABEL}`;
    status.tooltip = reason
        ? `${reason}. Click to show the output log.`
        : 'Saving this document exports it. Click to show the output log.';
    status.show();
}

export function deactivate(): void {
    for (const timer of pendingSaveExports.values()) { clearTimeout(timer); }
    pendingSaveExports.clear();
    // The status bar's own pending hide, so it cannot fire against a disposed item.
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = undefined; }
    activeStatusRuns = 0;
    lastFailureCode.clear();
    // Detached children survive the extension host on their own, so an export
    // running when the window closes would keep WeasyPrint and Chromium going.
    for (const child of running) { killTree(child); }
    running.clear();
}

/**
 * Queues a save-triggered export, collapsing a burst of saves into one run.
 *
 * While an export for the same file is still running the timer is simply set
 * again, so the newest content is exported once the current run finishes rather
 * than the save being dropped with a "save again" note.
 */
function scheduleSaveExport(context: vscode.ExtensionContext, uri: vscode.Uri): void {
    const key = uri.fsPath;

    const existing = pendingSaveExports.get(key);
    if (existing) { clearTimeout(existing); }

    pendingSaveExports.set(key, setTimeout(() => {
        pendingSaveExports.delete(key);
        if (exportsInFlight.has(key)) {
            scheduleSaveExport(context, uri);   // retry once the in-flight run is done
            return;
        }
        void runExport(context, uri, null, { auto: true });
    }, SAVE_DEBOUNCE_MS));
}

/**
 * The extension's settings as plain data.
 *
 * The one place that reads `vscode.workspace.getConfiguration`, so everything
 * downstream of it is testable outside the editor host — see `core.ts`.
 */
function readSettings(): ExportSettings {
    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    return {
        theme:           cfg.get<string>('theme'),
        mode:            cfg.get<string>('mode'),
        stylesheet:      cfg.get<string>('stylesheet'),
        dpi:             cfg.get<number>('dpi'),
        openAfterExport: cfg.get<boolean>('openAfterExport'),
        noBump:          cfg.get<boolean>('noBump'),
        quiet:           cfg.get<boolean>('quiet'),
        strict:          cfg.get<boolean>('strict'),
        extraArgs:       cfg.get<string[]>('extraArgs'),
        themePaths:      cfg.get<string[]>('themePaths'),
        defaultAuthor:   cfg.get<string>('defaultAuthor'),
        infographicIcons: cfg.get<string>('infographicIcons'),
    };
}

/**
 * Warns, once per change, when infographic icons have just been switched to
 * WeaveFox — and offers the way back. The setting is machine-scoped, so the
 * change was made by this user, in their own settings; the point is that they
 * make it knowing where the data goes.
 */
async function warnIfWeavefox(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    if (cfg.get<string>('infographicIcons') !== 'weavefox') return;
    const back = 'Switch back to Iconify';
    const choice = await vscode.window.showWarningMessage(WEAVEFOX_WARNING, back, 'Keep WeaveFox');
    if (choice === back) {
        await cfg.update('infographicIcons', DEFAULT_INFOGRAPHIC_ICONS, vscode.ConfigurationTarget.Global);
    }
}

/** Resolve the markdown/html file to export from the command argument or active editor. */
function resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri && uri.scheme === 'file') {
        return uri;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
        return editor.document.uri;
    }
    return undefined;
}

/**
 * Resolve how to invoke the CLI. Returns the command and the leading args
 * (e.g. ['/path/to/node', '/path/to/dist/index.js'] or ['platen-markdown-export']).
 */
function resolveCli(context: vscode.ExtensionContext, target: vscode.Uri): { command: string; baseArgs: string[] } | undefined {
    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    const nodePath = cfg.get<string>('nodePath') || 'node';
    const configured = (cfg.get<string>('cliPath') || '').trim();

    const isJs = (p: string) => p.toLowerCase().endsWith('.js');
    const asNode = (p: string) => ({ command: nodePath, baseArgs: [p] });

    // 1. Explicit setting. Machine-scoped, so this is the user's own choice and
    // is taken at face value — the identity check below is for paths nobody named.
    if (configured) {
        if (!fs.existsSync(configured)) {
            return undefined; // surfaced to caller as a clear error below
        }
        return isJs(configured) ? asNode(configured) : { command: configured, baseArgs: [] };
    }

    // 2. Workspace dist/index.js (the folder that owns the target, else the first
    // folder) — but only when its manifest says it is this tool. See isOwnCli.
    const folder = vscode.workspace.getWorkspaceFolder(target) ?? vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        const candidate = path.join(folder.uri.fsPath, 'dist', 'index.js');
        if (usableCandidate(candidate)) {
            return asNode(candidate);
        }
    }

    // 3. CLI bundled INSIDE the packaged extension (bundled/dist + bundled/node_modules +
    // bundled/themes, produced by `npm run bundle`) — the normal path for an end user who
    // just installed the .vsix, with nothing else to build or configure.
    const packaged = path.join(context.extensionPath, 'bundled', 'dist', 'index.js');
    if (usableCandidate(packaged)) {
        return asNode(packaged);
    }

    // 3b. Dev fallback: running the extension straight from the repo (F5) without having
    // run the bundle script yet — repo layout is <repo>/vscode-extension + <repo>/dist.
    const bundled = path.join(context.extensionPath, '..', 'dist', 'index.js');
    if (usableCandidate(bundled)) {
        return asNode(bundled);
    }

    // 4. Global binary on PATH.
    return { command: 'platen-markdown-export', baseArgs: [] };
}


function buildEnv(): NodeJS.ProcessEnv {
    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    const extra = cfg.get<Record<string, string>>('env') ?? {};
    return { ...process.env, ...extra };
}

async function runExport(
    context: vscode.ExtensionContext,
    uri: vscode.Uri | undefined,
    mode: string | null,
    opts: { auto?: boolean; release?: boolean; releaseNote?: string | null } = {},
): Promise<void> {
    const target = resolveTarget(uri);
    if (!target) {
        vscode.window.showErrorMessage('Platen Markdown Export: no Markdown/HTML file is selected or active.');
        return;
    }
    if (!SUPPORTED_EXT.has(path.extname(target.fsPath).toLowerCase())) {
        vscode.window.showErrorMessage(`Platen Markdown Export: "${path.basename(target.fsPath)}" is not a .md or .html file.`);
        return;
    }

    const cli = resolveCli(context, target);
    if (!cli) {
        const choice = await vscode.window.showErrorMessage(
            'Platen Markdown Export: the configured platenMarkdownExport.cliPath does not exist.',
            'Open Settings',
        );
        if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'platenMarkdownExport.cliPath');
        }
        return;
    }
    if (cli.command === 'node' && !(await ensureNodeAvailable(context))) {
        return;
    }

    const args = [...cli.baseArgs,
                  ...buildCliArgs(readSettings(), mode, target.fsPath, opts.release === true, opts.releaseNote)];
    exportsInFlight.add(target.fsPath);
    try {
        await runCli(cli.command, args, `Exporting ${path.basename(target.fsPath)}`,
                     path.dirname(target.fsPath),
                     { quiet: opts.auto === true, repeatKey: target.fsPath });
    } finally {
        exportsInFlight.delete(target.fsPath);
    }
}

const DEPS_PROMPT_DISMISSED_KEY = 'platenMarkdownExport.depsPromptDismissed';

/**
 * One-time, best-effort check for WeasyPrint (the one dependency that can't ship
 * inside the .vsix — it's a Python package + native libs, not an npm module).
 * Requires the bundled dist/bootstrap.js directly (no child process) to ask
 * synchronously whether it's already on the machine; if not, offers the
 * existing `--setup` flow with one click. Never blocks activation or installs
 * anything without the user choosing "Install" — this only surfaces the option.
 */
async function maybePromptForRuntimeDeps(context: vscode.ExtensionContext): Promise<void> {
    try {
        const anchor = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(context.extensionPath);
        const cli = resolveCli(context, anchor);

        // Node.js itself doesn't ship inside the .vsix (it's a JS runtime, not an npm
        // package) — every .js-form CLI invocation shells out to it, so check/offer this
        // before the WeasyPrint/Chromium prompt below, which needs Node to actually run.
        if (cli?.command === 'node' && !(await ensureNodeAvailable(context))) {
            return; // declined/failed — --setup can't run without Node; retry next activation
        }

        if (context.globalState.get<boolean>(DEPS_PROMPT_DISMISSED_KEY)) return;

        // Only the .js-file forms carry a local dist/ we can require() from;
        // a bare PATH binary is left to the reactive per-export flow instead.
        const distIndex = cli?.baseArgs[0];
        if (!distIndex || !distIndex.toLowerCase().endsWith('.js')) return;

        const bootstrapPath = path.join(path.dirname(distIndex), 'bootstrap.js');
        if (!fs.existsSync(bootstrapPath)) return;

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { findWeasyprint } = require(bootstrapPath) as { findWeasyprint: () => string | null };
        if (findWeasyprint()) return; // already installed — nothing to offer

        const choice = await vscode.window.showInformationMessage(
            'Platen Markdown Export needs a couple of one-time installs to produce PDFs and render Mermaid diagrams (WeasyPrint, Chromium). Install them now?',
            'Install', 'Not now', "Don't ask again",
        );
        if (choice === 'Install') {
            await vscode.commands.executeCommand('platenMarkdownExport.setup');
        } else if (choice === "Don't ask again") {
            await context.globalState.update(DEPS_PROMPT_DISMISSED_KEY, true);
        }
    } catch {
        /* best-effort only — never block activation on this */
    }
}

async function runSetup(context: vscode.ExtensionContext): Promise<void> {
    // Reuse CLI resolution with the workspace as the "target" anchor.
    const anchor = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(context.extensionPath);
    const cli = resolveCli(context, anchor);
    if (!cli) {
        vscode.window.showErrorMessage('Platen Markdown Export: the configured platenMarkdownExport.cliPath does not exist.');
        return;
    }
    if (cli.command === 'node' && !(await ensureNodeAvailable(context))) {
        return;
    }
    await runCli(cli.command, [...cli.baseArgs, '--setup'], 'Installing runtime dependencies', undefined);
}

// ── Node.js discovery + auto-install ─────────────────────────────────────────
//
// Node.js can't ship inside the .vsix (it's a JS runtime, not an npm package),
// so every .js-form CLI invocation shells out to whatever `nodePath` resolves
// to. Mirrors the CLI's own bootstrap.ts pattern for WeasyPrint: detect via a
// quick probe, offer a one-click platform-native install, refresh PATH in this
// process afterward so it works without restarting VS Code.

const NODE_INSTALL_DISMISSED_KEY = 'platenMarkdownExport.nodeInstallDismissed';

function isNodeAvailable(nodePath: string): boolean {
    try {
        const result = spawnSync(nodePath, ['--version'], { stdio: 'ignore' });
        return result.error === undefined && result.status === 0;
    } catch {
        return false;
    }
}

/** Streams an install command to the output channel + a progress notification. Resolves true on exit code 0. */
function runInstaller(command: string, args: string[], title: string): Thenable<boolean> {
    output.appendLine('');
    output.appendLine(`$ ${command} ${args.map(quoteArg).join(' ')}`);
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () =>
            new Promise<boolean>((resolve) => {
                const child = spawn(command, args, { env: process.env });
                child.stdout?.on('data', (d: Buffer) => output.append(d.toString()));
                child.stderr?.on('data', (d: Buffer) => output.append(d.toString()));
                child.on('error', (err) => {
                    output.appendLine(`\n[install error] ${err.message}`);
                    resolve(false);
                });
                child.on('close', (code) => resolve(code === 0));
            }),
    );
}

function refreshWindowsPath(): void {
    try {
        const machine = execSync(
            'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'Machine\')"',
            { stdio: 'pipe', encoding: 'utf8' },
        ).trim();
        const user = execSync(
            'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"',
            { stdio: 'pipe', encoding: 'utf8' },
        ).trim();
        process.env.PATH = `${machine};${user}`;
    } catch { /* best-effort */ }
}

async function installNodeWindows(): Promise<boolean> {
    const ok = await runInstaller(
        'winget',
        ['install', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements'],
        'Installing Node.js…',
    );
    if (ok) refreshWindowsPath();
    return isNodeAvailable('node');
}

async function installNodeMac(): Promise<boolean> {
    const brewPath = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p));
    if (!brewPath) {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: Homebrew not found, so Node.js can\'t be installed automatically. ' +
            'Install Node.js from https://nodejs.org, or install Homebrew first (https://brew.sh).',
        );
        return false;
    }
    const ok = await runInstaller(brewPath, ['install', 'node'], 'Installing Node.js…');
    if (ok) {
        const prefix = ['/opt/homebrew/bin', '/usr/local/bin'].find((p) => fs.existsSync(path.join(p, 'node')));
        if (prefix) process.env.PATH = `${prefix}:${process.env.PATH}`;
    }
    return isNodeAvailable('node');
}

/**
 * Linux has no password-free install path here, so this hands the command over.
 *
 * `sudo` prompts on a controlling terminal. A spawned child of the extension
 * host has none, so the previous `runInstaller('sudo', …)` sat inside a
 * NON-cancellable progress notification waiting on a prompt that could never be
 * answered or seen — an install that could only ever hang. macOS and Windows
 * keep their automatic paths (Homebrew and winget both work unprivileged here).
 */
async function installNodeLinux(): Promise<boolean> {
    const command = 'sudo apt-get install -y nodejs npm';
    output.appendLine(`\n[manual step] ${command}`);

    const choice = await vscode.window.showErrorMessage(
        'Platen Markdown Export: installing Node.js needs administrator rights, which an extension cannot request. '
        + 'Run the install in a terminal, then try the export again.',
        'Copy Command', 'Show Output',
    );
    if (choice === 'Copy Command') { await vscode.env.clipboard.writeText(command); }
    if (choice === 'Show Output')  { output.show(); }

    return isNodeAvailable('node');
}

async function installNodeForPlatform(): Promise<boolean> {
    if (process.platform === 'win32') return installNodeWindows();
    if (process.platform === 'darwin') return installNodeMac();
    return installNodeLinux();
}

/** Explicit install, triggered by the "Install Node.js" button on a spawn-error notification. */
async function forceInstallNode(): Promise<void> {
    const installed = await installNodeForPlatform();
    if (installed) {
        vscode.window.showInformationMessage('Node.js installed. Try the export again.');
    } else {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: automatic Node.js install failed. Install it manually from ' +
            'https://nodejs.org (tick "Add to PATH" on Windows), then restart VS Code.',
        );
    }
}

/** Checks for Node, offering a one-click install the first time it's missing. Returns whether Node is usable now. */
async function ensureNodeAvailable(context: vscode.ExtensionContext): Promise<boolean> {
    if (isNodeAvailable('node')) return true;
    if (context.globalState.get<boolean>(NODE_INSTALL_DISMISSED_KEY)) return false;

    const choice = await vscode.window.showInformationMessage(
        'Platen Markdown Export needs Node.js installed to run its CLI. Install it now?',
        'Install', 'Not now', "Don't ask again",
    );
    if (choice === "Don't ask again") {
        await context.globalState.update(NODE_INSTALL_DISMISSED_KEY, true);
        return false;
    }
    if (choice !== 'Install') return false;

    const installed = await installNodeForPlatform();
    if (!installed) {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: automatic Node.js install failed. Install it manually from ' +
            'https://nodejs.org (tick "Add to PATH" on Windows), then restart VS Code.',
        );
    }
    return installed;
}

/** Insert a starter frontmatter block at the top of a Markdown file that lacks one. */
async function insertFrontmatter(uri?: vscode.Uri): Promise<void> {
    const target = resolveTarget(uri);
    if (!target) {
        vscode.window.showErrorMessage('Platen Markdown Export: no Markdown file is selected or active.');
        return;
    }
    if (!MARKDOWN_ONLY_EXT.has(path.extname(target.fsPath).toLowerCase())) {
        vscode.window.showErrorMessage(`Platen Markdown Export: "${path.basename(target.fsPath)}" is not a Markdown file.`);
        return;
    }

    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(target);
    } catch {
        vscode.window.showErrorMessage(`Platen Markdown Export: could not open "${path.basename(target.fsPath)}".`);
        return;
    }

    if (hasFrontmatter(doc.getText())) {
        vscode.window.showInformationMessage(`"${path.basename(target.fsPath)}" already starts with a frontmatter block.`);
        return;
    }

    const editor = await vscode.window.showTextDocument(doc);
    const inserted = await editor.edit((e) => e.insert(new vscode.Position(0, 0), frontmatterTemplate()));
    if (!inserted) {
        vscode.window.showErrorMessage(`Platen Markdown Export: failed to insert frontmatter into "${path.basename(target.fsPath)}".`);
        return;
    }
    // Select the placeholder title so the user can start typing over it.
    const titleValue = new vscode.Range(1, 7, 1, 21); // "Title: Document Title"
    editor.selection = new vscode.Selection(titleValue.start, titleValue.end);
    editor.revealRange(titleValue);
}

/**
 * The last exit code each document failed with, so a repeat can stop nagging.
 *
 * A failure always interrupts, and that is right: a save-triggered export that
 * silently produced nothing is worse than one that says so. But "always" and
 * "every time" are different. An exit 3 for an image you have not added yet is
 * one useful interruption and then a modal error on every subsequent save until
 * you add it — which is how people turn `exportOnSave` off. The second and later
 * identical failures for the same document go to the status bar and the output
 * channel instead; a different failure, or a success, interrupts again.
 *
 * Only save-triggered runs are quietened. A manual export is one the user is
 * waiting on, so it always reports.
 */
const lastFailureCode = new Map<string, number>();

/** Spawn the CLI, stream to the output channel, report result. Resolves the exit code. */
function runCli(
    command: string,
    args: string[],
    title: string,
    cwd: string | undefined,
    opts: { quiet?: boolean; repeatKey?: string } = {},
): Thenable<void> {
    output.appendLine('');
    output.appendLine(`$ ${command} ${args.map(quoteArg).join(' ')}`);

    const run = (report: RunReporter): Promise<void> =>
        new Promise<void>((resolve) => {
            // `detached` on POSIX makes the child a process-group leader, which is
            // the whole point: the CLI spawns WeasyPrint, and Playwright spawns
            // Chromium. `child.kill()` signals the CLI alone, so cancelling used
            // to leave a WeasyPrint run and a headless browser finishing the work
            // nobody wanted any more. Killing the group reaches them.
            //
            // Not `unref`'d: we still want the close event. Windows has no process
            // groups to signal, so it gets `taskkill /T` instead.
            const detached = process.platform !== 'win32';
            const child = spawn(command, args, { cwd, env: buildEnv(), detached });
            let lastResultLine = '';

            running.add(child);
            const done = (): void => { running.delete(child); resolve(); };

            report.onCancel(() => killTree(child));

            child.stdout.on('data', (d: Buffer) => {
                const text = d.toString();
                output.append(text);
                const lines = text.split(/\r?\n/).filter(Boolean);
                if (lines.length) { lastResultLine = lines[lines.length - 1]; }
            });
            child.stderr.on('data', (d: Buffer) => output.append(d.toString()));

            child.on('error', (err: NodeJS.ErrnoException) => {
                output.appendLine(`\n[spawn error] ${err.message}`);

                if (err.code === 'ENOENT' && command === 'node') {
                    // Proactive checks (activation, runExport, runSetup) should normally
                    // catch this first — this is the safety net if one was skipped/raced.
                    vscode.window.showErrorMessage(
                        `Platen Markdown Export failed: Node.js was not found on PATH.`,
                        'Install Node.js', 'Show Output',
                    ).then((c) => {
                        if (c === 'Show Output') { output.show(); }
                        if (c === 'Install Node.js') { vscode.commands.executeCommand('platenMarkdownExport.installNode'); }
                    });
                    done();
                    return;
                }

                const hint = command === 'platen-markdown-export'
                    ? ' Could not find the CLI — set platenMarkdownExport.cliPath.'
                    : '';
                vscode.window.showErrorMessage(`Platen Markdown Export failed: ${err.message}.${hint}`, 'Show Output')
                    .then((c) => { if (c === 'Show Output') { output.show(); } });
                done();
            });

            child.on('close', (code) => {
                const key = opts.repeatKey;
                if (code === 0) {
                    if (key) { lastFailureCode.delete(key); }
                    report.succeeded(lastResultLine.replace(/^[✔✓]\s*/, '').trim());
                } else if (code === null) {
                    report.cancelled();
                } else {
                    const msg = EXIT_MESSAGES[code] ?? `Exited with code ${code}.`;
                    // A repeat of the same failure for the same document, on a
                    // run the user did not ask for. It is already in the output
                    // channel and the status bar says it failed; a fifth modal
                    // dialog about the same missing image helps nobody.
                    const repeat = Boolean(opts.quiet && key && lastFailureCode.get(key) === code);
                    if (key) { lastFailureCode.set(key, code); }

                    report.failed();
                    if (repeat) {
                        output.appendLine(`[still failing] ${msg} — fix it and save again.`);
                        done();
                        return;
                    }

                    const actions = code === 4 ? ['Install Dependencies', 'Show Output'] : ['Show Output'];
                    vscode.window.showErrorMessage(`Markdown export failed: ${msg}`, ...actions).then((c) => {
                        if (c === 'Show Output') { output.show(); }
                        if (c === 'Install Dependencies') { vscode.commands.executeCommand('platenMarkdownExport.setup'); }
                    });
                }
                done();
            });
        });

    return opts.quiet ? run(statusBarReporter(title)) : run(notificationReporter(title));
}

/**
 * Ends a spawned export and everything it started.
 *
 * The CLI is a tree, not a process: it runs WeasyPrint through `execFile` and,
 * for a document with Mermaid, a headless Chromium through Playwright. Signalling
 * only the CLI left those running — the cancel button reported success while the
 * machine carried on rendering.
 */
function killTree(child: ReturnType<typeof spawn>): void {
    if (child.pid === undefined) { return; }
    try {
        if (process.platform === 'win32') {
            // No process groups to signal; taskkill /T walks the tree itself.
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            // Negative pid = the whole group, which `detached` made this child lead.
            process.kill(-child.pid, 'SIGTERM');
        }
    } catch {
        try { child.kill(); } catch { /* already gone */ }
    }
}

/**
 * How one run reports itself.
 *
 * A manual export is a thing you asked for and are waiting on, so it gets a
 * progress notification and a completion toast. A save-triggered one is not:
 * with `exportOnSave` on by default, every ⌘S popped a toast, which is how a
 * useful feature turns into something people switch off. It reports in the
 * status bar instead — visible if you look, silent if you don't. Failures
 * interrupt either way.
 */
interface RunReporter {
    onCancel(fn: () => void): void;
    succeeded(detail: string): void;
    cancelled(): void;
    failed(): void;
}

function notificationReporter(title: string): RunReporter {
    // The notification lives as long as the promise handed to `withProgress`, so
    // the run resolves it when it ends rather than the other way round.
    let onCancel: () => void = () => { /* set by the caller below */ };
    let settle:   () => void = () => { /* replaced synchronously by withProgress */ };

    void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Markdown Export: ${title}…`, cancellable: true },
        (_progress, token) => new Promise<void>((resolve) => {
            token.onCancellationRequested(() => onCancel());
            settle = resolve;
        }),
    );

    return {
        onCancel: (fn) => { onCancel = fn; },
        succeeded: (detail) => {
            settle();
            vscode.window.showInformationMessage(
                `Markdown export complete${detail ? `: ${detail}` : ''}.`, 'Show Output',
            ).then((c) => { if (c === 'Show Output') { output.show(); } });
        },
        cancelled: () => { settle(); vscode.window.showWarningMessage('Markdown export cancelled.'); },
        failed: () => { settle(); },
    };
}

/** Idle text for the shared status-bar item; also what a finished run fades back to. */
const STATUS_LABEL = 'Markdown Export';
const STATUS_IDLE = `$(file-pdf) ${STATUS_LABEL}`;

/**
 * Save-triggered runs in flight, and the pending hide for the last one to finish.
 *
 * There is one status-bar item and there can be several exports — VS Code's
 * auto-save fires per document, so saving a book and a chapter together starts
 * two. Each run used to claim the item outright and set its own 4-second hide
 * timer, so the first to finish printed its result over a run that was still
 * going and then hid the item out from under it. Counting the runs means the
 * spinner stays up until the last one lands, and only one timer is ever pending.
 */
let activeStatusRuns = 0;
let statusHideTimer: NodeJS.Timeout | undefined;

function statusBarReporter(title: string): RunReporter {
    activeStatusRuns++;
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = undefined; }

    status.text    = activeStatusRuns > 1
        ? `$(sync~spin) Exporting ${activeStatusRuns} documents…`
        : `$(sync~spin) ${title}…`;
    status.tooltip = 'Platen Markdown Export — click to show the output log';
    status.show();

    const finish = (text: string): void => {
        activeStatusRuns = Math.max(0, activeStatusRuns - 1);
        // A run that finishes while others are still going reports into the
        // output channel, not over their spinner.
        if (activeStatusRuns > 0) {
            status.text = `$(sync~spin) Exporting ${activeStatusRuns} more…`;
            return;
        }
        status.text = text;
        // Long enough to read in passing, short enough not to nag.
        statusHideTimer = setTimeout(() => {
            statusHideTimer = undefined;
            // Back to the armed indicator, not gone: the point is that a glance
            // at the status bar always answers "will saving this export it?".
            refreshStatusForActiveEditor();
        }, 4000);
    };

    return {
        onCancel:  () => { /* a save-triggered run has no cancel button to offer */ },
        succeeded: (detail) => finish(`$(check) ${detail || 'Exported'}`),
        cancelled: () => finish('$(circle-slash) Cancelled'),
        failed:    () => finish('$(error) Export failed'),
    };
}


// ── Reading the CLI's answer to a question ────────────────────────────────────

/**
 * Runs the CLI purely to capture its stdout, with no progress UI.
 *
 * `runCli` is built for exports: it opens a notification, streams to the output
 * channel and reports a result line. `--inspect` and `--list-themes --json` are
 * questions, answered in milliseconds, and putting a progress toast on each one
 * would flash a notification every time the release command runs.
 *
 * Returns null on any failure — a missing CLI, a non-zero exit, a document that
 * does not parse. Every caller has a sensible answer for "I could not find out",
 * and none of them should surface a stack trace for a question the user did not
 * know was being asked.
 */
async function queryCli(command: string, args: string[], cwd?: string): Promise<string | null> {
    const { code, stdout, stderr } = await captureCli(command, args, cwd);
    if (code === 0) { return stdout; }
    if (code !== null) {
        output.appendLine(`[query exited ${code}] ${command} ${args.map(quoteArg).join(' ')}`);
        if (stderr.trim()) { output.appendLine(stderr.trim()); }
    }
    return null;
}

/**
 * Runs the CLI and hands back everything it said, whatever the exit code.
 *
 * For callers that must show the CLI's own reason for failing — a refusal to
 * overwrite a file is worth reading, and "the query failed" is not. `code` is
 * null when the process could not be started at all.
 */
function captureCli(command: string, args: string[], cwd?: string):
    Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(command, args, { cwd, env: buildEnv() });
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[query failed] ${command}: ${err.message}`);
            resolve({ code: null, stdout, stderr: err.message });
        });
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

/** Every theme the CLI can see right now, built-in and external. */
async function listThemes(context: vscode.ExtensionContext, anchor: vscode.Uri): Promise<ThemeEntry[]> {
    const cli = resolveCli(context, anchor);
    if (!cli) { return []; }
    const settings = readSettings();
    const out = await queryCli(cli.command,
                               [...cli.baseArgs, ...themePathArgs(settings.themePaths), '--list-themes', '--json']);
    return out === null ? [] : parseThemeList(out);
}

// ── External theme folders ────────────────────────────────────────────────────

/**
 * Registers a folder of themes, after checking it actually holds some.
 *
 * Validated before it is saved, deliberately: a mistyped path stored in settings
 * fails later, at export time, as "Theme not found" — naming the theme rather
 * than the folder that does not contain it, which sends you looking in the wrong
 * place. Checking here means the error arrives while the folder picker is still
 * the thing you were thinking about.
 */
async function addThemeFolder(context: vscode.ExtensionContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Add theme folder',
        title: 'Select a folder containing theme folders (each with a theme.json)',
    });
    if (!picked || picked.length === 0) { return; }
    const folder = picked[0].fsPath;

    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    const current = cfg.get<string[]>('themePaths') ?? [];
    if (current.some(p => path.resolve(p) === path.resolve(folder))) {
        vscode.window.showInformationMessage(`Platen Markdown Export: "${folder}" is already a theme folder.`);
        return;
    }

    // Ask the CLI what it would find there, rather than reading theme.json here:
    // the CLI owns what a valid theme is, and a second opinion in the editor is
    // one refactor away from disagreeing with it.
    const anchor = vscode.Uri.file(folder);
    const cli = resolveCli(context, anchor);
    if (cli) {
        const out = await queryCli(cli.command,
                                   [...cli.baseArgs, '--theme-path', folder, '--list-themes', '--json']);
        const found = out === null ? [] : parseThemeList(out).filter(t => t.source === 'external');
        if (found.length === 0) {
            const choice = await vscode.window.showWarningMessage(
                `No themes found in "${path.basename(folder)}". A theme folder holds ` +
                'one directory per theme, each containing a theme.json.',
                'Add anyway', 'Cancel',
            );
            if (choice !== 'Add anyway') { return; }
        } else {
            vscode.window.showInformationMessage(
                `Added ${found.length} theme${found.length === 1 ? '' : 's'}: ${found.map(themeLabel).join(', ')}`);
        }
    }

    // Workspace when there is one — a theme folder beside a project is a
    // property of that project — and the user's own settings otherwise.
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await cfg.update('themePaths', [...current, folder], target);
}

/** Picks a theme from every one the CLI can see, and stores the choice. */
async function selectTheme(context: vscode.ExtensionContext): Promise<void> {
    const anchor = resolveTarget() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!anchor) {
        vscode.window.showErrorMessage('Platen Markdown Export: open a folder or a document first.');
        return;
    }

    const themes = await listThemes(context, anchor);
    if (themes.length === 0) {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: could not list themes — see the output log.');
        return;
    }

    const items: vscode.QuickPickItem[] = [
        { label: '$(circle-slash) Let the document decide',
          description: 'Clear the setting; the Theme: frontmatter key wins' },
        ...themes.map(t => ({
            // `label` is written into the setting, so it stays the folder name —
            // the identity --theme resolves. What the theme calls itself goes in
            // the description, where it helps you recognise it without becoming
            // the value.
            label: t.name,
            description: [themeLabel(t) === t.name ? '' : themeLabel(t).replace(`${t.name} `, ''),
                          t.source === 'external' ? 'external' : 'built-in'].filter(Boolean).join(' · '),
            detail: t.source === 'external' ? t.dir : undefined,
        })),
    ];

    const choice = await vscode.window.showQuickPick(items, {
        title: 'Platen Markdown Export: theme',
        placeHolder: 'Theme used for every export unless a document names its own',
    });
    if (!choice) { return; }

    const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
    const value = choice.label.startsWith('$(') ? '' : choice.label;
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await cfg.update('theme', value, target);
    vscode.window.showInformationMessage(
        value ? `Platen Markdown Export: theme set to "${value}".`
              : 'Platen Markdown Export: theme cleared — each document decides.');
}


// ── New-document wizard ───────────────────────────────────────────────────────

/**
 * Walks through the frontmatter a new document needs, then writes it.
 *
 * The questions live here because they are UI; every decision they feed lives in
 * `core.ts`, and the answers are rendered into YAML by the CLI's own
 * `--init --answers`. That last part is the important one: a wizard that
 * assembled YAML in the editor would be a second implementation of the
 * scaffold, and the first thing to break would be a title with a colon in it.
 *
 * Cancelling at any step abandons the whole thing and writes nothing.
 */
/** The CLI plus the file the wizard anchors its resolution to, or null after reporting why not. */
async function wizardContext(
    context: vscode.ExtensionContext,
    preferred?: vscode.Uri,
): Promise<{ cli: { command: string; baseArgs: string[] }; anchor: vscode.Uri } | null> {
    const anchor = preferred ?? resolveTarget() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!anchor) {
        vscode.window.showErrorMessage('Platen Markdown Export: open a folder or a document first.');
        return null;
    }
    const cli = resolveCli(context, anchor);
    if (!cli) {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: the CLI could not be found — set platenMarkdownExport.cliPath.');
        return null;
    }
    if (cli.command === 'node' && !(await ensureNodeAvailable(context))) { return null; }
    return { cli, anchor };
}

/**
 * The wizard's questions, shared by both commands that ask them.
 *
 * Returns undefined the moment a step is cancelled, so a caller writes nothing.
 * Split out because the questions are the feature — creating a file and filling
 * in a document you already have open differ only in what happens to the answers,
 * and a second copy of five prompts is a second place for them to drift.
 */
async function collectAnswers(
    cli: { command: string; baseArgs: string[] },
    anchor: vscode.Uri,
    context: vscode.ExtensionContext,
    stepCount: number,
): Promise<WizardAnswers | undefined> {
    const step = (n: number, label: string): string => `${label} (${n}/${stepCount})`;

    const title = await vscode.window.showInputBox({
        title: step(1, 'Frontmatter: title'),
        prompt: 'Text after " — " or ": " becomes the cover subtitle',
        placeHolder: 'Q3 Report — Operations',
        validateInput: (v) => validateTitle(v) ?? undefined,
    });
    if (title === undefined) { return; }

    const author = await vscode.window.showInputBox({
        title: step(2, 'Frontmatter: author'),
        prompt: 'Shown on the cover and carried into the revisions table',
        value: readSettings().defaultAuthor ?? '',
    });
    if (author === undefined) { return; }

    // The live list, so an external theme registered a minute ago is offered.
    const themes = await listThemes(context, anchor);
    const themePick = await vscode.window.showQuickPick(
        themes.map(t => ({
            label: t.name,
            description: [themeLabel(t) === t.name ? '' : themeLabel(t).replace(`${t.name} `, ''),
                          t.source === 'external' ? 'external' : 'built-in'].filter(Boolean).join(' · '),
            detail: t.source === 'external' ? t.dir : undefined,
        })),
        { title: step(3, 'Frontmatter: theme'), placeHolder: 'Brand package' },
    );
    if (!themePick) { return; }

    // Styles belong to the chosen theme, so this is asked after it and answered
    // by the CLI rather than from a list the editor would have to keep current.
    const stylesOut = await queryCli(cli.command, [
        ...cli.baseArgs, ...themePathArgs(readSettings().themePaths),
        '--theme', themePick.label, '--list-styles', '--json',
    ]);
    let styles: string[] = [];
    try {
        styles = (JSON.parse(stylesOut ?? '{}') as { styles?: string[] }).styles ?? [];
    } catch { styles = []; }

    let style: string | undefined;
    if (styles.length) {
        const stylePick = await vscode.window.showQuickPick(styles, {
            title: step(4, 'Frontmatter: cover style'),
            placeHolder: `Cover style in "${themePick.label}"`,
        });
        if (!stylePick) { return; }
        style = stylePick;
    }

    const modePick = await vscode.window.showQuickPick(
        [
            { label: 'pdf, html', detail: 'Both outputs on every export' },
            { label: 'pdf',       detail: 'Print-quality PDF only' },
            { label: 'html',      detail: 'Self-contained HTML only' },
        ],
        { title: step(5, 'Frontmatter: export mode'), placeHolder: 'What an export produces' },
    );
    if (!modePick) { return; }

    // Optional, and skippable with Escape — every one of these has a sane
    // default of "off", so an empty pick is a complete answer rather than an
    // abandoned wizard.
    const featurePicks = await vscode.window.showQuickPick(
        WIZARD_FEATURES.map(f => ({ label: f.label, detail: f.detail })),
        { title: 'Optional document controls', placeHolder: 'Pick any; none is fine', canPickMany: true },
    );

    const answers: WizardAnswers = {
        title: title.trim(),
        author: author.trim() || undefined,
        // The name the theme calls itself, not the folder it happens to sit in.
        //
        // Writing the folder name put `Theme: acme-theme` into documents — an
        // artefact of one machine's layout, which resolved here (the extension
        // passes --theme-path) and failed everywhere else. The declared name is
        // the theme's identity: it is what the cover shows, it survives the
        // folder being moved or renamed, and it is what someone would have typed
        // by hand. Both still resolve, so nothing that already works breaks.
        theme: themes.find(t => t.name === themePick.label)?.displayName ?? themePick.label,
        style,
        mode: modePick.label,
    };
    return applyWizardFeatures(answers, (featurePicks ?? []).map(p => p.label));
}

/**
 * Renders answers into a frontmatter block via the CLI's own `--init --answers`.
 *
 * The answers go through a temp FILE rather than the command line: a title and
 * an author are free text a person types, and putting that through argv quoting
 * on three platforms is a bug waiting to happen.
 *
 * Returns null after reporting the failure, so callers stop rather than writing
 * an empty document.
 */
async function renderFrontmatter(
    cli: { command: string; baseArgs: string[] },
    answers: WizardAnswers,
): Promise<string | null> {
    const answersFile = path.join(os.tmpdir(), `tmex-answers-${process.pid}-${Date.now()}.json`);
    try {
        fs.writeFileSync(answersFile, JSON.stringify(answers), 'utf8');
        const out = await queryCli(cli.command, [
            ...cli.baseArgs, ...themePathArgs(readSettings().themePaths),
            '--init', '--answers', answersFile,
        ]);
        if (out === null) {
            vscode.window.showErrorMessage(
                'Platen Markdown Export: could not build the frontmatter — see the output log.');
        }
        return out;
    } finally {
        try { fs.rmSync(answersFile, { force: true }); } catch { /* best-effort */ }
    }
}

/**
 * Fills in the frontmatter of the document already open, by asking the same
 * questions the new-document wizard asks.
 *
 * The command "frontmatter wizard" most naturally names — and the one that was
 * missing. `insertFrontmatter` drops a static template with placeholders to edit
 * by hand; `newDocument` asks the questions but only ever creates a NEW file. A
 * document you already started had neither.
 *
 * Refuses a document that already has frontmatter, exactly as
 * `insertFrontmatter` does: rewriting a block someone has edited is not
 * something a wizard should decide to do.
 */
async function frontmatterWizard(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const target = resolveTarget(uri);
    if (!target) {
        vscode.window.showErrorMessage('Platen Markdown Export: no Markdown file is selected or active.');
        return;
    }
    if (!MARKDOWN_ONLY_EXT.has(path.extname(target.fsPath).toLowerCase())) {
        vscode.window.showErrorMessage(
            `Platen Markdown Export: "${path.basename(target.fsPath)}" is not a Markdown file.`);
        return;
    }

    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(target);
    } catch {
        vscode.window.showErrorMessage(
            `Platen Markdown Export: could not open "${path.basename(target.fsPath)}".`);
        return;
    }
    if (hasFrontmatter(doc.getText())) {
        vscode.window.showInformationMessage(
            `"${path.basename(target.fsPath)}" already starts with a frontmatter block.`);
        return;
    }

    const ctx = await wizardContext(context, target);
    if (!ctx) { return; }

    const answers = await collectAnswers(ctx.cli, ctx.anchor, context, 5);
    if (!answers) { return; }

    const frontmatter = await renderFrontmatter(ctx.cli, answers);
    if (frontmatter === null) { return; }

    // Into the buffer rather than onto disk, so it lands in the undo stack —
    // the same choice `insertFrontmatter` makes.
    const editor = await vscode.window.showTextDocument(doc);
    const inserted = await editor.edit(e => e.insert(new vscode.Position(0, 0), frontmatter));
    if (!inserted) {
        vscode.window.showErrorMessage(
            `Platen Markdown Export: failed to insert frontmatter into "${path.basename(target.fsPath)}".`);
    }
}

/** The wizard that creates a document, rather than filling one in. */
async function newDocument(context: vscode.ExtensionContext): Promise<void> {
    const ctx = await wizardContext(context);
    if (!ctx) { return; }

    const answers = await collectAnswers(ctx.cli, ctx.anchor, context, 5);
    if (!answers) { return; }

    const anchor = ctx.anchor;
    const cli = ctx.cli;
    const suggested = suggestFileName(answers.title) ?? 'document.md';
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
        ?? vscode.Uri.file(path.dirname(anchor.fsPath));
    const destination = await vscode.window.showSaveDialog({
        title: 'Save the new document',
        defaultUri: vscode.Uri.joinPath(defaultDir, suggested),
        filters: { Markdown: ['md', 'markdown'] },
    });
    if (!destination) { return; }

    const frontmatter = await renderFrontmatter(cli, answers);
    if (frontmatter === null) { return; }

    const heading = answers.title ? `# ${answers.title}\n\n` : '';
    try {
        fs.writeFileSync(destination.fsPath, `${frontmatter}${heading}`, 'utf8');
    } catch (err: unknown) {
        vscode.window.showErrorMessage(
            `Platen Markdown Export: could not write "${path.basename(destination.fsPath)}": ` +
            `${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    const doc = await vscode.workspace.openTextDocument(destination);
    const editor = await vscode.window.showTextDocument(doc);
    // Cursor at the end, past the frontmatter and the heading, which is where
    // the next thing you type belongs.
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}

// ── Release, with the note the revision is missing ────────────────────────────

/**
 * Asks the CLI whether the revision about to be released carries a remark, and
 * prompts for one when it does not.
 *
 * Only when it is empty: prompting every time turns a two-click release into a
 * dialog you learn to dismiss, and a remark that is already written is not
 * improved by being asked about. A document the CLI could not read does not
 * prompt at all — `--release` will report that problem itself, in its own words,
 * rather than through a question we could not ask accurately.
 *
 * The note lands on the OUTGOING revision — the row describing the work being
 * signed off, which is the one the cover's revision table shows. `--release`
 * then appends the next row with an empty remark of its own, because nothing has
 * happened in it yet.
 */
async function releaseDocument(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const target = resolveTarget(uri);
    if (!target) {
        vscode.window.showErrorMessage('Platen Markdown Export: no Markdown file is selected or active.');
        return;
    }

    let note: string | null = null;
    const cli = resolveCli(context, target);
    if (cli) {
        const settings = readSettings();
        const out = await queryCli(cli.command, [
            ...cli.baseArgs, ...themePathArgs(settings.themePaths), '--inspect', target.fsPath,
        ], path.dirname(target.fsPath));
        const info = parseDocumentInfo(out ?? '');

        if (shouldPromptForReleaseNote(info)) {
            const answer = await vscode.window.showInputBox({
                title: `Release note for revision ${info?.revision ?? ''}`.trim(),
                prompt: 'What changed in the revision being released? Left empty, the row stays blank.',
                placeHolder: 'Incorporated client review comments',
                ignoreFocusOut: true,
            });
            // Escape abandons the release; an empty box releases without a note,
            // which is exactly what happened before this prompt existed.
            if (answer === undefined) { return; }
            note = answer.trim() || null;
        }
    }

    await runExport(context, target, null, { release: true, releaseNote: note });
}
