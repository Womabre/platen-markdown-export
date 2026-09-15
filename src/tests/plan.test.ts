import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ExitError } from '../errors';
import { CONFIG } from '../config';
import { resolveThemeName, resolveStylesheet, outputPathFor, resolveExportPlan } from '../plan';
import type { ExportPlanInput } from '../plan';

const base: ExportPlanInput = {
    inputFile: '/docs/report.md',
    htmlFile:  '/docs/report.html',
    revision:  '3',
    cliTheme: null, fmTheme: null,
    cliStylesheet: null, themeStylesheetFile: null,
    cliMode: null, fmMode: null,
    cliOutput: null, cliDpi: null, cliPdfVariant: null, fmPdfVariant: null,
    env: {},
    fileExists: () => false,   // no theme stylesheet on disk
    dirExists:  () => true,    // /docs is presumed to exist
};
const plan = (over: Partial<ExportPlanInput> = {}) => resolveExportPlan({ ...base, ...over });

describe('resolveThemeName', () => {
    it('prefers --theme over everything', () => {
        assert.equal(resolveThemeName('cli', 'fm', { EXPORT_THEME: 'env' }), 'cli');
    });
    it('falls back to the Theme frontmatter key', () => {
        assert.equal(resolveThemeName(null, 'fm', { EXPORT_THEME: 'env' }), 'fm');
    });
    it('falls back to EXPORT_THEME', () => {
        assert.equal(resolveThemeName(null, null, { EXPORT_THEME: 'env' }), 'env');
    });
    it('falls back to the default theme last', () => {
        assert.equal(resolveThemeName(null, null, {}), 'default');
    });
});

describe('resolveStylesheet', () => {
    it('"none" disables the stylesheet explicitly', () => {
        const r = resolveStylesheet('none', '/theme/style.css', () => true);
        assert.equal(r.path, null);
        assert.match(r.label, /-s none/);
    });

    it('an explicit path wins over the theme default', () => {
        const r = resolveStylesheet('/my/custom.css', '/theme/style.css', () => true);
        assert.equal(r.path, '/my/custom.css');
    });

    it('defaults to the theme stylesheet when it exists', () => {
        const r = resolveStylesheet(null, '/theme/style.css', () => true);
        assert.equal(r.path, '/theme/style.css');
        assert.match(r.label, /theme default/);
    });

    it('falls back to none when the theme stylesheet is missing', () => {
        const r = resolveStylesheet(null, '/theme/style.css', () => false);
        assert.equal(r.path, null);
        assert.equal(r.label, 'not provided');
    });
});

describe('outputPathFor', () => {
    const opts = { inputFile: '/docs/report.md', htmlFile: '/docs/report.html', revision: '3', cliOutput: null };

    it('derives a PDF name with the revision suffix', () => {
        assert.equal(outputPathFor('pdf', opts), path.join('/docs', 'report_Rev3.pdf'));
    });

    it('derives an HTML name with the revision suffix', () => {
        assert.equal(outputPathFor('html', opts), path.join('/docs', 'report_Rev3.html'));
    });

    it('omits the suffix when there is no revision', () => {
        assert.equal(outputPathFor('pdf', { ...opts, revision: null }), path.join('/docs', 'report.pdf'));
    });

    it('treats debug as a PDF mode', () => {
        assert.match(outputPathFor('debug', opts), /\.pdf$/);
    });

    it('strips a legacy _vN.N version suffix from the base name', () => {
        const r = outputPathFor('pdf', { ...opts, htmlFile: '/docs/report_v2.1.html' });
        assert.equal(r, path.join('/docs', 'report_Rev3.pdf'));
    });

    // `.replace('.html', '')` takes the FIRST occurrence, so a name that
    // contains ".html" before its extension had the extension eaten out of the
    // middle: `my.html.notes.md` derived `my.notes.html.pdf`.
    it('strips only the trailing extension, not a ".html" inside the name', () => {
        const r = outputPathFor('pdf', {
            ...opts,
            inputFile: '/docs/my.html.notes.md',
            htmlFile:  '/docs/my.html.notes.html',
            revision:  null,
        });
        assert.equal(r, path.join('/docs', 'my.html.notes.pdf'));
    });

    it('--output wins outright', () => {
        assert.equal(outputPathFor('pdf', { ...opts, cliOutput: '/elsewhere/out.pdf' }), '/elsewhere/out.pdf');
    });

    // The data-loss guard. Reachable in normal use: an .html input exported in
    // html mode with no revision derives the input's own name.
    it('refuses to overwrite the input file', () => {
        assert.throws(
            () => outputPathFor('html', {
                inputFile: '/docs/report.html', htmlFile: '/docs/report.html',
                revision: null, cliOutput: null,
            }),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2 && /would overwrite the input file/.test(e.message),
        );
    });

    it('refuses an --output that names the input file', () => {
        assert.throws(
            () => outputPathFor('pdf', { ...opts, cliOutput: '/docs/report.md' }),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2,
        );
    });

    it('catches the collision through a non-normalised path too', () => {
        assert.throws(
            () => outputPathFor('pdf', { ...opts, cliOutput: '/docs/../docs/report.md' }),
            ExitError,
        );
    });

    it('allows an output that merely shares the directory', () => {
        assert.doesNotThrow(() => outputPathFor('pdf', { ...opts, cliOutput: '/docs/other.pdf' }));
    });
});

