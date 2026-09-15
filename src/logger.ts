let _quiet = false;

// Colour is decided per stream: piping stdout to a file while stderr stays a
// terminal (or the reverse) is exactly what the split below invites.
const stdoutTTY = Boolean(process.stdout.isTTY);
const stderrTTY = Boolean(process.stderr.isTTY);

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const A = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    red:    '\x1b[31m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
    gray:   '\x1b[90m',
} as const;

function clr(code: string, text: string, tty: boolean): string {
    return tty ? `${code}${text}${A.reset}` : text;
}

function colorize(message: string, tty: boolean): string {
    // === Section headers ===
    if (message.startsWith('==='))
        return clr(A.bold + A.cyan, `\n  ${message}\n`, tty);

    // Warnings
    if (message.startsWith('WARNING:'))
        return clr(A.yellow, `⚠  ${message}`, tty);

    // WeasyPrint stderr errors
    if (/^stderr:.*error/i.test(message))
        return clr(A.red, `✖  ${message}`, tty);

    // WeasyPrint stderr (warnings / suppressed counts)
    if (message.startsWith('stderr'))
        return clr(A.dim + A.yellow, `   ${message}`, tty);

    // HTTP server 404s (missing assets)
    if (message.startsWith('Server 404:'))
        return clr(A.yellow, `⚠  ${message}`, tty);

    // Key     : value startup-summary lines (2+ spaces before the colon)
    const kv = message.match(/^(\w[\w ]+?\s{2,}:\s*)(.+)$/);
    if (kv)
        return `   ${clr(A.dim, kv[1], tty)}${kv[2]}`;

    // Indented sub-detail lines
    if (message.startsWith('  '))
        return clr(A.dim, message, tty);

    // Default: progress step
    return `${clr(A.cyan, '›', tty)} ${message}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enable or disable quiet mode.
 * When quiet, `log()` suppresses all output except WARNING lines.
 * The final result line is always printed via `logResult()` and is never suppressed.
 */
export function setQuiet(quiet: boolean): void { _quiet = quiet; }

/**
 * Warnings raised so far, for `--strict`.
 *
 * Counted here rather than at each call site because there are forty of them and
 * a new one must not have to remember to register itself — the whole point of
 * `--strict` is that a problem nobody thought about still fails the build.
 * Reset per run so a `--watch` loop judges each export on its own.
 */
let _warnings = 0;
export function warningCount(): number { return _warnings; }
export function resetWarnings(): void { _warnings = 0; }

/**
 * Seconds since the process started, right-aligned so the messages line up.
 *
 * This log is a progress trace, and what a reader wants from it is which stage
 * cost the time — not the wall-clock date, which is identical on every line of
 * a run and eats eleven columns saying so.
 */
function stamp(): string {
    return `${process.uptime().toFixed(1).padStart(6)}s`;
}

/**
 * Progress and warnings.
 *
 * Warnings go to **stderr**, everything else to stdout. They are the one
 * category that survives `--quiet`, which is a strong hint about who reads
 * them: a script piping the progress trace to a file, or discarding it, still
 * wants the warnings on the terminal. Keeping them on stdout meant
 * `export -q > log.txt` swallowed exactly the lines worth seeing.
 *
 * The result line stays on stdout — it is the command's output, not a
 * diagnostic, and the VS Code extension reads it from there.
 */
export function log(message: string): void {
    const isWarning = message.startsWith('WARNING:');
    if (isWarning) _warnings++;
    if (_quiet && !isWarning) return;

    const tty  = isWarning ? stderrTTY : stdoutTTY;
    const line = `${clr(A.gray, stamp(), tty)}  ${colorize(message, tty)}`;
    if (isWarning) console.error(line);
    else           console.log(line);
}

/**
 * A disclosure the user must see, that is not a problem with the document.
 *
 * Sent where warnings go — stderr, surviving `--quiet` — but deliberately NOT
 * counted: `--strict` refuses documents with broken references, and a policy
 * the user chose on purpose (sending icon queries to a third party, say) is
 * neither. Counting it would make that choice unusable under `--strict`.
 */
export function logNotice(message: string): void {
    console.error(`${clr(A.gray, stamp(), stderrTTY)}  ${clr(A.yellow, `ℹ  NOTICE: ${message}`, stderrTTY)}`);
}

/** Always-visible final result line — bold green, bypasses quiet mode. */
export function logResult(message: string): void {
    console.log(`\n${clr(A.bold + A.green, `  ${message}`, stdoutTTY)}\n`);
}
