import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
    frontmatterBlock, declaresExportMode, optsOutOfExportOnSave, hasFrontmatter,
    frontmatterTemplate, isOwnCli, usableCandidate, quoteArg, EXIT_MESSAGES,
    themePathArgs, parseThemeList, themeLabel, parseDocumentInfo, shouldPromptForReleaseNote,
    applyWizardFeatures, suggestFileName, validateTitle, WIZARD_FEATURES,
    shouldExportOnSave, exportOnSaveReason,
    buildCliArgs, hasConfiguredMode,
    DEFAULT_INFOGRAPHIC_ICONS, WEAVEFOX_WARNING,
} from '../core';

/**
 * The extension's editor-free logic.
 *
 * The extension shipped ~670 lines with no test of any kind — including two
 * functions whose own comments said they were exported for testing. What is
 * covered here is the part that decides things: whether saving a file triggers
 * an export (which runs on every save of every Markdown file in the workspace),
 * and whether a `dist/index.js` found lying around is safe to hand to Node.
 */

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-ext-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

const doc = (frontmatter: string, body = '\n# Title\n'): string => `---\n${frontmatter}\n---${body}`;

describe('frontmatterBlock', () => {
    it('returns the block between the fences', () => {
        assert.equal(frontmatterBlock(doc('Title: T')), 'Title: T');
    });

    it('reads a file written on Windows — BOM and CRLF', () => {
        assert.equal(frontmatterBlock('﻿---\r\nTitle: T\r\n---\r\n# H'), 'Title: T');
    });

    it('returns null when the document has no frontmatter', () => {
        assert.equal(frontmatterBlock('# Just a heading\n'), null);
    });

    it('returns null for an unterminated block', () => {
        assert.equal(frontmatterBlock('---\nTitle: T\n'), null);
    });

    it('ignores a fence that does not start the document', () => {
        assert.equal(frontmatterBlock('# Heading\n\n---\nTitle: T\n---\n'), null);
    });
});

describe('declaresExportMode', () => {
    it('is true for a top-level Mode key', () => {
        assert.equal(declaresExportMode(doc('Title: T\nMode: pdf')), true);
    });

    it('accepts any casing and spacing', () => {
        assert.equal(declaresExportMode(doc('mode : html')), true);
        assert.equal(declaresExportMode(doc('MODE:\tpdf,html')), true);
    });

    it('is false for an indented Mode — the CLI would not read it either', () => {
        // The whole point of anchoring to the line start: a `Mode:` nested under
        // `Document Info:` is a different key, and exporting on it would run on
        // documents that never asked to be exported.
        assert.equal(declaresExportMode(doc('Document Info:\n    Mode: pdf')), false);
    });

    it('is false for a README with no frontmatter — the common case', () => {
        assert.equal(declaresExportMode('# README\n\nSome notes.\n'), false);
    });

    it('does not see a Mode key in the body', () => {
        assert.equal(declaresExportMode(doc('Title: T', '\nMode: pdf\n')), false);
    });
});

describe('optsOutOfExportOnSave', () => {
    for (const value of ['false', 'no', 'off', '0', 'FALSE', ' No ', '"false"', "'off'"]) {
        it(`opts out on ${JSON.stringify(value)}`, () => {
            assert.equal(optsOutOfExportOnSave(doc(`Mode: pdf\nExport On Save: ${value}`)), true);
        });
    }

    for (const value of ['true', 'yes', 'on', '1']) {
        it(`stays opted in on ${JSON.stringify(value)}`, () => {
            assert.equal(optsOutOfExportOnSave(doc(`Mode: pdf\nExport On Save: ${value}`)), false);
        });
    }

    it('stays opted in when the key is absent', () => {
        assert.equal(optsOutOfExportOnSave(doc('Mode: pdf')), false);
    });

    it('stays opted in when there is no frontmatter at all', () => {
        assert.equal(optsOutOfExportOnSave('# Notes\n'), false);
    });

    it('shares the CLI\'s false vocabulary, so there is one set of spellings to remember', () => {
        // Same words `parseOverride`/`parseBool` accept on the CLI side.
        assert.equal(optsOutOfExportOnSave(doc('Export On Save: nope')), false,
            'an unrecognised word is not an opt-out');
    });
});

