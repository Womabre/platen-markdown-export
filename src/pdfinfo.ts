import * as fs   from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** Above this, the page scan is skipped rather than pulling the file into memory. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Ceiling on inflated output, so a zip-bomb-shaped PDF cannot exhaust memory. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * Concatenates every Flate-compressed stream in the file that inflates cleanly.
 *
 * Object streams hold the dictionaries — including the page tree — that a byte
 * scan would otherwise never see. Streams that are not deflate (images, fonts,
 * encrypted content) simply throw and are skipped, which is why this is a
 * best-effort scan rather than a real PDF parse: it needs no object graph, only
 * whatever inflates.
 */
function inflateStreams(buffer: Buffer, raw: string): string {
    const parts: string[] = [];
    let budget = MAX_INFLATED_BYTES;

    // `(?<!end)` matters: "endstream\n" ends in "stream\n", so a bare pattern
    // matched every stream twice — once at its start and once at its terminator —
    // and spent an inflate attempt on the garbage that followed.
    const re = /(?<!end)stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null && budget > 0) {
        const start = m.index + m[0].length;
        const end   = raw.indexOf('endstream', start);
        if (end === -1) continue;
        try {
            const out = zlib.inflateSync(buffer.subarray(start, end), { maxOutputLength: budget });
            budget -= out.length;
            parts.push(out.toString('latin1'));
        } catch {
            // Not a deflate stream (image, font, encrypted) — nothing to read.
        }
    }
    return parts.join('\n');
}

/**
 * Counts the pages in a PDF, or returns null when it cannot be determined.
 *
 * Two signals, in order of reliability:
 *   1. The page tree root's `/Count`, which states the total outright.
 *   2. Failing that, one `/Type /Page` dictionary per page.
 *
 * Both only work while those dictionaries sit in the file as plain bytes. A
 * producer that packs them into compressed object streams (`/ObjStm`) leaves
 * neither visible, and the honest answer is then "unknown" — hence the null,
 * which callers must render as *no* page count rather than as zero.
 *
 * The previous implementation scanned only the last 512 KB and always returned
 * a number, so a long document silently reported too few pages.
 */
export function countPdfPages(buffer: Buffer): number | null {
    // latin1 maps bytes 1:1 to code units, so offsets and matches stay byte-exact
    // on the binary streams between the dictionaries.
    const raw = buffer.toString('latin1');

    // WeasyPrint packs its object dictionaries into Flate-compressed object
    // streams, so on its own output none of the markers below exist as plain
    // bytes — scanning `raw` alone always yields "unknown". Inflating first is
    // what makes the count work on the files this tool actually produces.
    const text = /\/ObjStm/.test(raw) ? raw + '\n' + inflateStreams(buffer, raw) : raw;

    const counts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,500}?\/Count\s+(\d+)/g)]
        .map(m => parseInt(m[1], 10))
        .filter(n => Number.isFinite(n) && n > 0);
    // The root of the page tree carries the document total; any other /Pages node
    // is a subtree with a smaller count.
    if (counts.length) return Math.max(...counts);

    // `(?![s\w])` keeps /Type /Pages and /Type /PageLabel out of a /Page count.
    const pageObjects = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    return pageObjects > 0 ? pageObjects : null;
}

/**
 * One-line summary of a generated PDF: filename, page count where it can be
 * established, and size in MB. The page count is omitted rather than guessed.
 */
export function summarizePdf(pdfPath: string): string {
    const stat   = fs.statSync(pdfPath);
    const sizeMb = (stat.size / 1_048_576).toFixed(1);
    const name   = path.basename(pdfPath);

    let pages: number | null = null;
    if (stat.size <= MAX_SCAN_BYTES) {
        try {
            pages = countPdfPages(fs.readFileSync(pdfPath));
        } catch { /* unreadable — fall through to size-only */ }
    }

    return pages === null
        ? `✔ ${name} — ${sizeMb} MB`
        : `✔ ${name} — ${pages} page${pages === 1 ? '' : 's'}, ${sizeMb} MB`;
}
