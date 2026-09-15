import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log, logResult, setQuiet , warningCount, resetWarnings } from '../logger';
import * as fs from 'fs';
import * as path from 'path';

// Colour is only emitted on a TTY, but strip it anyway so the assertions hold
// whether or not the suite is run through a pipe.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// `lines` is stdout; `errLines` is stderr. Warnings go to the latter, so a
// script can pipe the progress trace away and still see what went wrong.
let lines: string[];
let errLines: string[];
let realLog: typeof console.log;
let realError: typeof console.error;

beforeEach(() => {
    lines = [];
    errLines = [];
    realLog = console.log;
    realError = console.error;
    console.log   = (...a: unknown[]) => { lines.push(strip(a.map(String).join(' '))); };
    console.error = (...a: unknown[]) => { errLines.push(strip(a.map(String).join(' '))); };
});

afterEach(() => {
    console.log = realLog;
    console.error = realError;
    setQuiet(false);
});

describe('log', () => {
    it('prints the message behind an elapsed-time stamp', () => {
        log('Doing a thing');
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^\s*\d+\.\ds\s/);
        assert.ok(lines[0].includes('Doing a thing'));
    });

    it('right-aligns the stamp so messages line up', () => {
        log('one');
        log('two');
        const width = (l: string) => l.length - l.trimStart().length + l.trimStart().indexOf('s') + 1;
        assert.equal(width(lines[0]), width(lines[1]));
    });

    it('reports elapsed seconds, not a wall-clock date', () => {
        log('x');
        assert.ok(!/\d{4}-\d{2}-\d{2}/.test(lines[0]), lines[0]);
        const seconds = parseFloat(lines[0].trim());
        assert.ok(Number.isFinite(seconds) && seconds >= 0, lines[0]);
    });

    it('marks section headers', () => {
        log('=== Export started ===');
        assert.ok(lines[0].includes('=== Export started ==='));
    });

    it('marks warnings and sends them to stderr, not stdout', () => {
        log('WARNING: something is off');
        assert.deepEqual(lines, [], 'a warning must not land on stdout');
        assert.equal(errLines.length, 1);
        assert.ok(errLines[0].includes('WARNING: something is off'));
        assert.ok(errLines[0].includes('⚠'));
    });

    it('keeps ordinary progress on stdout', () => {
        log('Inlining images...');
        assert.equal(lines.length, 1);
        assert.deepEqual(errLines, []);
    });

    it('formats "Key   : value" summary lines', () => {
        log('Theme      : Default');
        assert.ok(lines[0].includes('Theme'));
        assert.ok(lines[0].includes('Default'));
    });
});

describe('quiet mode', () => {
    it('suppresses ordinary progress lines', () => {
        setQuiet(true);
        log('Inlining images...');
        assert.deepEqual(lines, []);
    });

    it('still prints warnings — the whole point of the exemption', () => {
        setQuiet(true);
        log('WARNING: missing image');
        assert.deepEqual(lines, []);
        assert.equal(errLines.length, 1);
        assert.ok(errLines[0].includes('missing image'));
    });

    it('never suppresses the result line, and keeps it on stdout', () => {
        setQuiet(true);
        logResult('✔ doc.pdf — 3 pages, 1.2 MB');
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes('doc.pdf'));
        assert.deepEqual(errLines, [], 'the result is output, not a diagnostic');
    });

    it('is reversible', () => {
        setQuiet(true);
        log('hidden');
        setQuiet(false);
        log('shown');
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes('shown'));
    });
});


// ── Warning counting (--strict) ───────────────────────────────────────────────

describe('warningCount', () => {
    // Counted in the logger rather than at each of the forty call sites, so a
    // warning nobody thought to register still fails a --strict build.
    it('counts WARNING lines and nothing else', () => {
        resetWarnings();
        log('Converting Markdown → HTML: doc.md');
        log('=== Export started ===');
        assert.equal(warningCount(), 0);

        log('WARNING: Include file not found, skipping: x.md');
        log('WARNING: Failed to inline image y.png');
        assert.equal(warningCount(), 2);
    });

    it('counts a warning even in quiet mode, where it is still printed', () => {
        resetWarnings();
        setQuiet(true);
        log('WARNING: something');
        log('an ordinary progress line that quiet suppresses');
        setQuiet(false);
        assert.equal(warningCount(), 1);
    });

    it('resets per run, so a --watch loop judges each export on its own', () => {
        resetWarnings();
        log('WARNING: first run');
        assert.equal(warningCount(), 1);
        resetWarnings();
        assert.equal(warningCount(), 0);
    });
});


// ── The warning contract, enforced across the source ──────────────────────────

describe('every warning in src/ is actually counted', () => {
    // `log()` counts a warning by looking for `WARNING:` at the START of the
    // message. That makes the contract a naming convention, and a convention
    // with forty call sites is one that will eventually be broken by whitespace:
    // `drawio.ts` logged `  WARNING: draw.io file not found: …` with two leading
    // spaces, so the line was never counted, never reached stderr, and vanished
    // under `--quiet` — while reading, in the source, exactly like the thirty-nine
    // that worked.
    //
    // Nothing mechanical can tell whether a given failure DESERVES a warning.
    // This catches the narrower thing that actually went wrong: a line that says
    // WARNING and does not behave like one.

    const SRC = path.join(__dirname, '..', '..', 'src');

    const sources = fs.readdirSync(SRC)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
        .map(f => ({ name: f, text: fs.readFileSync(path.join(SRC, f), 'utf8') }));

    it('reads the source tree it is asserting against', () => {
        // A wrong path would make every assertion below vacuously true.
        assert.ok(sources.length > 10, `expected the src/ modules, found ${sources.length}`);
        assert.ok(sources.some(s => s.name === 'logger.ts'));
    });

    it('never indents a WARNING, which would stop it being counted', () => {
        // Any string or template literal whose content opens with whitespace and
        // then WARNING — the shape of the bug, independent of the call wrapping it.
        const offenders: string[] = [];
        for (const { name, text } of sources) {
            text.split('\n').forEach((line, i) => {
                if (/['"`]\s+WARNING:/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
            });
        }
        assert.deepEqual(offenders, [],
            'a WARNING: preceded by whitespace is not counted by log() — put it at column zero');
    });

    it('agrees with the prefix log() actually tests for', () => {
        // If the prefix ever changes, the scan above must change with it. This
        // fails loudly rather than silently passing on a stale pattern.
        resetWarnings();
        log('WARNING: counted');
        log('  WARNING: not counted');
        assert.equal(warningCount(), 1,
            'the indented form is the failure this scan exists to prevent');
    });
});