describe('hasFrontmatter', () => {
    it('is true for a document that opens with a fence', () => {
        assert.equal(hasFrontmatter('---\nTitle: T\n---\n'), true);
        assert.equal(hasFrontmatter('﻿---\r\nTitle: T\r\n---\r\n'), true);
    });

    it('is false otherwise', () => {
        assert.equal(hasFrontmatter('# Heading\n'), false);
        assert.equal(hasFrontmatter('\n---\nTitle: T\n---\n'), false);
    });
});

describe('frontmatterTemplate', () => {
    it('is a document the extension\'s own reader recognises', () => {
        const t = frontmatterTemplate('2026-01-15');
        assert.equal(hasFrontmatter(t), true);
        assert.equal(declaresExportMode(t), true, 'the template must produce a document that exports');
    });

    it('stamps the date it is given in both places', () => {
        const t = frontmatterTemplate('2026-01-15');
        assert.equal((t.match(/2026-01-15/g) ?? []).length, 2);
    });
});

describe('isOwnCli', () => {
    /** Builds `<name>/dist/index.js` with the given package manifest beside it. */
    const project = (name: string, manifest: string | null): string => {
        const root = path.join(dir, name);
        fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'console.log(1)');
        if (manifest !== null) fs.writeFileSync(path.join(root, 'package.json'), manifest);
        return path.join(root, 'dist', 'index.js');
    };

    it('accepts a real checkout of this tool', () => {
        assert.equal(isOwnCli(project('ours', '{"name":"platen-markdown-export"}')), true);
    });

    it('rejects someone else\'s project that happens to build to dist/index.js', () => {
        // The case that actually happens: almost every TypeScript project does.
        assert.equal(isOwnCli(project('theirs', '{"name":"some-other-tool"}')), false);
    });

    it('rejects a manifest that is not JSON', () => {
        assert.equal(isOwnCli(project('broken', 'not json{')), false);
    });

    it('rejects a dist with no manifest beside it', () => {
        assert.equal(isOwnCli(project('bare', null)), false);
    });

    it('rejects a manifest with no name', () => {
        assert.equal(isOwnCli(project('nameless', '{"version":"1.0.0"}')), false);
    });

    it('rejects a path that does not exist', () => {
        assert.equal(isOwnCli(path.join(dir, 'nothing', 'dist', 'index.js')), false);
    });

    it('accepts the real repository this extension lives in', () => {
        // Not a fixture: the actual layout resolveCli's dev fallback walks —
        // out/tests -> out -> vscode-extension -> the repo root's manifest.
        assert.equal(isOwnCli(path.join(__dirname, '..', '..', '..', 'dist', 'index.js')), true);
    });
});

describe('usableCandidate', () => {
    it('requires the file to exist as well as to identify itself', () => {
        const root = path.join(dir, 'missing-dist');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"platen-markdown-export"}');
        const candidate = path.join(root, 'dist', 'index.js');

        assert.equal(isOwnCli(candidate), true, 'the manifest alone says yes');
        assert.equal(usableCandidate(candidate), false, 'but there is no file to run');
    });
});

describe('quoteArg', () => {
    it('quotes an argument containing a space', () => {
        assert.equal(quoteArg('/tmp/My Docs/report.md'), '"/tmp/My Docs/report.md"');
    });

    it('leaves an ordinary argument bare', () => {
        assert.equal(quoteArg('--quiet'), '--quiet');
    });
});

