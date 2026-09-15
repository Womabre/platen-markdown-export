import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The extension, running inside a real VS Code extension host.
 *
 * `core.test.ts` covers everything that can be decided without an editor, which
 * is most of it — but not the half that only exists once VS Code is running: are
 * the commands actually registered under the ids `package.json` promises, do the
 * settings resolve with the defaults declared, and does a command that asks the
 * user three questions and spawns the CLI produce the file it should.
 *
 * That gap used to be closed by a human pressing F5 and clicking, which is both
 * the slowest test in the project and the one most likely to be skipped. Here the
 * prompts are stubbed — the host and the test share one `vscode` module instance,
 * so replacing `window.showInputBox` replaces the one the extension calls — and
 * the assertions are about what reached disk.
 *
 * No mocha: a runner is a `run()` that resolves or rejects, and thirty lines of
 * `describe`/`it` below is less to carry than a framework and its reporter.
 */

type Case = { name: string; fn: () => Promise<void> | void };
const cases: Case[] = [];
let currentSuite = '';

function describe(name: string, body: () => void): void {
    const outer = currentSuite;
    currentSuite = outer ? `${outer} › ${name}` : name;
    body();
    currentSuite = outer;
}

function it(name: string, fn: () => Promise<void> | void): void {
    cases.push({ name: `${currentSuite} › ${name}`, fn });
}

/**
 * This extension, found by the `name` in its own manifest.
 *
 * Not a hardcoded `publisher.name` id: that string is assembled by VS Code from
 * two manifest fields, and pinning it here means a publisher change fails as
 * "extension not found" — which reads like the extension is broken rather than
 * like the test is out of date. Searching by `name` cannot drift.
 */
const PACKAGE_NAME = 'platen-markdown-export-vscode';

function thisExtension(): vscode.Extension<unknown> {
    const found = vscode.extensions.all.find(
        e => (e.packageJSON as { name?: string }).name === PACKAGE_NAME);
    assert.ok(found, `no loaded extension named "${PACKAGE_NAME}"`);
    return found;
}

/** Where each test writes; emptied between cases so one cannot see another's files. */
let workDir: string;

/**
 * Restores every `vscode.window` prompt this suite replaces.
 *
 * Stubs are installed per test and undone here whatever happens, so a failing
 * assertion cannot leave a later test answering a question with the previous
 * one's answer — which is the failure mode that makes stubbed UI tests lie.
 */
const restores: Array<() => void> = [];
function stub<K extends keyof typeof vscode.window>(key: K, value: (typeof vscode.window)[K]): void {
    const original = vscode.window[key];
    (vscode.window as Record<string, unknown>)[key as string] = value;
    restores.push(() => { (vscode.window as Record<string, unknown>)[key as string] = original; });
}

/** Picks the QuickPick item whose label matches, so a stub reads like the click it replaces. */
function pickLabelled(label: string) {
    return async (items: unknown): Promise<unknown> => {
        const list = (await items) as Array<string | vscode.QuickPickItem>;
        const found = list.find(i => (typeof i === 'string' ? i : i.label) === label);
        assert.ok(found, `no QuickPick item labelled "${label}" — offered: ${
            list.map(i => (typeof i === 'string' ? i : i.label)).join(', ')}`);
        return found;
    };
}


/**
 * Every command a right-click on `menu` can reach, following submenus.
 *
 * A submenu is a legitimate way to offer a command — one labelled entry beats
 * five appended to the bottom of a crowded menu — so the assertion that matters
 * is whether the command is reachable, not which level it is declared on.
 */
function commandsReachableFrom(menu: string, seen = new Set<string>()): Set<string> {
    const menus = thisExtension().packageJSON.contributes.menus as
        Record<string, Array<{ command?: string; submenu?: string }>>;
    const found = new Set<string>();
    if (seen.has(menu)) { return found; }
    seen.add(menu);

    for (const entry of menus[menu] ?? []) {
        if (entry.command) { found.add(entry.command); }
        if (entry.submenu) {
            for (const c of commandsReachableFrom(entry.submenu, seen)) { found.add(c); }
        }
    }
    return found;
}

