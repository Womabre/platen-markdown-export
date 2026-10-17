import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import frontMatter from 'front-matter';
import {
    TEMPLATES_DIR, listTemplateEntries, resolveTemplate, renderTemplate, splitBlocks, templateRootsFromEnv,
} from '../templates';
import { unknownKeyWarnings } from '../frontmatter-keys';
import { loadTheme } from '../theme';
import { parseArgs } from '../cli';
import { main } from '../index';
import { ExitError } from '../errors';
import { setQuiet } from '../logger';

setQuiet(true);

const TODAY = '2026-03-04';

let root: string;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-templates-')); });
after(()  => { fs.rmSync(root, { recursive: true, force: true }); });

/** Writes a template folder under `base` and returns `base`. */
function template(base: string, name: string, md: string, description?: string): string {
    const dir = path.join(root, base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'template.md'), md);
    if (description !== undefined) fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify({ description }));
    return path.join(root, base);
}

const yamlOf = (doc: string): Record<string, unknown> => frontMatter(doc).attributes as Record<string, unknown>;
const bodyOf = (doc: string): string => frontMatter(doc).body;

// ── splitBlocks ───────────────────────────────────────────────────────────────

describe('splitBlocks', () => {
    it('keeps each top-level key with everything under it', () => {
        const blocks = splitBlocks([
            'Title: T',
            'Document Info:',
            '    Author: A',
            '',
            '    Status: S',
            'Cover Address:',
            '- line one',
            '- line two',
            '# a comment for Theme',
            'Theme: default',
            '# trailing',
        ].join('\n'));
        assert.deepEqual(blocks.map(b => b.key), ['Title', 'Document Info', 'Cover Address', 'Theme', null]);
        assert.deepEqual(blocks[1].lines, ['Document Info:', '    Author: A', '', '    Status: S']);
        assert.deepEqual(blocks[2].lines, ['Cover Address:', '- line one', '- line two']);
        assert.deepEqual(blocks[3].lines, ['# a comment for Theme', 'Theme: default']);
        assert.deepEqual(blocks[4].lines, ['# trailing']);
    });
});

// ── renderTemplate ────────────────────────────────────────────────────────────