describe('EXIT_MESSAGES', () => {
    // Read from the CLI's own help text rather than restated here. This was a
    // hardcoded ['1'..'5'] and it went stale the moment the CLI grew exit 6 —
    // the extension would have shown "Exited with code 6" for a documented
    // failure. A list two packages have to agree on by hand is the same shape as
    // the versions `check:versions` guards and the frontmatter template's drift
    // test: keep the copy, but make it fail when it drifts.
    const cliHelp = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'cli.ts'), 'utf8');
    const documented = [...cliHelp.matchAll(/^\s{2}([1-9])\s{2}\S/gm)].map((m) => m[1]).sort();

    it('finds the exit codes in the CLI help, so this test cannot pass vacuously', () => {
        assert.ok(documented.length >= 5, `parsed only ${documented.length} exit codes from cli.ts`);
    });

    it('explains every exit code the CLI documents', () => {
        assert.deepEqual(Object.keys(EXIT_MESSAGES).sort(), documented);
        for (const code of documented) {
            assert.ok(EXIT_MESSAGES[Number(code)].length > 0, `code ${code} needs a message`);
        }
    });
});

describe('buildCliArgs', () => {
    // Ordinary data-shaping that decides what actually runs — the difference
    // between exporting and cutting a release is one element of this array — and
    // none of it was reachable by a test while it read the vscode config itself.
    it('passes only the settings that are set', () => {
        assert.deepEqual(buildCliArgs({}, null, '/docs/a.md', false), ['/docs/a.md']);
    });

    it('maps each setting to its flag', () => {
        const args = buildCliArgs(
            { theme: 'modern', mode: 'pdf', stylesheet: 's.css', dpi: 150,
              openAfterExport: true, noBump: true, quiet: true, strict: true },
            null, '/docs/a.md', false);
        assert.deepEqual(args, [
            '--theme', 'modern', '--mode', 'pdf', '--stylesheet', 's.css', '--dpi', '150',
            '--open', '--no-bump', '--quiet', '--strict', '/docs/a.md',
        ]);
    });

    it('lets a per-command mode override the configured one', () => {
        const args = buildCliArgs({ mode: 'pdf' }, 'html', '/docs/a.md', false);
        assert.ok(args.includes('html'));
        assert.ok(!args.includes('pdf'));
    });

    it('adds --release only when asked', () => {
        assert.ok(!buildCliArgs({}, null, '/a.md', false).includes('--release'));
        assert.ok(buildCliArgs({}, null, '/a.md', true).includes('--release'));
    });

    it('ignores blank and zero settings rather than passing empty flags', () => {
        const args = buildCliArgs({ theme: '   ', mode: '', stylesheet: '', dpi: 0 }, null, '/a.md', false);
        assert.deepEqual(args, ['/a.md']);
    });

    it('passes a non-default infographic icon provider', () => {
        assert.deepEqual(buildCliArgs({ infographicIcons: 'weavefox' }, null, '/a.md', false),
            ['--infographic-icons', 'weavefox', '/a.md']);
        assert.deepEqual(buildCliArgs({ infographicIcons: 'none' }, null, '/a.md', false),
            ['--infographic-icons', 'none', '/a.md']);
    });

    it('passes no icon flag for the default, so an older CLI and EXPORT_INFOGRAPHIC_ICONS both still work', () => {
        assert.deepEqual(buildCliArgs({ infographicIcons: DEFAULT_INFOGRAPHIC_ICONS }, null, '/a.md', false), ['/a.md']);
        assert.deepEqual(buildCliArgs({ infographicIcons: '  ' }, null, '/a.md', false), ['/a.md']);
    });

    it('puts the input last and extraArgs just before it', () => {
        // extraArgs is the user's escape hatch, so it comes after everything the
        // settings produced; the input is positional and must be final.
        const args = buildCliArgs({ theme: 't', extraArgs: ['--dpi', '600'] }, null, '/docs/a.md', false);
        assert.equal(args[args.length - 1], '/docs/a.md');
        assert.deepEqual(args.slice(-3), ['--dpi', '600', '/docs/a.md']);
    });
});