describe('resolveExportPlan — output directory', () => {
    // Only --output can name a missing directory, so this is a usage error, and
    // catching it in the plan means it fires before the diagram rendering rather
    // than as an unhandled ENOENT a minute later.
    it('rejects an --output whose directory does not exist', () => {
        assert.throws(
            () => plan({ cliMode: 'pdf', cliOutput: '/nope/out.pdf', dirExists: () => false }),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2
                && /output directory does not exist/.test(e.message),
        );
    });

    it('accepts an --output whose directory exists', () => {
        const p = plan({ cliMode: 'pdf', cliOutput: '/real/out.pdf', dirExists: () => true });
        assert.equal(p.pdfOutputFile, '/real/out.pdf');
    });

    it('checks the derived path too, not just --output', () => {
        assert.throws(
            () => plan({ cliMode: 'html', dirExists: () => false }),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2,
        );
    });
});

describe('resolveExportPlan', () => {
    it('is a dry run when no mode is set anywhere', () => {
        const p = plan();
        assert.deepEqual(p.modes, []);
        assert.equal(p.hasPdf, false);
        assert.equal(p.hasHtml, false);
        assert.equal(p.htmlOutputFile, null);
        assert.equal(p.pdfOutputFile, null);
    });

    it('--mode overrides the Mode frontmatter', () => {
        assert.deepEqual(plan({ cliMode: 'html', fmMode: 'pdf' }).modes, ['html']);
    });

    it('falls back to the Mode frontmatter', () => {
        assert.deepEqual(plan({ fmMode: 'pdf,html' }).modes, ['pdf', 'html']);
    });

    it('reports unknown frontmatter modes instead of dropping them silently', () => {
        const p = plan({ fmMode: 'pdf,docx' });
        assert.deepEqual(p.modes, ['pdf']);
        assert.deepEqual(p.unknownModes, ['docx']);
    });

    it('treats debug as a PDF mode and remembers which one it was', () => {
        const p = plan({ fmMode: 'debug' });
        assert.equal(p.hasPdf, true);
        assert.equal(p.pdfMode, 'debug');
    });

    it('resolves both output paths for pdf,html', () => {
        const p = plan({ fmMode: 'pdf,html' });
        assert.match(p.pdfOutputFile!, /report_Rev3\.pdf$/);
        assert.match(p.htmlOutputFile!, /report_Rev3\.html$/);
    });

    it('rejects --output combined with both modes, since one would clobber the other', () => {
        assert.throws(
            () => plan({ fmMode: 'pdf,html', cliOutput: '/out/file.pdf' }),
            (e: unknown) => e instanceof ExitError && e.exitCode === 2 && /cannot be combined/.test(e.message),
        );
    });

    it('allows --output with a single mode', () => {
        assert.equal(plan({ fmMode: 'pdf', cliOutput: '/out/file.pdf' }).pdfOutputFile, '/out/file.pdf');
    });

    it('fails on a bad output path before any rendering could start', () => {
        // The point of resolving paths inside the plan: this throws during
        // planning, not after minutes of diagram work.
        assert.throws(
            () => plan({ fmMode: 'html', inputFile: '/docs/report.html', htmlFile: '/docs/report.html', revision: null }),
            ExitError,
        );
    });

    it('--dpi overrides the configured default', () => {
        assert.equal(plan({ cliDpi: 150 }).dpi, 150);
    });

    it('uses the configured DPI when --dpi is absent', () => {
        assert.equal(plan().dpi, 300);
    });

    it('--pdf-variant overrides the configured default', () => {
        assert.equal(plan({ cliPdfVariant: 'pdf/a-2b' }).pdfVariant, 'pdf/a-2b');
    });

    it('produces an ordinary PDF (null variant) when --pdf-variant is absent', () => {
        assert.equal(plan().pdfVariant, null);
    });

    it('falls back to the PDF Variant frontmatter field when --pdf-variant is absent', () => {
        assert.equal(plan({ fmPdfVariant: 'pdf/ua-1' }).pdfVariant, 'pdf/ua-1');
    });

    it('--pdf-variant wins over the PDF Variant frontmatter field', () => {
        assert.equal(plan({ cliPdfVariant: 'pdf/a-2b', fmPdfVariant: 'pdf/ua-1' }).pdfVariant, 'pdf/a-2b');
    });

    it('--infographic-icons overrides the configured icon provider', () => {
        assert.equal(plan({ cliInfographicIcons: 'none' }).infographicIcons, 'none');
        assert.equal(plan({ cliInfographicIcons: 'weavefox' }).infographicIcons, 'weavefox');
    });

    it('uses the configured icon provider when --infographic-icons is absent', () => {
        assert.equal(plan().infographicIcons, CONFIG.infographicIcons);
    });

    it('carries the stylesheet choice through', () => {
        // The theme name is deliberately NOT on the plan: the theme must already
        // be loaded before `resolveExportPlan` runs (it reads the theme's own
        // stylesheet path), so `main()` resolves the name itself and a copy here
        // would be a second source of truth. `resolveThemeName` is tested above.
        const p = plan({ cliTheme: 'modern', cliStylesheet: 'none' });
        assert.equal(p.stylesheetPath, null);
    });
});
