import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * The env overrides are applied by an IIFE at module load, so each case runs in
 * a fresh process with its own environment.
 */
function configWith(env: Record<string, string>): Record<string, number | string | null> {
    const configPath = path.join(__dirname, '..', 'config.js');
    const out = execFileSync(
        process.execPath,
        ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).CONFIG))`],
        { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(out);
}

describe('CONFIG defaults', () => {
    it('ships the documented defaults', () => {
        const c = configWith({});
        assert.equal(c.weasyprintDpi, 300);
        assert.equal(c.fetchTimeoutMs, 15_000);
        assert.equal(c.imageJpegQuality, 88);
        assert.equal(c.concurrency, 4);
    });
});

describe('environment overrides', () => {
    it('EXPORT_PDF_DPI overrides the DPI', () => {
        assert.equal(configWith({ EXPORT_PDF_DPI: '150' }).weasyprintDpi, 150);
    });

    it('EXPORT_PDF_TIMEOUT_MS overrides the fetch timeout', () => {
        assert.equal(configWith({ EXPORT_PDF_TIMEOUT_MS: '500' }).fetchTimeoutMs, 500);
    });

    it('EXPORT_PDF_CONCURRENCY overrides the render concurrency', () => {
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '1' }).concurrency, 1);
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '16' }).concurrency, 16);
    });

    it('falls back to the default on a non-numeric value', () => {
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: 'many' }).concurrency, 4);
        assert.equal(configWith({ EXPORT_PDF_DPI: 'high' }).weasyprintDpi, 300);
    });

    it('falls back to the default outside the allowed range', () => {
        // Concurrency is clamped to 1-64; quality to 1-100.
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '0' }).concurrency, 4);
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '999' }).concurrency, 4);
        assert.equal(configWith({ EXPORT_PDF_IMAGE_QUALITY: '0' }).imageJpegQuality, 88);
        assert.equal(configWith({ EXPORT_PDF_IMAGE_QUALITY: '101' }).imageJpegQuality, 88);
    });

    it('accepts the range boundaries', () => {
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '64' }).concurrency, 64);
        assert.equal(configWith({ EXPORT_PDF_IMAGE_QUALITY: '100' }).imageJpegQuality, 100);
    });

    it('ignores an empty value rather than treating it as zero', () => {
        assert.equal(configWith({ EXPORT_PDF_CONCURRENCY: '' }).concurrency, 4);
    });

    it('EXPORT_PDF_VARIANT sets the default PDF variant', () => {
        assert.equal(configWith({ EXPORT_PDF_VARIANT: 'pdf/a-2b' }).pdfVariant, 'pdf/a-2b');
    });

    it('EXPORT_PDF_VARIANT is case-insensitive', () => {
        assert.equal(configWith({ EXPORT_PDF_VARIANT: 'PDF/A-2B' }).pdfVariant, 'pdf/a-2b');
    });

    it('is null (an ordinary PDF) by default', () => {
        assert.equal(configWith({}).pdfVariant, null);
    });

    it('falls back to null on a value WeasyPrint does not recognise', () => {
        assert.equal(configWith({ EXPORT_PDF_VARIANT: 'pdf/a-99z' }).pdfVariant, null);
    });

    it('infographic icons come from Iconify by default', () => {
        assert.equal(configWith({}).infographicIcons, 'iconify');
    });

    it('EXPORT_INFOGRAPHIC_ICONS chooses the provider, case-insensitively', () => {
        assert.equal(configWith({ EXPORT_INFOGRAPHIC_ICONS: 'none' }).infographicIcons, 'none');
        assert.equal(configWith({ EXPORT_INFOGRAPHIC_ICONS: 'WeaveFox' }).infographicIcons, 'weavefox');
    });

    it('an unknown EXPORT_INFOGRAPHIC_ICONS keeps the default rather than guessing', () => {
        assert.equal(configWith({ EXPORT_INFOGRAPHIC_ICONS: 'google' }).infographicIcons, 'iconify');
    });
});