describe('infographic icon provider', () => {
    it('defaults to Iconify, as the CLI does', () => {
        assert.equal(DEFAULT_INFOGRAPHIC_ICONS, 'iconify');
    });

    it('the WeaveFox warning says where the data goes, and what goes there', () => {
        assert.match(WEAVEFOX_WARNING, /www\.weavefox\.cn/);
        assert.match(WEAVEFOX_WARNING, /Ant Group/);
        assert.match(WEAVEFOX_WARNING, /icon names and search terms/);
        assert.match(WEAVEFOX_WARNING, /servers in China/);
    });

    it('the setting is machine-scoped and matches the CLI\'s providers', () => {
        // A repository must not be able to opt this machine into WeaveFox.
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const setting = pkg.contributes.configuration.properties['platenMarkdownExport.infographicIcons'];
        assert.equal(setting.scope, 'machine');
        assert.equal(setting.default, DEFAULT_INFOGRAPHIC_ICONS);
        assert.deepEqual(setting.enum, ['iconify', 'weavefox', 'none']);
        assert.match(setting.markdownDescription, /China/);
    });
});

describe('hasConfiguredMode', () => {
    // Decides whether a document with no `Mode:` still exports on save.
    it('is false with nothing configured', () => {
        assert.equal(hasConfiguredMode({}), false);
        assert.equal(hasConfiguredMode({ mode: '  ' }), false);
    });

    it('is true for a configured mode', () => {
        assert.equal(hasConfiguredMode({ mode: 'pdf' }), true);
    });

    it('is true for a mode forced through extraArgs, in either spelling', () => {
        assert.equal(hasConfiguredMode({ extraArgs: ['--mode', 'html'] }), true);
        assert.equal(hasConfiguredMode({ extraArgs: ['--mode=html'] }), true);
        assert.equal(hasConfiguredMode({ extraArgs: ['--quiet'] }), false);
    });
});


// ── Theme search path ─────────────────────────────────────────────────────────

describe('themePathArgs', () => {
    it('emits one flag per root', () => {
        assert.deepEqual(themePathArgs(['/a', '/b']),
                         ['--theme-path', '/a', '--theme-path', '/b']);
    });

    it('is empty for no roots', () => {
        assert.deepEqual(themePathArgs([]), []);
        assert.deepEqual(themePathArgs(undefined), []);
    });

    it('drops blank entries an array setting collects by hand', () => {
        // `--theme-path ""` is a usage error the user did not commit.
        assert.deepEqual(themePathArgs(['', '   ', '/a']), ['--theme-path', '/a']);
    });

    it('does not join roots into one delimited value', () => {
        // A Windows path carries a drive colon, so joining then re-splitting is a
        // round trip through exactly the ambiguity that would break it.
        const args = themePathArgs(['C:\\themes', 'D:\\more']);
        assert.deepEqual(args, ['--theme-path', 'C:\\themes', '--theme-path', 'D:\\more']);
    });

    it('reaches the export command line ahead of --theme', () => {
        const args = buildCliArgs({ themePaths: ['/roots'], theme: 'acme' }, null, 'doc.md', false);
        assert.ok(args.indexOf('--theme-path') < args.indexOf('--theme'));
        assert.deepEqual(args.slice(0, 4), ['--theme-path', '/roots', '--theme', 'acme']);
    });
});

describe('parseThemeList', () => {
    const entry = { name: 'acme', dir: '/x/acme', source: 'external', root: '/x' };

    it('parses the CLI listing', () => {
        assert.deepEqual(parseThemeList(JSON.stringify([entry])), [entry]);
    });

    it('returns nothing for a non-JSON answer', () => {
        // An older CLI on the PATH predates --json and prints the human listing;
        // that has to degrade to an empty picker, not throw inside a command.
        assert.deepEqual(parseThemeList('Available themes:\n  default'), []);
        assert.deepEqual(parseThemeList(''), []);
    });

    it('returns nothing when the JSON is not an array', () => {
        assert.deepEqual(parseThemeList('{"name":"acme"}'), []);
    });

    it('drops entries missing the fields a picker needs', () => {
        assert.deepEqual(parseThemeList(JSON.stringify([entry, { name: 'x' }, null, 'nope'])), [entry]);
    });

    it('drops an entry whose source is not one of the two known values', () => {
        assert.deepEqual(parseThemeList(JSON.stringify([{ ...entry, source: 'other' }])), []);
    });
});