// ── Cases ─────────────────────────────────────────────────────────────────────

describe('activation', () => {
    it('activates without throwing', async () => {
        const ext = thisExtension();
        await ext.activate();
        assert.equal(ext.isActive, true);
    });

    it('declares the identity the marketplace will publish it under', async () => {
        const pkg = thisExtension().packageJSON as { publisher?: string; name?: string };
        assert.ok(pkg.publisher, 'a missing publisher makes the id "undefined_publisher.<name>"');
        assert.equal(thisExtension().id, `${pkg.publisher}.${pkg.name}`);
    });

    it('registers every command package.json declares', async () => {
        // The ids are the contract between the manifest and `activate()`. A typo
        // in either is invisible until someone runs the command and VS Code says
        // "command not found".
        const ext = thisExtension();
        const declared = (ext.packageJSON.contributes.commands as Array<{ command: string }>)
            .map(c => c.command);
        const registered = await vscode.commands.getCommands(true);
        for (const id of declared) {
            assert.ok(registered.includes(id), `command not registered: ${id}`);
        }
        assert.ok(declared.includes('platenMarkdownExport.newDocument'));
        assert.ok(declared.includes('platenMarkdownExport.selectTheme'));
        assert.ok(declared.includes('platenMarkdownExport.addThemeFolder'));
    });

    it('exposes the new settings with their declared defaults', async () => {
        const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
        assert.deepEqual(cfg.get('themePaths'), []);
        assert.equal(cfg.get('defaultAuthor'), '');
    });

    it('puts every document command within reach of BOTH context menus', async () => {
        // Registration is not discoverability. `newDocument` was registered,
        // worked, and had passing tests — while being reachable only from the
        // explorer context menu and the palette, so someone right-clicking
        // inside a Markdown file could not find the wizard at all.
        //
        // Reachability rather than literal placement, because a submenu is a
        // legitimate way to offer a command: what matters is that a right-click
        // can get you there, not which level it sits on.
        const onDocuments = [
            'platenMarkdownExport.frontmatterWizard',
            'platenMarkdownExport.insertFrontmatter',
            'platenMarkdownExport.release',
            'platenMarkdownExport.newDocument',
            'platenMarkdownExport.export',
        ];
        for (const menu of ['editor/context', 'explorer/context']) {
            const reachable = commandsReachableFrom(menu);
            for (const command of onDocuments) {
                assert.ok(reachable.has(command), `${command} not reachable from ${menu}`);
            }
        }
    });

    it('does not bury either context menu in a custom group', async () => {
        // VS Code renders a menu's predefined groups first and appends every
        // custom one after them. Our entries sat in a custom group in both
        // menus, so they landed below Command Palette in the editor and below
        // Delete in the explorer — present, and easy to miss entirely, which is
        // exactly how this was reported twice.
        const KNOWN: Record<string, string[]> = {
            'editor/context':   ['navigation', '1_modification', '9_cutcopypaste', 'z_commands'],
            'explorer/context': ['navigation', '2_workspace', '3_compare', '4_search',
                                 '5_cutcopypaste', '6_copypath', '7_modification', 'z_commands'],
        };
        const menus = thisExtension().packageJSON.contributes.menus as
            Record<string, Array<{ group?: string }>>;
        for (const [menu, known] of Object.entries(KNOWN)) {
            for (const entry of menus[menu]) {
                const group = (entry.group ?? '').split('@')[0];
                assert.ok(known.includes(group),
                          `${menu} group "${group}" is custom, so VS Code appends it after every ` +
                          `predefined group; use one of ${known.join(', ')}`);
            }
        }
    });

    it('offers a folder only what applies to one', async () => {
        // The submenu is shared, and a folder is not a document: exporting or
        // releasing it means nothing. Everything except the new-document wizard
        // is hidden there — and hidden by `!explorerResourceIsFolder`, which is
        // unset in the editor, so all of it still shows when right-clicking
        // inside a document.
        const menus = thisExtension().packageJSON.contributes.menus as
            Record<string, Array<{ command?: string; when?: string }>>;
        const sub = menus['platenMarkdownExport.contextMenu'];
        assert.ok(sub?.length, 'the shared submenu should have entries');

        for (const entry of sub) {
            if (entry.command === 'platenMarkdownExport.newDocument') {
                assert.equal(entry.when, undefined, 'the wizard applies to a folder too');
            } else {
                assert.equal(entry.when, '!explorerResourceIsFolder',
                             `${entry.command} should be hidden on a folder`);
            }
        }
    });

    it('declares every submenu it references', async () => {
        // A menu entry pointing at an id with no `submenus` declaration is
        // dropped silently — the contribution simply does not render, with
        // nothing in the UI to say why.
        const contributes = thisExtension().packageJSON.contributes as {
            menus: Record<string, Array<{ submenu?: string }>>;
            submenus?: Array<{ id: string; label: string }>;
        };
        const declared = new Set((contributes.submenus ?? []).map(s => s.id));
        for (const [menu, entries] of Object.entries(contributes.menus)) {
            for (const entry of entries) {
                if (entry.submenu) {
                    assert.ok(declared.has(entry.submenu),
                              `${menu} references undeclared submenu "${entry.submenu}"`);
                }
            }
        }
        for (const sub of contributes.submenus ?? []) {
            assert.ok(sub.label, `submenu ${sub.id} needs a label to render`);
            assert.ok(contributes.menus[sub.id]?.length, `submenu ${sub.id} is empty`);
        }
    });

    it('hides nothing from the command palette by accident', async () => {
        // A command is palette-visible by default; a `commandPalette` entry can
        // only ever restrict it. `when: "true"` was a literal that bought
        // nothing and could only have hidden things if it evaluated false.
        const menus = thisExtension().packageJSON.contributes.menus as
            Record<string, Array<{ command: string; when?: string }>>;
        for (const entry of menus.commandPalette) {
            assert.notEqual(entry.when, 'true',
                            `${entry.command}: drop the entry rather than gating it on a literal`);
        }
    });

    it('names the frontmatter commands so they can be found by searching', async () => {
        // Someone looking for "the frontmatter wizard" types "frontmatter".
        // "New Document (wizard)…" did not contain the word.
        const commands = thisExtension().packageJSON.contributes.commands as
            Array<{ command: string; title: string }>;
        const titled = (id: string) => commands.find(c => c.command === id)?.title ?? '';
        for (const id of ['platenMarkdownExport.frontmatterWizard',
                          'platenMarkdownExport.insertFrontmatter',
                          'platenMarkdownExport.newDocument']) {
            assert.match(titled(id), /frontmatter/i, `${id} should be findable by "frontmatter"`);
        }
    });
});