describe('renderTemplate', () => {
    const base = template('render', 'memo', [
        '---',
        'Title: Ignored — the scaffold owns the title',
        'Theme: gaia',
        'Style: Navy',
        'Classification: Confidential',
        '# why landscape',
        'Orientation: landscape',
        'Revisions:',
        '    - {Revision: 9, Date: "1999-01-01", Author: X, Remarks: from the template}',
        'Document Info:',
        '    Author: Template Author',
        '    Customer: Acme',
        'Variables:',
        '    Site: Borne',
        '---',
        '',
        '',
        '# {{Title}}',
        '',
        'By {{ Author }} on {{Date}} for {{Site}}.',
        '',
    ].join('\n'), 'A memo');
    const entry = () => resolveTemplate('memo', [base]);

    it('takes the template\'s keys where nothing was answered', () => {
        const fm = yamlOf(renderTemplate(entry(), TODAY));
        assert.equal(fm.Theme, 'gaia');
        assert.equal(fm.Classification, 'Confidential');
        assert.equal(fm.Orientation, 'landscape');
        assert.deepEqual(fm.Variables, { Site: 'Borne' });
        assert.equal(fm.Mode, 'pdf, html', 'scaffold keys the template does not set stay');
    });

    it('lets an answer beat the template', () => {
        const fm = yamlOf(renderTemplate(entry(), TODAY, { theme: 'default', style: 'Grey', classification: 'Public' }));
        assert.equal(fm.Theme, 'default');
        assert.equal(fm.Style, 'Grey');
        assert.equal(fm.Classification, 'Public');
    });

    it('keeps the scaffold\'s identity: title, revisions, and its own Document Info rows', () => {
        const fm = yamlOf(renderTemplate(entry(), TODAY, { title: 'Q1: Plan', author: 'Me' }));
        assert.equal(fm.Title, 'Q1: Plan');
        assert.deepEqual(fm.Revisions, [{ Revision: 1, Date: TODAY, Author: 'Me', Remarks: 'Initial version' }]);
        assert.deepEqual(fm['Document Info'], {
            Author: 'Me', Date: TODAY, Revision: 1, Status: 'Work In Progress', Customer: 'Acme',
        });
    });

    it('keeps the template\'s comments with their key', () => {
        assert.match(renderTemplate(entry(), TODAY), /# why landscape\nOrientation: landscape/);
    });

    it('fills Title, Author and Date in the body and leaves other variables for the export', () => {
        const body = bodyOf(renderTemplate(entry(), TODAY, { title: 'Memo $& co', author: 'Me' }));
        assert.equal(body, '# Memo $& co\n\nBy Me on 2026-03-04 for {{Site}}.\n');
    });

    it('starts the body after exactly one blank line', () => {
        assert.match(renderTemplate(entry(), TODAY), /\n---\n\n# Document Title\n/);
    });

    it('accepts a template with no frontmatter at all', () => {
        const b = template('bare', 'plain', '# {{Title}}\n\nText.\n');
        const doc = renderTemplate(resolveTemplate('plain', [b]), TODAY, { title: 'X' });
        assert.equal(yamlOf(doc).Title, 'X');
        assert.equal(bodyOf(doc), '# X\n\nText.\n');
    });
});

// ── Discovery ─────────────────────────────────────────────────────────────────

describe('listTemplateEntries / resolveTemplate', () => {
    it('lists the built-in templates with a description and the keys they set', () => {
        const entries = listTemplateEntries([]);
        assert.deepEqual(entries.map(e => e.name), ['how-to', 'meeting-notes', 'report', 'technical-design']);
        for (const e of entries) {
            assert.equal(e.source, 'builtin');
            assert.ok(e.description.length > 10, e.name);
            assert.ok(e.sets.includes('Theme') && e.theme === 'default', e.name);
        }
    });

    it('lets an external template shadow a built-in one of the same name', () => {
        const ext = template('ext', 'report', '---\nTheme: gaia\n---\n# Ours\n', 'Our report');
        const report = listTemplateEntries([ext]).find(e => e.name === 'report')!;
        assert.equal(report.source, 'external');
        assert.equal(report.description, 'Our report');
        assert.equal(listTemplateEntries([ext]).filter(e => e.name === 'report').length, 1);
    });

    it('skips folders without a template.md', () => {
        const ext = template('mixed', 'real', '# x\n');
        fs.mkdirSync(path.join(ext, 'not-a-template'));
        assert.ok(!listTemplateEntries([ext]).some(e => e.name === 'not-a-template'));
    });

    it('resolves by name case-insensitively, by folder, and by a loose .md file', () => {
        assert.equal(resolveTemplate('REPORT', []).name, 'report');
        assert.equal(resolveTemplate(path.join(TEMPLATES_DIR, 'how-to'), []).name, 'how-to');
        const loose = path.join(root, 'memo-loose.md');
        fs.writeFileSync(loose, '---\nTheme: gaia\n---\n# x\n');
        const e = resolveTemplate(loose, []);
        assert.equal(e.name, 'memo-loose');
        assert.equal(e.theme, 'gaia');
    });

    it('exits 3 for an unknown name, suggesting the nearest', () => {
        assert.throws(() => resolveTemplate('meeting-note', []),
            (err: unknown) => err instanceof ExitError && err.exitCode === 3 && /did you mean "meeting-notes"/.test(err.message));
    });

    it('reads extra roots from EXPORT_TEMPLATE_PATH', () => {
        assert.deepEqual(templateRootsFromEnv({ EXPORT_TEMPLATE_PATH: `/a${path.delimiter}/b` }),
            [path.resolve('/a'), path.resolve('/b')]);
        assert.deepEqual(templateRootsFromEnv({}), []);
    });
});

// ── CLI ───────────────────────────────────────────────────────────────────────

describe('CLI template flags', () => {
    const run = (argv: string[]): ExitError => {
        try { parseArgs(argv); } catch (err) { return err as ExitError; }
        throw new Error('expected parseArgs to exit');
    };

    it('--init --template prints the rendered template', () => {
        const err = run(['--init', '--template', 'meeting-notes']);
        assert.equal(err.exitCode, 0);
        assert.equal(yamlOf(err.message)['Cover Page'], false);
        assert.match(bodyOf(err.message), /## Action items/);
        assert.match(err.message, /[^\n]$/, 'console.log adds the one newline the document ends with');
    });

    it('--template without --init is a usage error', () => {
        assert.equal(run(['--template', 'report', 'doc.md']).exitCode, 2);
    });

    it('--list-templates --json is parseable and matches the listing', () => {
        const err = run(['--list-templates', '--json']);
        const entries = JSON.parse(err.message) as Array<{ name: string; file: string }>;
        assert.deepEqual(entries.map(e => e.name), listTemplateEntries([]).map(e => e.name));
        assert.ok(entries.every(e => fs.existsSync(e.file)));
    });

    it('--template-path adds a root', () => {
        const ext = template('flag', 'custom-one', '# x\n', 'Custom');
        const err = run(['--list-templates', '--json', '--template-path', ext]);
        assert.ok((JSON.parse(err.message) as Array<{ name: string }>).some(e => e.name === 'custom-one'));
    });
});

// ── The built-in templates are real documents ─────────────────────────────────

describe('built-in templates', () => {
    for (const entry of listTemplateEntries([])) {
        it(`${entry.name}: uses only real keys, a real theme and style, and exports cleanly`, async () => {
            const doc = renderTemplate(entry, TODAY, { title: `${entry.name} test`, author: 'Tester', mode: 'html' });
            const fm = yamlOf(doc);
            assert.deepEqual(unknownKeyWarnings(fm), []);

            const theme = loadTheme(String(fm.Theme));
            assert.ok(Object.keys(theme.styles).includes(String(fm.Style)), `style ${String(fm.Style)}`);

            // A real export, --strict: any warning at all fails it.
            const dir = fs.mkdtempSync(path.join(root, `export-${entry.name}-`));
            const file = path.join(dir, 'doc.md');
            fs.writeFileSync(file, doc);
            await main({ argv: ['--quiet', '--no-bump', '--strict', '--mode', 'html', file] });
            assert.ok(fs.readdirSync(dir).some(f => f.endsWith('.html')), 'an HTML export was written');
        });
    }
});
