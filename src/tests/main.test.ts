import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { main, executeExport, describeDocument, shouldStripDiagramEmoji } from '../index';
import { extractFrontmatter } from '../frontmatter';
import { prepareSourceUpdates } from '../markdown';
import { setActiveTheme } from '../theme';
import { resolveExportPlan } from '../plan';
import { ExitError } from '../errors';
import { setQuiet } from '../logger';

/**
 * `main()` end to end, in-process.
 *
 * `pipeline.test.ts` runs the transformation pipeline; this runs the *function*
 * around it — argument parsing, frontmatter, theme selection, the plan, the
 * output write, and above all the deferred source mutation, which is the only
 * part of this tool that edits a file the user wrote. Those rules ("the stamp is
 * earned by the first output that lands", "a run that exports nothing must
 * leave the document exactly as it found it", "`--no-revision-bump` stamps the
 * date but never cuts a release") were previously asserted by nothing: `main()`
 * was unexported and its body was reachable only by spawning the CLI, which the
 * suite deliberately does not do.
 *
 * Everything here runs in `--mode html`, which needs no WeasyPrint, no Chromium
 * and no network — the documents hold no Mermaid, no draw.io, no images and no
 * icon fonts, exactly like the pipeline fixture.
 */

setQuiet(true);

let dir: string;

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-main-')); });
after(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * The date the export stamps: the LOCAL one, as `formatDate` in frontmatter.ts
 * builds it. `toISOString()` is UTC, and the two disagree from local midnight
 * until UTC midnight — so east of Greenwich this suite failed for the first
 * hours of every day, and west of it for the last.
 */
const TODAY = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/** A minimal exportable document. `extra` lands among the top-level keys. */
function document({ mode = 'html', revision = 3, status = 'Work In Progress', extra = '' } = {}): string {
    return `---
Title: Main Test
Theme: default
Style: Navy
${mode ? `Mode: ${mode}\n` : ''}${extra ? `${extra}\n` : ''}Document Info:
  Author: Test Author
  Revision: ${revision}
  Status: ${status}
Revisions:
  - Revision: ${revision}
    Date: "2020-01-01"
    Author: Test Author
    Remarks: first
---

# Main Test

Body text for the export.
`;
}

/** Writes a document into the temp directory under its own name. */
function write(name: string, content: string): string {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, content);
    return file;
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

describe('main() — html export', () => {
    it('writes an output file named from the revision', async () => {
        const file = write('report', document());
        await main({ argv: ['--quiet', file] });

        const out = path.join(dir, 'report_Rev3.html');
        assert.ok(fs.existsSync(out), 'expected report_Rev3.html');
        const html = read(out);
        assert.match(html, /<h1[^>]*>[\s\S]*Main Test/);
        assert.match(html, /Body text for the export/);
        assert.match(html, /class="[^"]*html-export/, 'the html pipeline marks the body');
    });

    it('honours --output over the derived name', async () => {
        const file = write('named', document());
        const out  = path.join(dir, 'somewhere-else.html');
        await main({ argv: ['--quiet', '--output', out, file] });

        assert.ok(fs.existsSync(out));
        assert.ok(!fs.existsSync(path.join(dir, 'named_Rev3.html')));
    });

    it('takes --mode over the document\'s own', async () => {
        const file = write('override', document({ mode: '' }));
        await main({ argv: ['--quiet', '--mode', 'html', file] });

        assert.ok(fs.existsSync(path.join(dir, 'override_Rev3.html')));
    });
});