describe('new-document wizard', () => {
    it('writes a document from the answers it was given', async () => {
        const target = path.join(workDir, 'wizard-out.md');

        stub('showInputBox', (async (opts?: vscode.InputBoxOptions) =>
            /title/i.test(opts?.title ?? '') ? 'Integration Doc: Draft' : 'Wouter, W.') as never);
        stub('showQuickPick', (async (items: unknown, opts?: vscode.QuickPickOptions) => {
            if (/theme/i.test(opts?.title ?? '')) { return pickLabelled('default')(items); }
            if (/style/i.test(opts?.title ?? '')) { return pickLabelled('Navy')(items); }
            if (/mode/i.test(opts?.title ?? '')) { return pickLabelled('html')(items); }
            // The optional controls: canPickMany, so an array comes back.
            return [{ label: 'Numbered headings' }];
        }) as never);
        stub('showSaveDialog', (async () => vscode.Uri.file(target)) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.newDocument');

        assert.ok(fs.existsSync(target), 'the wizard wrote no file');
        const text = fs.readFileSync(target, 'utf8');

        // Quoted because of the colon — the reason answers go through the CLI's
        // yamlScalar rather than being assembled in the editor.
        assert.ok(text.includes('Title: "Integration Doc: Draft"'), text.slice(0, 300));
        // Quoted because a comma ends a scalar inside the inline revisions row.
        assert.ok(text.includes('Author: "Wouter, W."') || text.includes('Author: Wouter, W.'), text.slice(0, 300));
        // The name the theme DECLARES, not the folder it sits in. The bundled
        // `default` folder declares `Default`; an external `acme-theme` folder
        // declares `Acme`. Writing the folder name put a machine-specific path
        // artefact into documents, which resolved here — the extension passes
        // --theme-path — and nowhere else.
        assert.ok(text.includes('Theme: Default'),
                  `expected the declared theme name:\n${text.slice(0, 300)}`);
        assert.ok(!/^Theme: default$/m.test(text), 'the folder name must not be written');
        assert.ok(text.includes('Style: Navy'), 'the picked style');
        assert.ok(text.includes('Mode: html'), 'the picked mode');
        assert.ok(text.includes('Numbered Headings: true'), 'the picked optional control');
        // An unpicked control must be absent, not written as false.
        assert.ok(!text.includes('List of Tables'), 'unpicked controls must not be written');
        assert.ok(text.trimEnd().endsWith('# Integration Doc: Draft'), 'a heading follows the frontmatter');
    });

    it('writes nothing when the first question is cancelled', async () => {
        const before = fs.readdirSync(workDir);
        stub('showInputBox', (async () => undefined) as never);
        stub('showSaveDialog', (async () => {
            throw new Error('the save dialog must not be reached after a cancel');
        }) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.newDocument');
        assert.deepEqual(fs.readdirSync(workDir), before, 'a cancelled wizard must leave nothing behind');
    });

    it('writes nothing when the save dialog is dismissed', async () => {
        const before = fs.readdirSync(workDir);
        stub('showInputBox', (async () => 'Doc') as never);
        stub('showQuickPick', (async (items: unknown, opts?: vscode.QuickPickOptions) => {
            if (/theme/i.test(opts?.title ?? '')) { return pickLabelled('default')(items); }
            if (/style/i.test(opts?.title ?? '')) { return pickLabelled('Navy')(items); }
            if (/mode/i.test(opts?.title ?? '')) { return pickLabelled('html')(items); }
            return [];
        }) as never);
        stub('showSaveDialog', (async () => undefined) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.newDocument');
        assert.deepEqual(fs.readdirSync(workDir), before);
    });
});

describe('frontmatter wizard', () => {
    it('fills in a document that has none', async () => {
        const file = path.join(workDir, 'needs-frontmatter.md');
        fs.writeFileSync(file, '# Already Started\n\nSome prose I wrote earlier.\n');

        stub('showInputBox', (async (opts?: vscode.InputBoxOptions) =>
            /title/i.test(opts?.title ?? '') ? 'Filled In' : 'Wouter') as never);
        stub('showQuickPick', (async (items: unknown, opts?: vscode.QuickPickOptions) => {
            if (/theme/i.test(opts?.title ?? '')) { return pickLabelled('default')(items); }
            if (/style/i.test(opts?.title ?? '')) { return pickLabelled('Navy')(items); }
            if (/mode/i.test(opts?.title ?? '')) { return pickLabelled('pdf')(items); }
            return [];
        }) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.frontmatterWizard',
                                             vscode.Uri.file(file));

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const text = doc.getText();
        assert.ok(text.startsWith('---'), `frontmatter was not inserted:\n${text.slice(0, 200)}`);
        assert.ok(text.includes('Title: Filled In'), text.slice(0, 300));
        assert.ok(text.includes('Mode: pdf'), text.slice(0, 300));
        // The prose that was already there must survive, below the block.
        assert.ok(text.includes('Some prose I wrote earlier.'), 'existing content must be kept');
    });

    it('refuses a document that already has frontmatter', async () => {
        // Rewriting a block someone has edited is not a wizard's decision.
        const file = path.join(workDir, 'already-has.md');
        const before = '---\nTitle: Mine\n---\n\n# Mine\n';
        fs.writeFileSync(file, before);

        stub('showInputBox', (async () => {
            throw new Error('must not ask anything about a document that already has frontmatter');
        }) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.frontmatterWizard',
                                             vscode.Uri.file(file));
        assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
});

describe('export on save', () => {
    it('exports a document that declares a Mode when it is saved', async () => {
        const file = path.join(workDir, 'on-save.md');
        fs.writeFileSync(file, [
            '---', 'Title: On Save', 'Theme: default', 'Style: Navy', 'Mode: html', '---',
            '', '# On Save', '', 'Body.', '',
        ].join('\n'));

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(e => e.insert(new vscode.Position(doc.lineCount - 1, 0), 'Edited.\n'));
        assert.ok(await doc.save(), 'the document should have saved');

        const out = path.join(workDir, 'on-save.html');
        await settle(() => fs.existsSync(out));
        assert.ok(fs.existsSync(out),
                  `no export appeared for a saved document that declares Mode:\n` +
                  `  expected ${out}\n  present: ${fs.readdirSync(workDir).join(', ')}`);
    });

    it('does not export a document that declares no Mode', async () => {
        // Saving any .md in a workspace — a README, a scratch note — must not
        // spawn a Node process that reads the file and exits with nothing to do.
        const file = path.join(workDir, 'no-mode.md');
        fs.writeFileSync(file, '# Just Notes\n\nNothing to export here.\n');

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(e => e.insert(new vscode.Position(0, 0), '<!-- edit -->\n'));
        await doc.save();

        await pause(2500);
        assert.ok(!fs.existsSync(path.join(workDir, 'no-mode.html')),
                  'a document with no Mode must not export on save');
    });

    it('honours a document opting out with Export On Save: false', async () => {
        const file = path.join(workDir, 'opted-out.md');
        fs.writeFileSync(file, [
            '---', 'Title: Opted Out', 'Theme: default', 'Mode: html',
            'Export On Save: false', '---', '', '# Opted Out', '',
        ].join('\n'));

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(e => e.insert(new vscode.Position(doc.lineCount - 1, 0), 'Edited.\n'));
        await doc.save();

        await pause(2500);
        assert.ok(!fs.existsSync(path.join(workDir, 'opted-out.html')),
                  'Export On Save: false must be honoured');
    });
});

describe('release', () => {
    /** A released document whose outgoing revision carries `remarks`. */
    const releasedDoc = (remarks: string): string => [
        '---',
        'Title: Release Integration',
        'Theme: default',
        'Style: Navy',
        'Mode: html',
        'Document Info:',
        '    Author: Wouter',
        '    Revision: 5',
        '    Status: Released',
        'Revisions:',
        `    - {Revision: 5, Date: "2026-02-01", Author: Wouter, Remarks: ${remarks}}`,
        '---',
        '',
        '# Release Integration',
        '',
    ].join('\n');

    it('prompts when the outgoing revision has no note, and records it there', async () => {
        const file = path.join(workDir, 'release-empty.md');
        fs.writeFileSync(file, releasedDoc(''));

        let prompted = false;
        stub('showInputBox', (async (opts?: vscode.InputBoxOptions) => {
            prompted = true;
            assert.ok(/release note/i.test(opts?.title ?? ''), `unexpected prompt: ${opts?.title}`);
            return 'Approved at the Q3 review';
        }) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.release', vscode.Uri.file(file));
        await settle(() => /Remarks: Approved/.test(fs.readFileSync(file, 'utf8')));

        assert.ok(prompted, 'an empty note must be asked about');
        const text = fs.readFileSync(file, 'utf8');
        // The note lands on the OUTGOING revision (5) — the row the cover's
        // revision table shows — and 6 is appended empty.
        assert.match(text, /Revision: 5,[^}]*Remarks: Approved at the Q3 review/);
        assert.match(text, /Revision: 6,[^}]*Remarks: \s*\}/);
        assert.match(text, /Status: Work In Progress/);
    });

    it('does not prompt when the revision already says something', async () => {
        const file = path.join(workDir, 'release-noted.md');
        fs.writeFileSync(file, releasedDoc('already written'));

        stub('showInputBox', (async () => {
            throw new Error('must not prompt when a note is already there');
        }) as never);

        await vscode.commands.executeCommand('platenMarkdownExport.release', vscode.Uri.file(file));
        await settle(() => /Revision: 6/.test(fs.readFileSync(file, 'utf8')));
        assert.match(fs.readFileSync(file, 'utf8'), /Revision: 5,[^}]*Remarks: already written/);
    });

    it('abandons the release when the prompt is dismissed', async () => {
        const file = path.join(workDir, 'release-cancelled.md');
        const before = releasedDoc('');
        fs.writeFileSync(file, before);

        stub('showInputBox', (async () => undefined) as never);
        await vscode.commands.executeCommand('platenMarkdownExport.release', vscode.Uri.file(file));

        // Escape means "not now" — the document must be untouched, and in
        // particular must not have been released without its note.
        await pause(1500);
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'a dismissed prompt must not release');
    });
});

// ── Runner ────────────────────────────────────────────────────────────────────

const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Waits for a condition the export completes asynchronously.
 *
 * `executeCommand` resolves when the command's own promise does, and the export
 * it starts is a spawned CLI writing the file afterwards. Polling for the result
 * rather than sleeping a fixed time keeps the suite fast when it passes and
 * still gives a slow machine room.
 */
async function settle(done: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (done()) { return; } } catch { /* file not written yet */ }
        await pause(100);
    }
}

