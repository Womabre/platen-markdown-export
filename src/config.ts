import type { Config } from './types';

// ── Raster image MIME types that get converted to JPEG ────────────────────────

export const RASTER_TYPES = new Set<string>([
    'image/webp', 'image/avif', 'image/bmp',
]);

// ── MIME type map ─────────────────────────────────────────────────────────────

export const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

// ── PDF conformance variants ──────────────────────────────────────────────────
// WeasyPrint's own --pdf-variant choices, mirrored verbatim (`weasyprint --help`)
// so this repo's --pdf-variant validates against exactly what the installed
// binary accepts rather than a hand-maintained guess that could drift from it.

export const PDF_VARIANTS = [
    'pdf/a-1b', 'pdf/a-2b', 'pdf/a-3b', 'pdf/a-2u', 'pdf/a-3u', 'pdf/a-4u',
    'pdf/a-1a', 'pdf/a-2a', 'pdf/a-3a', 'pdf/a-4e', 'pdf/a-4f',
    'pdf/ua-1', 'pdf/ua-2',
    'pdf/x-1a', 'pdf/x-3', 'pdf/x-4', 'pdf/x-5g',
    'debug',
] as const;

// ── Infographic icon providers ────────────────────────────────────────────────
// Where ```infographic icons come from. `iconify` sends only a well-formed icon
// name to Iconify's public API; `weavefox` sends icon queries — and, when an icon
// cannot be found, an item's label/desc text — to Ant Group's WeaveFox service in
// China; `none` makes no request at all. See infographic-icons.ts.

export const INFOGRAPHIC_ICON_PROVIDERS = ['iconify', 'weavefox', 'none'] as const;
export type InfographicIconProvider = typeof INFOGRAPHIC_ICON_PROVIDERS[number];

// ── GitHub alert accent colors ────────────────────────────────────────────────

export const ALERT_COLORS: Record<string, string> = {
    'markdown-alert-note': '#0969da',
    'markdown-alert-tip': '#1a7f37',
    'markdown-alert-important': '#8250df',
    'markdown-alert-warning': '#9a6700',
    'markdown-alert-caution': '#cf222e',
};

// ── Main config (tool-level; brand/theme data lives in themes/, see theme.ts) ──

export const CONFIG: Config = {
    weasyprintDpi: 300,
    fetchTimeoutMs: 15_000,
    // 88 balances visual quality against embedded file size for body images.
    imageJpegQuality: 88,
    // Ceiling on any single remote fetch (a font, an icon stylesheet, an image).
    // A cap belongs here rather than hardcoded in fetch.ts: a document that
    // legitimately pulls a large asset should not need a code change, and a
    // machine that wants a tighter ceiling should not need one either.
    maxResponseBytes: 50 * 1024 * 1024,
    // Renderers fan out over every match in a document. Unbounded, a diagram-
    // heavy document opens one Chromium page (or spawns one draw.io process,
    // or decodes one full-resolution image) per match simultaneously. 4 keeps
    // the parallelism that made these fast without the thrash.
    concurrency: 4,
    // A document says which URLs get fetched, and the machine exporting it can
    // reach things the document's author cannot — a cloud metadata endpoint, an
    // intranet host, a service on localhost. Off by default; turn it on for a
    // document that legitimately pulls assets off your own network.
    allowPrivateHosts: false,
    pdfVariant: null,
    infographicIcons: 'iconify',
};

// ── Environment variable overrides ────────────────────────────────────────────
// Override config values without modifying source — useful in CI/CD.
// EXPORT_PDF_DPI, EXPORT_PDF_TIMEOUT_MS, EXPORT_PDF_IMAGE_QUALITY,
// EXPORT_PDF_CONCURRENCY, EXPORT_PDF_MAX_RESPONSE_MB.
// (Logo overrides EXPORT_PDF_LOGO[_WHITE] are applied to the active theme in theme.ts.)

/**
 * Warnings raised while reading the environment.
 *
 * These are produced at module load, which is before `setQuiet` has run and
 * before the logger is meaningfully configured — so they are collected here
 * and flushed by `main()` through `log()` instead of going straight to the
 * console. That keeps them in the right place in the output stream, with the
 * same timestamp and formatting as every other warning.
 */
export const CONFIG_WARNINGS: string[] = [];

function readIntEnv(name: string, defaultValue: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < min || n > max) {
        const range = max === Number.MAX_SAFE_INTEGER ? `min ${min}` : `${min}–${max}`;
        CONFIG_WARNINGS.push(`WARNING: ${name}="${raw}" is not a valid integer (${range}) — using default ${defaultValue}`);
        return defaultValue;
    }
    return n;
}

/** A boolean env flag: `1`/`true`/`yes`/`on` enable it, anything else leaves the default. */
function readBoolEnv(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return defaultValue;
    if (/^(1|true|yes|on)$/i.test(raw.trim()))  return true;
    if (/^(0|false|no|off)$/i.test(raw.trim())) return false;
    CONFIG_WARNINGS.push(`WARNING: ${name}="${raw}" is not a boolean (1/0, true/false, yes/no, on/off) — using default ${defaultValue}`);
    return defaultValue;
}

/** An env var restricted to a fixed set of lowercase values, e.g. PDF_VARIANTS. */
function readEnumEnv(name: string, allowed: readonly string[]): string | null {
    const raw = process.env[name];
    if (!raw) return null;
    const value = raw.trim().toLowerCase();
    if (!allowed.includes(value)) {
        CONFIG_WARNINGS.push(
            `WARNING: ${name}="${raw}" is not one of: ${allowed.join(', ')} — ignoring`);
        return null;
    }
    return value;
}

(function applyEnvOverrides() {
    CONFIG.weasyprintDpi      = readIntEnv('EXPORT_PDF_DPI',             CONFIG.weasyprintDpi);
    CONFIG.fetchTimeoutMs     = readIntEnv('EXPORT_PDF_TIMEOUT_MS',      CONFIG.fetchTimeoutMs);
    CONFIG.imageJpegQuality   = readIntEnv('EXPORT_PDF_IMAGE_QUALITY',   CONFIG.imageJpegQuality, 1, 100);
    CONFIG.concurrency        = readIntEnv('EXPORT_PDF_CONCURRENCY',     CONFIG.concurrency, 1, 64);
    CONFIG.maxResponseBytes   = readIntEnv('EXPORT_PDF_MAX_RESPONSE_MB', CONFIG.maxResponseBytes / (1024 * 1024), 1, 2048) * 1024 * 1024;
    CONFIG.allowPrivateHosts  = readBoolEnv('EXPORT_PDF_ALLOW_PRIVATE_HOSTS', CONFIG.allowPrivateHosts);
    CONFIG.pdfVariant         = readEnumEnv('EXPORT_PDF_VARIANT', PDF_VARIANTS);
    CONFIG.infographicIcons   = (readEnumEnv('EXPORT_INFOGRAPHIC_ICONS', INFOGRAPHIC_ICON_PROVIDERS)
                                 ?? CONFIG.infographicIcons) as InfographicIconProvider;
})();