// ── Release notes ─────────────────────────────────────────────────────────────

describe('shouldPromptForReleaseNote', () => {
    it('prompts when the CLI says the note is missing', () => {
        assert.equal(shouldPromptForReleaseNote({ needsReleaseNote: true }), true);
    });

    it('does not prompt when the revision already carries one', () => {
        // A remark that is already written is not improved by being asked about,
        // and prompting every time turns a two-click release into a dialog you
        // learn to dismiss.
        assert.equal(shouldPromptForReleaseNote({ needsReleaseNote: false }), false);
    });

    it('does not prompt when the document could not be read', () => {
        // --release will report that problem itself, in its own words.
        assert.equal(shouldPromptForReleaseNote(null), false);
    });

    it('falls back to released + empty remarks for an older CLI', () => {
        assert.equal(shouldPromptForReleaseNote({ released: true, lastRemarks: '' }), true);
        assert.equal(shouldPromptForReleaseNote({ released: true, lastRemarks: '   ' }), true);
        assert.equal(shouldPromptForReleaseNote({ released: true, lastRemarks: 'done' }), false);
        assert.equal(shouldPromptForReleaseNote({ released: false, lastRemarks: '' }), false);
    });
});

describe('parseDocumentInfo', () => {
    it('parses an --inspect answer', () => {
        const info = parseDocumentInfo('{"title":"T","released":true,"lastRemarks":null}');
        assert.equal(info?.title, 'T');
        assert.equal(info?.released, true);
    });

    it('returns null rather than a default object when it cannot parse', () => {
        // The caller has to tell "needs a note" apart from "I could not find
        // out", and those lead to different behaviour.
        assert.equal(parseDocumentInfo('not json'), null);
        assert.equal(parseDocumentInfo('[1,2]'), null);
        assert.equal(parseDocumentInfo(''), null);
    });
});

describe('buildCliArgs --release-note', () => {
    it('passes the note with the release', () => {
        const args = buildCliArgs({}, null, 'doc.md', true, 'signed off');
        assert.ok(args.includes('--release'));
        assert.deepEqual(args.slice(args.indexOf('--release-note'), args.indexOf('--release-note') + 2),
                         ['--release-note', 'signed off']);
    });

    it('omits an empty note — that is the same as none', () => {
        // An empty --release-note value is a usage error in the CLI, and an empty
        // box means "release without a note", which is the old behaviour.
        for (const note of ['', '   ', null, undefined]) {
            const args = buildCliArgs({}, null, 'doc.md', true, note);
            assert.ok(!args.includes('--release-note'), `note ${JSON.stringify(note)} should be dropped`);
        }
    });

    it('never passes a note without --release', () => {
        // The CLI rejects the pair; sending it would turn a plain export into a
        // usage error.
        const args = buildCliArgs({}, null, 'doc.md', false, 'signed off');
        assert.ok(!args.includes('--release-note'));
        assert.ok(!args.includes('--release'));
    });

    it('trims the note', () => {
        const args = buildCliArgs({}, null, 'doc.md', true, '  signed off  ');
        assert.equal(args[args.indexOf('--release-note') + 1], 'signed off');
    });
});

// ── Wizard ────────────────────────────────────────────────────────────────────