describe('built-in Markdown preview theming', () => {
    /**
     * Renders through the built-in preview's own markdown-it engine — the
     * `markdown.api.render` command is that engine, plugins included — so this is
     * the path a preview takes, not a re-creation of it.
     */
    const render = async (markdown: string): Promise<string> =>
        String(await vscode.commands.executeCommand('markdown.api.render', markdown));

    const exportDoc = '---\nTheme: modern\nStyle: Cherry\nMode: pdf\n---\n\n# Hello\n\n| A | B |\n| - | - |\n| 1 | 2 |\n';

    /** The kit is built in the background on activation; wait for the first themed render. */
    async function themedRender(markdown: string): Promise<string> {
        const deadline = Date.now() + 60_000;
        for (;;) {
            const html = await render(markdown);
            if (html.includes('id="pme-preview"') || Date.now() > deadline) return html;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    it('wraps an export document in its theme markup, with that style\'s CSS after it', async () => {
        await thisExtension().activate();
        const html = await themedRender(exportDoc);
        // Other preview plugins may add markup of their own around the document
        // (a Mermaid extension emits a config span first), so: opened before the
        // content, closed after it.
        const open = html.indexOf('<div id="pme-preview"><div class="pme-body"><div class="pme-content">');
        const heading = html.search(/<h1[^>]*>Hello<\/h1>/);
        assert.ok(open >= 0 && heading > open, `not wrapped: ${html.slice(0, 300)}`);
        assert.match(html, /<\/div><\/div><\/div><style>[\s\S]*--brand-main:[\s\S]*<\/style>$/);
        // A wide table scrolls in its own box instead of widening the preview pane.
        assert.match(html, /<div class="pme-scroll"><table[^>]*>/);
        // VS Code marks every block element .code-line; an unscoped rule for it broke every table.
        assert.ok(!/^\.code-line\b/m.test(html), 'kit CSS must not carry an unscoped .code-line rule');
        assert.ok(!/body\.html-export/.test(html), 'preview CSS must not keep export-only selectors');
    });

    it('leaves a Markdown file that is not an export document alone', async () => {
        await themedRender(exportDoc);
        const html = await render('# README\n\nJust notes.\n');
        assert.ok(!html.includes('pme-preview'), html.slice(0, 200));
        assert.ok(!html.includes('<style>'));
    });

    it('stops theming as soon as platenMarkdownExport.preview.enabled is off', async () => {
        await themedRender(exportDoc);
        const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
        await cfg.update('preview.enabled', false, vscode.ConfigurationTarget.Global);
        try {
            assert.ok(!(await render(exportDoc)).includes('pme-preview'));
        } finally {
            await cfg.update('preview.enabled', undefined, vscode.ConfigurationTarget.Global);
        }
        assert.ok((await themedRender(exportDoc)).includes('pme-preview'), 'turning it back on re-themes');
    });
});

describe('runtime dependencies', () => {
    /** Records every notification, answering a question with `answer`. */
    const recordMessages = (answer?: string): { info: string[]; errors: string[] } => {
        const seen = { info: [] as string[], errors: [] as string[] };
        stub('showInformationMessage', (async (message: string) => { seen.info.push(message); return answer; }) as never);
        stub('showErrorMessage', (async (message: string) => { seen.errors.push(message); return undefined; }) as never);
        return seen;
    };

    /**
     * A stand-in CLI that logs every call. It reports Chromium and draw.io
     * missing until `--setup` has run; `knowsCheck: false` is an older CLI that
     * refuses `--check-setup` the way a real one refuses any unknown flag.
     */
    const fakeCli = (name: string, knowsCheck = true): { cliPath: string; setupCalls: () => string[] } => {
        const dir = path.join(workDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const cliPath = path.join(dir, 'fake-cli.js');
        fs.writeFileSync(cliPath, [
            "const fs = require('fs'), path = require('path');",
            'const args = process.argv.slice(2);',
            "fs.appendFileSync(path.join(__dirname, 'calls.log'), args.join(' ') + '\\n');",
            "const installed = fs.existsSync(path.join(__dirname, 'installed'));",
            "if (args.includes('--check-setup')) {",
            `    if (!${knowsCheck}) { console.error('Error: unknown option "--check-setup"'); process.exit(2); }`,
            "    console.log('\\n  ' + JSON.stringify({ components: [",
            "        { id: 'weasyprint', name: 'WeasyPrint', installed: true },",
            "        { id: 'chromium', name: 'Chromium', installed },",
            "        { id: 'drawio', name: 'draw.io', installed },",
            '    ] }, null, 2));',
            '    process.exit(0);',
            '}',
            "if (args.includes('--setup')) { fs.writeFileSync(path.join(__dirname, 'installed'), ''); process.exit(0); }",
            'process.exit(2);',
        ].join('\n'));
        const log = path.join(dir, 'calls.log');
        // Only the dependency calls: a cliPath change also rebuilds the preview kit through it.
        const setupCalls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
            .filter(call => /setup/.test(call));
        return { cliPath, setupCalls };
    };

    const withSettings = async (settings: Record<string, unknown>, body: () => Promise<void>): Promise<void> => {
        const cfg = vscode.workspace.getConfiguration('platenMarkdownExport');
        for (const [key, value] of Object.entries(settings)) {
            await cfg.update(key, value, vscode.ConfigurationTarget.Global);
        }
        try {
            await body();
        } finally {
            for (const key of Object.keys(settings)) {
                await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
        }
    };

    const exportsOf = (base: string): string[] =>
        fs.readdirSync(workDir).filter(f => f.startsWith(base) && f.endsWith('.html'));

    it('installs everything missing from the one command, and reports once', async () => {
        const cli = fakeCli('deps-install');
        const seen = recordMessages();
        await withSettings({ cliPath: cli.cliPath }, async () => {
            await vscode.commands.executeCommand('platenMarkdownExport.setup');
        });

        assert.deepEqual(cli.setupCalls(), ['--check-setup --json', '--setup', '--check-setup --json']);
        assert.deepEqual(seen.info, ['Platen Markdown Export: installed Chromium and draw.io.']);
        assert.deepEqual(seen.errors, []);
    });

    it('still runs --setup for a CLI too old to say what is missing', async () => {
        const cli = fakeCli('deps-old-cli', false);
        const seen = recordMessages();
        await withSettings({ cliPath: cli.cliPath }, async () => {
            await vscode.commands.executeCommand('platenMarkdownExport.setup');
        });

        assert.deepEqual(cli.setupCalls(), ['--check-setup --json', '--setup']);
        assert.deepEqual(seen.info, ['Platen Markdown Export: setup finished.']);
        assert.deepEqual(seen.errors, []);
    });

    // The next two share the session: the first shows the question, and the
    // second proves it is not shown again.
    it('asks ONE question naming everything missing when Node.js is missing, and says nothing more on "Not now"', async () => {
        const file = path.join(workDir, 'deps-ask.md');
        fs.writeFileSync(file, '---\nTitle: Deps\nMode: html\n---\n\n# Deps\n');
        const seen = recordMessages('Not now');
        await withSettings({ nodePath: path.join(workDir, 'no-such-node') }, async () => {
            await vscode.commands.executeCommand('platenMarkdownExport.exportHtml', vscode.Uri.file(file));
        });

        assert.equal(seen.info.length, 1, `expected exactly one question, got ${JSON.stringify(seen.info)}`);
        assert.match(seen.info[0], /^Platen Markdown Export needs Node\.js(, | and )/);
        assert.match(seen.info[0], /Chromium/);
        assert.match(seen.info[0], /Install them now\?$/);
        assert.deepEqual(seen.errors, [], 'declining the question must not be followed by another message');
        assert.deepEqual(exportsOf('deps-ask'), [], 'nothing can be exported without Node.js');
    });

    it('does not ask twice in a session; a manual export then says why, once', async () => {
        const file = path.join(workDir, 'deps-again.md');
        fs.writeFileSync(file, '---\nTitle: Deps\nMode: html\n---\n\n# Deps\n');
        const seen = recordMessages('Install'); // would install if it asked — it must not ask
        await withSettings({ nodePath: path.join(workDir, 'no-such-node') }, async () => {
            await vscode.commands.executeCommand('platenMarkdownExport.exportHtml', vscode.Uri.file(file));
        });

        assert.deepEqual(seen.info, []);
        assert.deepEqual(seen.errors, ['Platen Markdown Export needs Node.js to run.']);
    });
});

export async function run(): Promise<void> {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-integration-'));

    // The wizard and the release both resolve the CLI relative to the workspace,
    // and the workspace opened for these tests is the repository itself — so they
    // exercise the freshly built `dist/index.js`, not whatever is on PATH.
    const failures: string[] = [];
    for (const c of cases) {
        try {
            await c.fn();
            console.log(`  ok  ${c.name}`);
        } catch (err: unknown) {
            failures.push(`${c.name}\n      ${err instanceof Error ? err.message : String(err)}`);
            console.log(`  FAIL ${c.name}`);
        } finally {
            while (restores.length) { restores.pop()?.(); }
        }
    }

    fs.rmSync(workDir, { recursive: true, force: true });

    console.log(`\n  ${cases.length - failures.length}/${cases.length} passed`);
    if (failures.length) {
        throw new Error(`${failures.length} integration test(s) failed:\n    ${failures.join('\n    ')}`);
    }
}