describe('main() — source document mutation', () => {
    it('stamps today\'s revision date once an output has landed', async () => {
        const file   = write('stamped', document());
        const before = read(file);

        const { sourceWritten } = await main({ argv: ['--quiet', file] });

        const after = read(file);
        assert.notEqual(after, before, 'the source is stamped');
        assert.match(after, new RegExp(`Date: "${TODAY}"`));
        assert.equal(sourceWritten, after, 'main() returns exactly what it wrote — the watch guard depends on it');
    });

    it('leaves the source untouched under --no-bump', async () => {
        const file   = write('nobump', document());
        const before = read(file);

        const { sourceWritten } = await main({ argv: ['--quiet', '--no-bump', file] });

        assert.equal(read(file), before);
        assert.equal(sourceWritten, null);
        assert.ok(fs.existsSync(path.join(dir, 'nobump_Rev3.html')));
    });

    it('touches nothing when no Mode is set — a dry run must not stamp a date', async () => {
        const file   = write('nomode', document({ mode: '' }));
        const before = read(file);

        const { sourceWritten } = await main({ argv: ['--quiet', file] });

        assert.equal(read(file), before, 'a run that exports nothing leaves the document alone');
        assert.equal(sourceWritten, null);
        assert.deepEqual(
            fs.readdirSync(dir).filter(f => f.startsWith('nomode') && f.endsWith('.html')), [],
            'and writes no output',
        );
    });

    it('is idempotent — a second export of a stamped document rewrites nothing', async () => {
        const file = write('twice', document());
        await main({ argv: ['--quiet', file] });
        const afterFirst = read(file);

        const { sourceWritten } = await main({ argv: ['--quiet', file] });

        assert.equal(read(file), afterFirst);
        assert.equal(sourceWritten, null, 'nothing to write means nothing written');
    });
});

describe('main() — the release bump', () => {
    // Cutting a release takes `--release`. It used to happen on ANY export of a
    // document whose Status was Released — right for the export you meant as a
    // release, wrong for the extension firing on save, a CI run, or a colleague
    // re-exporting to read it, and it took three flags to defend against those.

    it('bumps the revision and resets the status with --release', async () => {
        const file = write('released', document({ status: 'Released' }));

        await main({ argv: ['--quiet', '--release', file] });

        const after = read(file);
        assert.match(after, /Revision: 4/,               'the Document Info revision moves on');
        assert.match(after, /Status: Work In Progress/,  'the status resets, so a second --release does nothing');
        assert.match(after, new RegExp(`- Revision: 4\\n\\s+Date: "${TODAY}"`), 'a new revisions row is appended');
        assert.match(after, /- Revision: 3/,             'and the released row is kept as history');
    });

    it('does NOT cut a release on an ordinary export of a Released document', async () => {
        const file = write('released-plain', document({ status: 'Released' }));

        await main({ argv: ['--quiet', file] });

        const after = read(file);
        assert.match(after, new RegExp(`Date: "${TODAY}"`), 'the export still stamps today\'s date');
        assert.match(after, /Revision: 3/,      'the revision is untouched');
        assert.doesNotMatch(after, /Revision: 4/);
        assert.match(after, /Status: Released/, 'and the document is still Released');
    });

    it('does nothing for --release on a document that is not Released', async () => {
        // The status is the document declaring it is final; the flag is you
        // saying cut it now. A Revisions row recording a release that never
        // happened would be a lie in the document's own history.
        const file = write('release-wip', document({ status: 'Work In Progress' }));

        await main({ argv: ['--quiet', '--release', file] });

        assert.match(read(file), /Revision: 3/);
        assert.doesNotMatch(read(file), /Revision: 4/);
    });

    it('writes nothing at all under --release --no-bump', async () => {
        const file   = write('release-nobump', document({ status: 'Released' }));
        const before = read(file);

        await main({ argv: ['--quiet', '--release', '--no-bump', file] });

        assert.equal(read(file), before, '--no-bump still means "touch nothing"');
    });

    it('accepts --no-revision-bump and ignores it', async () => {
        // Kept so existing scripts and the extension's older settings keep
        // working; there is nothing left for it to suppress.
        const file = write('legacy-flag', document({ status: 'Released' }));

        await main({ argv: ['--quiet', '--no-revision-bump', file] });

        assert.match(read(file), /Revision: 3/);
        assert.match(read(file), /Status: Released/);
    });

    it('is the release that a second export does not repeat', async () => {
        const file = write('release-twice', document({ status: 'Released' }));

        await main({ argv: ['--quiet', '--release', file] });
        const afterFirst = read(file);
        await main({ argv: ['--quiet', '--release', file] });

        assert.equal((read(file).match(/- Revision: /g) ?? []).length,
                     (afterFirst.match(/- Revision: /g) ?? []).length,
                     'the status reset is what stops the second one');
    });
});