describe('applyWizardFeatures', () => {
    it('sets only the picked features', () => {
        const out = applyWizardFeatures({ title: 'T' }, ['Numbered headings', 'List of tables']);
        assert.equal(out.numberedHeadings, true);
        assert.equal(out.listOfTables, true);
        assert.equal(out.runningHeader, undefined);
        assert.equal(out.title, 'T', 'existing answers survive');
    });

    it('leaves an unpicked feature undefined, not false', () => {
        // The CLI omits an unanswered key entirely; writing
        // `Numbered Headings: false` is noise the author has to read and decide
        // about.
        const out = applyWizardFeatures({}, []);
        for (const f of WIZARD_FEATURES) { assert.equal(out[f.key], undefined, f.label); }
    });

    it('ignores a label that is not a feature', () => {
        assert.deepEqual(applyWizardFeatures({}, ['Nonsense']), {});
    });

    it('offers only features the frontmatter reference documents', () => {
        // Each label maps to a real answers key; a typo here would silently
        // produce a document control that does nothing.
        const keys = ['numberedHeadings', 'runningHeader', 'listOfTables', 'listOfFigures', 'codeLineNumbers'];
        assert.deepEqual(WIZARD_FEATURES.map(f => f.key).sort(), [...keys].sort());
    });
});

describe('suggestFileName', () => {
    it('turns a title into a filename', () => {
        assert.equal(suggestFileName('Q3 Report'), 'Q3 Report.md');
    });

    it('removes characters a filesystem would refuse', () => {
        assert.equal(suggestFileName('Q3: Report/Draft'), 'Q3 Report Draft.md');
        assert.equal(suggestFileName('a<b>c|d?e*f"g'), 'a b c d e f g.md');
        assert.equal(suggestFileName('back\\slash'), 'back slash.md');
    });

    it('drops a trailing dot or space, which Windows silently strips', () => {
        assert.equal(suggestFileName('Report.'), 'Report.md');
        assert.equal(suggestFileName('Report '), 'Report.md');
    });

    it('collapses the whitespace it introduced', () => {
        assert.equal(suggestFileName('a  :  b'), 'a b.md');
    });

    it('returns null when nothing usable is left', () => {
        assert.equal(suggestFileName(''), null);
        assert.equal(suggestFileName('///'), null);
        assert.equal(suggestFileName(undefined), null);
    });
});

describe('validateTitle', () => {
    it('accepts an ordinary title', () => {
        assert.equal(validateTitle('Q3 Report'), null);
    });

    it('accepts punctuation the YAML writer will quote for us', () => {
        // A colon or an apostrophe is ordinary in a title; `yamlScalar` in the
        // CLI quotes whatever needs quoting, so rejecting them here would be
        // inventing a restriction the format does not have.
        assert.equal(validateTitle('Q3 Report: Draft'), null);
        assert.equal(validateTitle("O'Brien's report"), null);
    });

    it('rejects an empty title', () => {
        assert.ok(validateTitle('')); 
        assert.ok(validateTitle('   '));
    });

    it('rejects an absurdly long one', () => {
        assert.ok(validateTitle('x'.repeat(201)));
    });
});


describe('themeLabel', () => {
    const entry = (name: string, displayName?: string) =>
        ({ name, displayName, dir: `/x/${name}`, source: 'external' as const, root: '/x' });

    it('shows the folder name alone when the theme agrees with it', () => {
        assert.equal(themeLabel(entry('default', 'default')), 'default');
    });

    it('shows what the theme calls itself when that differs', () => {
        // Every shipped theme disagrees with its folder, so a picker listing
        // only folder names leaves you guessing which is the brand you know.
        assert.equal(themeLabel(entry('markedapp-byword', 'Byword')), 'markedapp-byword (Byword)');
        assert.equal(themeLabel(entry('acme-theme', 'Acme')), 'acme-theme (Acme)');
    });

    it('treats a case-only difference as agreement', () => {
        assert.equal(themeLabel(entry('default', 'Default')), 'default');
    });

    it('falls back to the folder name for an older CLI that reports no alias', () => {
        assert.equal(themeLabel(entry('acme')), 'acme');
    });
});

