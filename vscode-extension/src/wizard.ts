import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    hasFrontmatter, MARKDOWN_ONLY_EXT, themePathArgs, type ExportSettings, type ThemeEntry,
    applyWizardFeatures, suggestFileName, validateTitle, WIZARD_FEATURES, type WizardAnswers,
    themePickItems, themeAnswer, parseStyleList, MODE_CHOICES, newDocumentContent,
} from './core';

/**
 * The new-document wizard and the frontmatter wizard.
 *
 * Both walk through the frontmatter a document needs and differ only in where
 * the answers go: a new file, or the top of the document already open. The
 * questions live here because they are UI; every decision they feed lives in
 * `core.ts`, and the answers are rendered into YAML by the CLI's own
 * `--init --answers`. That last part is the important one: a wizard that
 * assembled YAML in the editor would be a second implementation of the
 * scaffold, and the first thing to break would be a title with a colon in it.
 *
 * Cancelling at any step abandons the whole thing and writes nothing.
 *
 * A module of its own because extension.ts had grown to 1600 lines; what it
 * needs from there arrives through `WizardHost` rather than an import back into
 * extension.ts, the same arrangement `preview.ts` makes with `PreviewHost`.
 */

/** How the wizard reaches the CLI. */
export interface WizardCli { command: string; baseArgs: string[] }

/** What the wizard needs from the rest of the extension. */
export interface WizardHost {
    readSettings(): ExportSettings;
    resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined;
    resolveCli(target: vscode.Uri): WizardCli | undefined;
    ensureCliRunnable(cli: WizardCli): Promise<boolean>;
    listThemes(anchor: vscode.Uri): Promise<ThemeEntry[]>;
    queryCli(command: string, args: string[], cwd?: string): Promise<string | null>;
}

/** How many questions are numbered. The feature pick is optional and unnumbered. */
const STEP_COUNT = 5;

/** The CLI plus the file the wizard anchors its resolution to, or null after reporting why not. */
async function wizardContext(
    host: WizardHost,
    preferred?: vscode.Uri,
): Promise<{ cli: WizardCli; anchor: vscode.Uri } | null> {
    const anchor = preferred ?? host.resolveTarget() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!anchor) {
        vscode.window.showErrorMessage('Platen Markdown Export: open a folder or a document first.');
        return null;
    }
    const cli = host.resolveCli(anchor);
    if (!cli) {
        vscode.window.showErrorMessage(
            'Platen Markdown Export: the CLI could not be found — set platenMarkdownExport.cliPath.');
        return null;
    }
    if (!(await host.ensureCliRunnable(cli))) { return null; }
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
async function collectAnswers(host: WizardHost, cli: WizardCli, anchor: vscode.Uri): Promise<WizardAnswers | undefined> {
    const step = (n: number, label: string): string => `${label} (${n}/${STEP_COUNT})`;

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
        value: host.readSettings().defaultAuthor ?? '',
    });
    if (author === undefined) { return; }

    // The live list, so an external theme registered a minute ago is offered.
    const themes = await host.listThemes(anchor);
    const themePick = await vscode.window.showQuickPick(themePickItems(themes),
        { title: step(3, 'Frontmatter: theme'), placeHolder: 'Brand package' });
    if (!themePick) { return; }

    // Styles belong to the chosen theme, so this is asked after it and answered
    // by the CLI rather than from a list the editor would have to keep current.
    const styles = parseStyleList(await host.queryCli(cli.command, [
        ...cli.baseArgs, ...themePathArgs(host.readSettings().themePaths),
        '--theme', themePick.label, '--list-styles', '--json',
    ]));

    let style: string | undefined;
    if (styles.length) {
        const stylePick = await vscode.window.showQuickPick(styles, {
            title: step(4, 'Frontmatter: cover style'),
            placeHolder: `Cover style in "${themePick.label}"`,
        });
        if (!stylePick) { return; }
        style = stylePick;
    }

    const modePick = await vscode.window.showQuickPick([...MODE_CHOICES],
        { title: step(5, 'Frontmatter: export mode'), placeHolder: 'What an export produces' });
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
        theme: themeAnswer(themes, themePick.label),
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
async function renderFrontmatter(host: WizardHost, cli: WizardCli, answers: WizardAnswers): Promise<string | null> {
    const answersFile = path.join(os.tmpdir(), `pmex-answers-${process.pid}-${Date.now()}.json`);
    try {
        fs.writeFileSync(answersFile, JSON.stringify(answers), 'utf8');
        const out = await host.queryCli(cli.command, [
            ...cli.baseArgs, ...themePathArgs(host.readSettings().themePaths),
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
export async function frontmatterWizard(host: WizardHost, uri?: vscode.Uri): Promise<void> {
    const target = host.resolveTarget(uri);
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

    const ctx = await wizardContext(host, target);
    if (!ctx) { return; }

    const answers = await collectAnswers(host, ctx.cli, ctx.anchor);
    if (!answers) { return; }

    const frontmatter = await renderFrontmatter(host, ctx.cli, answers);
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
export async function newDocument(host: WizardHost): Promise<void> {
    const ctx = await wizardContext(host);
    if (!ctx) { return; }

    const answers = await collectAnswers(host, ctx.cli, ctx.anchor);
    if (!answers) { return; }

    const suggested = suggestFileName(answers.title) ?? 'document.md';
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
        ?? vscode.Uri.file(path.dirname(ctx.anchor.fsPath));
    const destination = await vscode.window.showSaveDialog({
        title: 'Save the new document',
        defaultUri: vscode.Uri.joinPath(defaultDir, suggested),
        filters: { Markdown: ['md', 'markdown'] },
    });
    if (!destination) { return; }

    const frontmatter = await renderFrontmatter(host, ctx.cli, answers);
    if (frontmatter === null) { return; }

    try {
        fs.writeFileSync(destination.fsPath, newDocumentContent(frontmatter, answers.title), 'utf8');
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