describe('main() — failure paths', () => {
    it('exits 3 on a missing document rather than dying on a raw ENOENT', async () => {
        const missing = path.join(dir, 'does-not-exist.md');
        await assert.rejects(
            () => main({ argv: ['--quiet', missing] }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 3,
        );
    });

    it('exits 2 rather than writing an export over the input document', async () => {
        // An .html input in html mode with no revision derives the input's own name.
        const file = path.join(dir, 'selfoverwrite.html');
        fs.writeFileSync(file, '<html><body><h1>Hi</h1></body></html>');

        await assert.rejects(
            () => main({ argv: ['--quiet', '--mode', 'html', file] }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 2,
        );
        assert.equal(read(file), '<html><body><h1>Hi</h1></body></html>', 'the input survives');
    });

    it('exits 2 on an output directory that does not exist', async () => {
        const file = write('baddir', document());
        await assert.rejects(
            () => main({ argv: ['--quiet', '--output', path.join(dir, 'nope', 'out.html'), file] }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 2,
        );
    });
});

// ── Concurrent exports ────────────────────────────────────────────────────────
//
// Nothing serialises two exports of one document, and there are three ordinary
// ways to get them: `--watch` alongside a manual run, the VS Code extension
// exporting on save while a CLI export is mid-flight, or two windows. Each one
// computed its edit from the bytes it read at the start, so the one finishing
// second overwrote the other's write — with the principal's own document on the
// receiving end. Both writers now compare-and-swap and skip instead.

describe('main() — a document that changed under the export', () => {
    it('does not overwrite an edit that landed mid-export', async () => {
        const file = write('concurrent', document());

        // prepareSourceUpdates has read the file by the time the pipeline runs;
        // this simulates the other process finishing while it does.
        const edited = document().replace('Body text for the export.', 'Someone else was typing.');
        const run = main({ argv: ['--quiet', file] });
        fs.writeFileSync(file, edited);
        await run;

        assert.equal(read(file), edited, 'the other write survives untouched');
        assert.ok(fs.existsSync(path.join(dir, 'concurrent_Rev3.html')), 'the export itself still succeeds');
    });

    it('does not bump a revision on top of content it never read', async () => {
        const file = write('concurrent-release', document({ status: 'Released' }));

        // Another process already cut the release while this export was running.
        const alreadyBumped = document({ revision: 4, status: 'Work In Progress' });
        const run = main({ argv: ['--quiet', file] });
        fs.writeFileSync(file, alreadyBumped);
        await run;

        const after = read(file);
        assert.equal(after, alreadyBumped, 'no second bump on top of the first');
        assert.equal((after.match(/- Revision: /g) ?? []).length, 1, 'and no duplicate revisions row');
    });
});

// ── Reported dependencies ─────────────────────────────────────────────────────
//
// What `--watch` subscribes to. Collected by the passes that resolve a local
// path — includes, image inlining, draw.io — plus the stylesheet, which main()
// knows on its own.

describe('main() — what the export reports having read', () => {
    it('reports an included file', async () => {
        const inc  = path.join(dir, 'chapter.md');
        fs.writeFileSync(inc, '## Chapter\n\nText.\n');
        const file = write('with-include', document().replace('Body text for the export.',
            '[!include](chapter.md)'));

        const { dependencies } = await main({ argv: ['--quiet', file] });

        assert.ok(dependencies.includes(inc), dependencies.join(', '));
    });

    it('reports a nested include, not just the first level', async () => {
        const deep = path.join(dir, 'deep.md');
        const mid  = path.join(dir, 'mid.md');
        fs.writeFileSync(deep, '## Deep\n');
        fs.writeFileSync(mid, '## Mid\n\n[!include](deep.md)\n');
        const file = write('nested', document().replace('Body text for the export.', '[!include](mid.md)'));

        const { dependencies } = await main({ argv: ['--quiet', file] });

        assert.ok(dependencies.includes(mid), 'the include itself');
        assert.ok(dependencies.includes(deep), 'and what it includes in turn');
    });

    it('reports a file quoted as a code block', async () => {
        const src = path.join(dir, 'sample.ts');
        fs.writeFileSync(src, 'export const x = 1;\n');
        const file = write('code-include', document().replace('Body text for the export.',
            '[!include](sample.ts)'));

        const { dependencies } = await main({ argv: ['--quiet', file] });

        assert.ok(dependencies.includes(src), dependencies.join(', '));
    });

    it('reports a local image', async () => {
        const png = path.join(dir, 'pic.png');
        fs.writeFileSync(png, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64'));
        const file = write('with-image', document().replace('Body text for the export.', '![pic](pic.png)'));

        const { dependencies } = await main({ argv: ['--quiet', file] });

        assert.ok(dependencies.includes(png), dependencies.join(', '));
    });

    it('reports the stylesheet', async () => {
        const css  = path.join(dir, 'custom.css');
        fs.writeFileSync(css, 'body { color: #333; }\n');
        const file = write('with-css', document());

        const { dependencies } = await main({ argv: ['--quiet', '--stylesheet', css, file] });

        assert.ok(dependencies.includes(css), dependencies.join(', '));
    });

    it('reports nothing for a run that exported nothing', async () => {
        const file = write('no-mode-deps', document({ mode: '' }));
        const { dependencies } = await main({ argv: ['--quiet', file] });
        assert.deepEqual(dependencies, []);
    });

    it('does not report a remote image — a watcher cannot do anything with one', async () => {
        const file = write('remote-img', document().replace('Body text for the export.',
            '![x](https://example.invalid/x.png)'));

        const { dependencies } = await main({ argv: ['--quiet', file] });

        assert.ok(!dependencies.some(d => d.includes('example.invalid')), dependencies.join(', '));
    });
});


// ── --strict ──────────────────────────────────────────────────────────────────

describe('main() — --strict', () => {
    /** A document whose include and image both point at nothing. */
    const broken = () => [
        '---', 'Title: Broken', 'Theme: default', 'Style: Navy', 'Mode: html', '---',
        '# Heading', '', '[!include](does-not-exist.md)', '', '![missing](nope.png)', '',
    ].join('\n');

    const clean = () => [
        '---', 'Title: Clean', 'Theme: default', 'Style: Navy', 'Mode: html', '---',
        '# Heading', '', 'Body text.', '',
    ].join('\n');

    it('leaves the default alone: a broken document still exports, exit 0', async () => {
        // Right for a draft. Nothing about the existing behaviour changes.
        const file = write('strict-default', broken());
        await main({ argv: ['--quiet', '--no-bump', file] });
        assert.ok(fs.existsSync(file.replace(/\.md$/, '.html')));
    });

    it('fails a broken document with exit 6', async () => {
        const file = write('strict-broken', broken());
        await assert.rejects(
            () => main({ argv: ['--quiet', '--no-bump', '--strict', file] }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 6,
        );
    });

    it('still writes the output it refuses', async () => {
        // Seeing the broken artifact is usually how you work out what the
        // warning meant, so the file is produced and the exit code refuses it.
        const file = write('strict-writes', broken());
        const out  = file.replace(/\.md$/, '.html');
        await main({ argv: ['--quiet', '--no-bump', '--strict', file] }).catch(() => undefined);
        assert.ok(fs.existsSync(out), 'the export should still have written its output');
        assert.ok(fs.statSync(out).size > 0);
    });

    it('passes a clean document', async () => {
        const file = write('strict-clean', clean());
        await main({ argv: ['--quiet', '--no-bump', '--strict', file] });
        assert.ok(fs.existsSync(file.replace(/\.md$/, '.html')));
    });

    it('does not fail a re-export over the overwrite notice', async () => {
        // That notice fires on every second run. Left as a WARNING it would have
        // made --strict useless for exactly the repeated CI export it is for.
        const file = write('strict-again', clean());
        await main({ argv: ['--quiet', '--no-bump', '--strict', file] });
        await main({ argv: ['--quiet', '--no-bump', '--strict', file] });
    });

    it('judges each run on its own, not on the ones before it', async () => {
        // The counter resets per run — otherwise a --watch loop would fail every
        // export after the first one that warned.
        const bad  = write('strict-reset-bad', broken());
        const good = write('strict-reset-good', clean());
        await main({ argv: ['--quiet', '--no-bump', '--strict', bad] }).catch(() => undefined);
        await main({ argv: ['--quiet', '--no-bump', '--strict', good] });
    });
});

// ── Document metadata ─────────────────────────────────────────────────────────

describe('main() — document metadata reaches the output', () => {
    it('writes the frontmatter title and author into <head>', async () => {
        // Neither was emitted, so an exported PDF carried no /Title and no
        // /Author — WeasyPrint reads both from here.
        const file = write('meta', [
            '---', 'Title: Quarterly Engineering Report', 'Author: Jane Doe',
            'Theme: default', 'Style: Navy', 'Mode: html', '---', '# Introduction', '',
        ].join('\n'));
        await main({ argv: ['--quiet', '--no-bump', file] });

        const html = read(file.replace(/\.md$/, '.html'));
        assert.match(html, /<title>Quarterly Engineering Report<\/title>/);
        assert.match(html, /<meta name="author" content="Jane Doe">/);
        // Inside <head>, where a PDF renderer and a browser tab both look.
        assert.ok(html.indexOf('<title>') < html.indexOf('</head>'));
    });
});


// ── What --watch can see of the cover ─────────────────────────────────────────

describe('main() — the cover is watched too', () => {
    /** A 1×1 PNG, small enough to inline into a document. */
    const PIXEL = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64');

    it('reports the cover background and the cover logo', async () => {
        // cover.ts read files and told nobody, so `--watch` re-exported when you
        // edited a body image but not when you edited the cover photo — which is
        // the image people iterate on most.
        const hero = path.join(dir, 'hero.png');
        const mark = path.join(dir, 'mark.png');
        fs.writeFileSync(hero, PIXEL);
        fs.writeFileSync(mark, PIXEL);

        const file = write('cover-deps', [
            '---', 'Title: Cover deps', 'Theme: default', 'Mode: html',
            'Style:', '    Color: Navy', '    Image: hero.png',
            'Cover Logo:', '    - Path: mark.png',
            '---', '# Heading', '',
        ].join('\n'));

        const { dependencies } = await main({ argv: ['--quiet', '--no-bump', file] });

        assert.ok(dependencies.includes(hero), `hero missing from ${dependencies.join(', ')}`);
        assert.ok(dependencies.includes(mark), `logo missing from ${dependencies.join(', ')}`);
    });

    it('reports the theme files the export actually read', async () => {
        // The theme's own stylesheet was reported; what that stylesheet
        // @imports, and the cover template beside it, were not.
        const file = write('theme-deps', [
            '---', 'Title: Theme deps', 'Theme: default', 'Style: Navy', 'Mode: html',
            '---', '# Heading', '',
        ].join('\n'));

        const { dependencies } = await main({ argv: ['--quiet', '--no-bump', file] });

        assert.ok(dependencies.some(d => d.endsWith('theme.css')), 'the theme stylesheet');
        assert.ok(dependencies.some(d => d.includes('logos') || d.endsWith('.svg')),
                  `a theme logo, in ${dependencies.join(', ')}`);
    });
});

// ── --dry-run reaches the two problems people actually hit ────────────────────

describe('main() — --dry-run checks includes and images', () => {
    const brokenDoc = () => [
        '---', 'Title: Broken', 'Theme: default', 'Style: Navy', 'Mode: html', '---',
        '# Heading', '', '[!include](nowhere.md)', '', '![gone](nothing.png)', '',
    ].join('\n');

    it('fails a document with an unresolved include or a missing image, under --strict', async () => {
        // A dry run used to stop before the document was rendered at all, so the
        // two problems it is actually asked about were the two it could not see.
        const file = write('dry-broken', brokenDoc());
        await assert.rejects(
            () => main({ argv: ['--quiet', '--no-bump', '--dry-run', '--strict', file] }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 6,
        );
    });

    it('still writes nothing while doing it', async () => {
        const file = write('dry-nothing', brokenDoc());
        await main({ argv: ['--quiet', '--no-bump', '--dry-run', '--strict', file] }).catch(() => undefined);
        assert.equal(fs.existsSync(file.replace(/\.md$/, '.html')), false,
                     'a dry run must not produce an output file');
    });

    it('passes a clean document', async () => {
        const file = write('dry-clean', [
            '---', 'Title: Clean', 'Theme: default', 'Style: Navy', 'Mode: html', '---',
            '# Heading', '', 'Body text.', '',
        ].join('\n'));
        await main({ argv: ['--quiet', '--no-bump', '--dry-run', '--strict', file] });
    });
});

// ── executeExport, driven directly ────────────────────────────────────────────

/**
 * The doing half of `main()`, called on its own.
 *
 * Split out of a 264-line function whose bottom third could only be reached by
 * driving a whole CLI run through `parseArgs`. These assert the rules that live
 * there against a plan handed in directly — which is also the shape a future
 * caller (a library user, a batch exporter) would use.
 */
describe('executeExport', () => {
    /** Resolves frontmatter + plan for a real document, the way `main()` does. */
    function planFor(file: string, opts: { noBump?: boolean } = {}) {
        const htmlFile = file.replace(/\.md$/, '.html');
        const pendingSource = opts.noBump ? null : prepareSourceUpdates(file);
        const fm = extractFrontmatter(file, pendingSource?.content);
        setActiveTheme('default');
        const plan = resolveExportPlan({
            inputFile: file, htmlFile, revision: fm.revision,
            cliTheme: null, fmTheme: fm.theme,
            cliStylesheet: 'none', themeStylesheetFile: null,
            cliMode: null, fmMode: fm.mode,
            cliOutput: null, cliDpi: null, cliPdfVariant: null, fmPdfVariant: null,
        });
        return { htmlFile, fm, plan, pendingSource };
    }

    const base = (file: string, o: ReturnType<typeof planFor>) => ({
        inputFile: file, htmlFile: o.htmlFile, markdownFile: file, isMarkdownInput: true,
        fm: o.fm, pendingSource: o.pendingSource, stylesheetPath: null, plan: o.plan,
        weasyprintPath: null, bumpRevisions: false, open: false, strict: false,
        releaseNote: null,
    });

    it('writes the output and reports what the source was stamped with', async () => {
        const file = write('exec-basic', document());
        const o = planFor(file);
        const result = await executeExport(base(file, o));

        assert.ok(fs.existsSync(path.join(dir, 'exec-basic_Rev3.html')), 'the output must land');
        assert.ok(result.sourceWritten, 'the source stamp is earned by the output that landed');
        assert.equal(read(file), result.sourceWritten,
                     'sourceWritten must equal the bytes on disk — --watch compares them');
        assert.match(read(file), new RegExp(TODAY), 'today\'s date is stamped');
    });

    it('leaves the source untouched when there is nothing pending', async () => {
        const file = write('exec-nobump', document());
        const before = read(file);
        const o = planFor(file, { noBump: true });
        const result = await executeExport(base(file, o));

        assert.equal(result.sourceWritten, null);
        assert.equal(read(file), before, '--no-bump must not modify a byte');
    });

    it('reports every file the export read, for --watch to subscribe to', async () => {
        const chapter = path.join(dir, 'exec-chapter.md');
        fs.writeFileSync(chapter, '## Chapter\n\nIncluded prose.\n');
        const file = write('exec-deps', document().replace('Body text for the export.',
                                                           '[!include](exec-chapter.md)'));
        const o = planFor(file);
        const result = await executeExport(base(file, o));

        assert.ok(result.dependencies.includes(chapter),
                  `expected the include among ${JSON.stringify(result.dependencies)}`);
        assert.match(read(path.join(dir, 'exec-deps_Rev3.html')), /Included prose/);
    });

    it('honours --strict by refusing a run that warned, AFTER writing the output', async () => {
        // The ordering is the point: a warning means the document has a problem,
        // not that the export could not happen, and seeing the broken artifact is
        // usually how you work out what the warning meant.
        const file = write('exec-strict', document().replace('Body text for the export.',
                                                             '![missing](no-such-image.png)'));
        const o = planFor(file);
        await assert.rejects(
            () => executeExport({ ...base(file, o), strict: true }),
            (err: unknown) => err instanceof ExitError && err.exitCode === 6,
        );
        assert.ok(fs.existsSync(path.join(dir, 'exec-strict_Rev3.html')),
                  'the output is still written; the exit code is what refuses it');
    });
});


// ── shouldStripDiagramEmoji ───────────────────────────────────────────────────
//
// The check must launch WeasyPrint at most once per export, and only when the
// answer actually matters — never for the ordinary document with no diagram,
// never for an HTML-only export. `checkSupport` is a call counter here rather
// than a real probe, which is the whole point of injecting it.

describe('shouldStripDiagramEmoji', () => {
    function countingCheck(result: boolean) {
        let calls = 0;
        const check = async (_weasyprintPath: string) => { calls++; return result; };
        return { check, calls: () => calls };
    }

    it('never strips for an HTML-only export, and never calls checkSupport', async () => {
        const { check, calls } = countingCheck(false);
        const result = await shouldStripDiagramEmoji(false, null, true, check);
        assert.equal(result, false);
        assert.equal(calls(), 0);
    });

    it('never strips a document with no diagram, and never calls checkSupport', async () => {
        const { check, calls } = countingCheck(false);
        const result = await shouldStripDiagramEmoji(true, '/usr/bin/weasyprint', false, check);
        assert.equal(result, false);
        assert.equal(calls(), 0);
    });

    it('strips when the PDF pipeline has a diagram and checkSupport says unsupported', async () => {
        const { check, calls } = countingCheck(false);
        const result = await shouldStripDiagramEmoji(true, '/usr/bin/weasyprint', true, check);
        assert.equal(result, true);
        assert.equal(calls(), 1);
    });

    it('does not strip when checkSupport confirms colour emoji render correctly', async () => {
        const { check, calls } = countingCheck(true);
        const result = await shouldStripDiagramEmoji(true, '/usr/bin/weasyprint', true, check);
        assert.equal(result, false);
        assert.equal(calls(), 1);
    });

    it('never strips when weasyprintPath is null, even with hasPdf and a diagram', async () => {
        // Defensive: hasPdf implies a resolved weasyprintPath in practice
        // (findWeasyprint() either returns one or the run has already exited),
        // but the check must not call checkSupport with a path it doesn't have.
        const { check, calls } = countingCheck(false);
        const result = await shouldStripDiagramEmoji(true, null, true, check);
        assert.equal(result, false);
        assert.equal(calls(), 0);
    });
});

// ── describeDocument (--inspect) ──────────────────────────────────────────────

/**
 * `--inspect` is a read-only question-answering surface, added because tooling
 * has to know things about a document BEFORE acting on it — the VS Code
 * extension asks whether the revision it is about to release already carries a
 * note. Without it the editor would need its own YAML reader, which is a second
 * answer to "what does this document say" living one refactor away from
 * disagreeing with the first.
 */
describe('describeDocument', () => {
    const inspect = (content: string) => {
        const file = path.join(dir, `inspect-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(file, content);
        return describeDocument(extractFrontmatter(file), file);
    };

    it('reports the resolved view, not the raw YAML', () => {
        // `Mode: pdf, html` comes back normalised — a caller reading the file
        // itself would have to re-implement that.
        const info = inspect(document({ mode: 'pdf, html' }));
        assert.equal(info.mode, 'pdf,html');
        assert.equal(info.title, 'Main Test');
        assert.equal(info.theme, 'default');
        assert.equal(info.style, 'Navy');
    });

    it('hoists the outgoing revision out of the list', () => {
        // The row a release acts on. A caller should not have to know that
        // "last" means "outgoing".
        const info = inspect(document({ revision: 4 }));
        assert.equal(info.revision, '4');
        assert.equal((info.lastRevision as { revision: string }).revision, '4');
    });

    it('applies isReleasedStatus rather than comparing strings', () => {
        assert.equal(inspect(document({ status: 'Released' })).released, true);
        // Dutch counts, which a caller matching on "Released" would miss.
        assert.equal(inspect(document({ status: 'Vrijgegeven' })).released, true);
        assert.equal(inspect(document({ status: 'Work In Progress' })).released, false);
    });

    it('asks for a note when a released revision has none', () => {
        const doc = document({ status: 'Released' }).replace('Remarks: first', 'Remarks:');
        const info = inspect(doc);
        assert.equal(info.released, true);
        assert.equal(info.lastRemarks, '');
        assert.equal(info.needsReleaseNote, true);
    });

    it('does not ask when the released revision already says something', () => {
        assert.equal(inspect(document({ status: 'Released' })).needsReleaseNote, false);
    });

    it('does not ask for a document that is not being released', () => {
        const doc = document({ status: 'Work In Progress' }).replace('Remarks: first', 'Remarks:');
        assert.equal(inspect(doc).needsReleaseNote, false);
    });

    it('survives a document with no revisions at all', () => {
        const info = inspect(['---', 'Title: Bare', 'Mode: html', '---', '', '# Bare', ''].join('\n'));
        assert.equal(info.lastRevision, null);
        assert.equal(info.lastRemarks, null);
        assert.equal(info.needsReleaseNote, false);
    });

    it('is JSON-serialisable, which is the whole point', () => {
        const info = inspect(document());
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(info)));
    });
});