describe('parseThemeList with aliases', () => {
    it('keeps displayName when the CLI reports it', () => {
        const raw = JSON.stringify([
            { name: 'acme-theme', displayName: 'Acme', dir: '/x/acme-theme', source: 'external', root: '/x' },
        ]);
        assert.equal(parseThemeList(raw)[0].displayName, 'Acme');
    });

    it('still accepts an entry without one', () => {
        // displayName is additive; an older CLI on the PATH omits it entirely.
        const raw = JSON.stringify([{ name: 'acme', dir: '/x/acme', source: 'external', root: '/x' }]);
        assert.equal(parseThemeList(raw).length, 1);
        assert.equal(parseThemeList(raw)[0].displayName, undefined);
    });
});


// ── Export on save ────────────────────────────────────────────────────────────

/**
 * Reported as "the export does not trigger on save". It did — the outputs were
 * timestamped to the same second as the save. What had happened was that a
 * release renamed them from `_Rev4` to `_Rev5`, so the file being watched
 * stopped changing, and a silent feature gives you nothing to check against.
 *
 * These pin the rule itself, now that the status bar reads the same predicate
 * the handler does and the two can no longer disagree about what a save will do.
 */
describe('shouldExportOnSave', () => {
    const doc = (extra = '') => `---\nTitle: T\nMode: html\n${extra}---\n\n# T\n`;

    it('exports a document that declares a Mode', () => {
        assert.equal(shouldExportOnSave(doc(), {}, true), true);
    });

    it('does not export when the setting is off', () => {
        assert.equal(shouldExportOnSave(doc(), {}, false), false);
    });

    it('does not export a document with no Mode', () => {
        // Otherwise saving any .md — a README, a changelog — spawns a process
        // that reads the file and exits with nothing to do.
        assert.equal(shouldExportOnSave('# Just notes\n', {}, true), false);
    });

    it('exports a document with no Mode when settings force one', () => {
        assert.equal(shouldExportOnSave('# Just notes\n', { mode: 'html' }, true), true);
    });

    it('honours a per-document opt-out', () => {
        assert.equal(shouldExportOnSave(doc('Export On Save: false\n'), {}, true), false);
    });

    it('lets the opt-out beat a configured mode', () => {
        // The document is the more specific statement, and the one a colleague
        // reading the file can see.
        assert.equal(shouldExportOnSave(doc('Export On Save: false\n'), { mode: 'html' }, true), false);
    });
});

describe('exportOnSaveReason', () => {
    const doc = (extra = '') => `---\nTitle: T\nMode: html\n${extra}---\n\n# T\n`;

    it('is null when a save will export', () => {
        assert.equal(exportOnSaveReason(doc(), {}, true), null);
    });

    it('names the setting when it is off', () => {
        // "Off" and "this document has no Mode" send you to different places.
        assert.match(exportOnSaveReason(doc(), {}, false) ?? '', /exportOnSave/);
    });

    it('names the missing Mode key', () => {
        assert.match(exportOnSaveReason('# Notes\n', {}, true) ?? '', /Mode:/);
    });

    it('names the per-document opt-out', () => {
        assert.match(exportOnSaveReason(doc('Export On Save: false\n'), {}, true) ?? '',
                     /Export On Save/);
    });

    it('agrees with shouldExportOnSave in every case', () => {
        // The indicator and the behaviour are the same question asked twice;
        // this is what stops them drifting apart again.
        for (const text of [doc(), doc('Export On Save: false\n'), '# Notes\n']) {
            for (const settings of [{}, { mode: 'html' }]) {
                for (const enabled of [true, false]) {
                    assert.equal(exportOnSaveReason(text, settings, enabled) === null,
                                 shouldExportOnSave(text, settings, enabled),
                                 `disagreed for ${JSON.stringify({ text, settings, enabled })}`);
                }
            }
        }
    });
});
