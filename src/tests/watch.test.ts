import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { startWatch, WATCH_DEBOUNCE_MS, type Watcher } from '../watch';
import { setQuiet } from '../logger';

/**
 * The `--watch` loop.
 *
 * Every rule in here was previously enforced by a comment: the self-write guard
 * that stops the export looping on its own revision stamp, the debounce that
 * collapses an editor's multi-step save, the queue that neither drops nor
 * doubles a change landing mid-export, and the promise that a failed run does
 * not end the watch. All four are invisible when they break — the process just
 * spins, or quietly stops re-exporting — which is exactly the shape of bug that
 * needs a test rather than a reader.
 *
 * The filesystem and the export are injected, so none of this touches a disk or
 * runs WeasyPrint: the fake watcher hands us its listener to fire by hand, and
 * the fake export resolves when we say so.
 */

setQuiet(true);

const DOC = path.resolve('/docs/report.md');
const DIR = path.dirname(DOC);
const BASE = path.basename(DOC);

/** Debounce short enough to keep the suite fast, long enough to coalesce a burst. */
const TICK = 10;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Lets a scheduled run fire and settle. */
const settle = (): Promise<void> => sleep(TICK * 4);

/** A promise with its resolver exposed, for holding a run open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

interface Harness {
    /** Fires a change event for a file, on the watcher for `dir` (default: the document's). */
    fire(filename?: string | null, dir?: string): void;
    /** Content the fake `readFile` returns; throws when set to an Error. */
    setContent(content: string | Error): void;
    /** Every directory `watch()` was called with. */
    watchedDirs: string[];
    /** Number of times the watcher was closed. */
    closes: number;
    /** Resolved values from each completed run, in order. */
    runs: number;
}

/**
 * Builds a watch under a fake filesystem.
 *
 * @param run What one export does. Receives the 1-based run number so a test
 *            can make a specific run hang or fail.
 */
function harness(run: (n: number) => Promise<{ sourceWritten: string | null; dependencies?: string[] }>) {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    let content: string | Error = 'original';
    const state: Harness = { fire: () => {}, setContent: () => {}, watchedDirs: [], closes: 0, runs: 0 };
    const errors: unknown[] = [];

    const watcher: Watcher = { close: () => { state.closes++; } };

    const handle = startWatch(DOC, {
        run: () => { state.runs++; return run(state.runs); },
        onError: (err) => errors.push(err),
        watch: (dir, l) => { state.watchedDirs.push(dir); listeners.set(dir, l); return watcher; },
        readFile: () => { if (content instanceof Error) { throw content; } return content; },
        debounceMs: TICK,
    });

    state.fire = (filename = BASE, dir = DIR) => listeners.get(dir)?.('change', filename);
    state.setContent = (c) => { content = c; };

    return { handle, state, errors };
}

describe('startWatch', () => {
    it('watches the directory, not the file — an atomic rename detaches an inode watch', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();
        assert.deepEqual(state.watchedDirs, [DIR]);
        handle.close();
    });

    it('runs an export immediately, before any change', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();
        assert.equal(state.runs, 1);
        handle.close();
    });

    it('re-exports when the document changes', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();

        state.setContent('edited');
        state.fire();
        await settle();

        assert.equal(state.runs, 2);
        handle.close();
    });

    it('coalesces a burst of writes into a single run', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();

        // An editor saving in several steps, all inside the debounce window.
        for (let i = 0; i < 5; i++) { state.setContent(`edit ${i}`); state.fire(); }
        await settle();

        assert.equal(state.runs, 2, 'the initial run plus one for the whole burst');
        handle.close();
    });

    it('ignores a change to another file in the same directory', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();

        state.setContent('edited');
        state.fire('other.md');
        state.fire(null);
        await settle();

        assert.equal(state.runs, 1);
        handle.close();
    });

    it('ignores its own write-back — the revision stamp must not re-trigger', async () => {
        // What main() returns is what it wrote to the source document.
        const { handle, state } = harness(async () => ({ sourceWritten: 'stamped' }));
        await settle();
        assert.equal(state.runs, 1);

        // The stamp lands: the watcher sees a change whose content is ours.
        state.setContent('stamped');
        state.fire();
        await settle();

        assert.equal(state.runs, 1, 'the export must not loop on its own write');
        handle.close();
    });

    it('still re-exports a real edit made after a write-back', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: 'stamped' }));
        await settle();

        state.setContent('stamped');
        state.fire();                 // ours — ignored
        await settle();

        state.setContent('a genuine edit');
        state.fire();                 // not ours — runs
        await settle();

        assert.equal(state.runs, 2);
        handle.close();
    });

    it('remembers the last write-back when a later run writes nothing', async () => {
        // Run 1 stamps; run 2 has nothing to write and returns null. Null must
        // not clear the guard, or the stamp from run 1 reads as a foreign edit.
        const { handle, state } = harness(async (n) => ({ sourceWritten: n === 1 ? 'stamped' : null }));
        await settle();

        state.setContent('edited');
        state.fire();
        await settle();
        assert.equal(state.runs, 2);

        state.setContent('stamped');
        state.fire();
        await settle();
        assert.equal(state.runs, 2, 'run 1\'s write-back is still recognised as ours');
        handle.close();
    });

    it('ignores an unreadable file — the event mid-rename has no content yet', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();

        state.setContent(new Error('ENOENT'));
        state.fire();
        await settle();

        assert.equal(state.runs, 1);
        handle.close();
    });

    it('queues a change that lands during an export and runs it once, after', async () => {
        const first = deferred<{ sourceWritten: string | null }>();
        const { handle, state } = harness((n) => (n === 1 ? first.promise : Promise.resolve({ sourceWritten: null })));
        await sleep(TICK);            // run 1 is in flight and will not resolve yet

        state.setContent('edited during the export');
        state.fire();
        state.fire();
        await settle();
        assert.equal(state.runs, 1, 'no concurrent export while one is running');

        first.resolve({ sourceWritten: null });
        await settle();
        assert.equal(state.runs, 2, 'the queued change runs exactly once afterwards');

        await settle();
        assert.equal(state.runs, 2, 'and is not replayed');
        handle.close();
    });

    it('keeps watching after a failed export', async () => {
        const boom = new Error('frontmatter is not valid YAML');
        const { handle, state, errors } = harness((n) => (n === 1 ? Promise.reject(boom) : Promise.resolve({ sourceWritten: null })));
        await settle();

        assert.deepEqual(errors, [boom], 'the failure is reported, not thrown');

        state.setContent('the typo, fixed');
        state.fire();
        await settle();

        assert.equal(state.runs, 2, 'a failed run must not end the watch');
        handle.close();
    });

    it('close() closes the watcher and cancels a pending run', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();

        state.setContent('edited');
        state.fire();                 // scheduled, inside the debounce window
        handle.close();               // …and cancelled before it fires
        await settle();

        assert.equal(state.runs, 1);
        assert.equal(state.closes, 1);
    });

    it('close() is idempotent', async () => {
        const { handle, state } = harness(async () => ({ sourceWritten: null }));
        await settle();
        handle.close();
        handle.close();
        assert.equal(state.closes, 1);
    });

    it('close() stops a change queued behind a running export from firing', async () => {
        const first = deferred<{ sourceWritten: string | null }>();
        const { handle, state } = harness((n) => (n === 1 ? first.promise : Promise.resolve({ sourceWritten: null })));
        await sleep(TICK);

        state.setContent('edited');
        state.fire();
        await settle();               // queued behind run 1

        handle.close();
        first.resolve({ sourceWritten: null });
        await settle();

        assert.equal(state.runs, 1, 'nothing starts after the watch is closed');
    });

    it('defaults to a debounce long enough for an editor\'s multi-step save', () => {
        assert.ok(WATCH_DEBOUNCE_MS >= 100, 'a shorter window would export mid-save');
    });

    it('falls back to the real filesystem when no seams are injected', async () => {
        // Everything above injects all three seams, so the defaults they stand in
        // for — fs.watch, readFileSync, WATCH_DEBOUNCE_MS — would otherwise never
        // run. This exercises them against a real directory, without depending on
        // the platform's watch events: it asserts only the initial export.
        const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-watch-'));
        const file = path.join(dir, 'doc.md');
        fs.writeFileSync(file, 'original');

        let runs = 0;
        const handle = startWatch(file, {
            run:     async () => { runs++; return { sourceWritten: null }; },
            onError: (err) => { throw err; },
        });

        try {
            await settle();
            assert.equal(runs, 1);
        } finally {
            handle.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── Dependencies ──────────────────────────────────────────────────────────────
//
// A document is rarely one file. `[!include]` is a headline feature, so a book
// is a document including parts including chapters — and watching only the file
// named on the command line meant editing a chapter did nothing until you also
// touched the book. Each export reports what it read; the watch follows.

describe('startWatch dependencies', () => {
    const INCLUDE_DIR = path.resolve('/docs/chapters');
    const INCLUDE     = path.join(INCLUDE_DIR, 'one.md');

    /** A run that reports one include, in another directory. */
    const withInclude = async () => ({ sourceWritten: null, dependencies: [INCLUDE] });

    it('watches the directory of a file the export read', async () => {
        const { handle, state } = harness(withInclude);
        await settle();
        assert.ok(state.watchedDirs.includes(INCLUDE_DIR), state.watchedDirs.join(', '));
        handle.close();
    });

    it('re-exports when an included file changes', async () => {
        const { handle, state } = harness(withInclude);
        await settle();
        assert.equal(state.runs, 1);

        state.fire('one.md', INCLUDE_DIR);
        await settle();

        assert.equal(state.runs, 2, 'editing a chapter re-exports the book');
        handle.close();
    });

    it('does not re-export for an unrelated file beside a dependency', async () => {
        // Watching what was *read*, not the folder: a directory watcher fires for
        // everything in it, and only the files the export used may count.
        const { handle, state } = harness(withInclude);
        await settle();

        state.fire('scratch.md', INCLUDE_DIR);
        await settle();

        assert.equal(state.runs, 1);
        handle.close();
    });

    it('does not read the document when a dependency changes', async () => {
        // The self-write guard is about the one file the export writes. Applying
        // it to an include would compare the wrong file's contents and drop the
        // event whenever the document happened to match its last write-back.
        const { handle, state } = harness(async () => ({ sourceWritten: 'stamped', dependencies: [INCLUDE] }));
        await settle();

        state.setContent('stamped');            // the document is at our own write
        state.fire('one.md', INCLUDE_DIR);      // but the *include* changed
        await settle();

        assert.equal(state.runs, 2, 'an include change is never our own write');
        handle.close();
    });

    it('follows the graph as it changes — a dropped include stops being watched', async () => {
        const OTHER_DIR = path.resolve('/docs/appendix');
        let deps = [INCLUDE];
        const { handle, state } = harness(async () => ({ sourceWritten: null, dependencies: deps }));
        await settle();

        deps = [path.join(OTHER_DIR, 'a.md')];  // the document now includes something else
        state.setContent('edited');
        state.fire();
        await settle();
        assert.equal(state.runs, 2);

        assert.ok(state.watchedDirs.includes(OTHER_DIR), 'the new include is watched');
        state.fire('one.md', INCLUDE_DIR);
        await settle();
        assert.equal(state.runs, 2, 'the include it no longer uses is not');
        handle.close();
    });

    it('keeps the previous set when a run reports nothing', async () => {
        // A failed export, or one with no Mode set, reads nothing — that must not
        // be read as "this document has no dependencies any more".
        let first = true;
        const { handle, state } = harness(async () => {
            const deps = first ? [INCLUDE] : [];
            first = false;
            return { sourceWritten: null, dependencies: deps };
        });
        await settle();

        state.setContent('edited');
        state.fire();
        await settle();                          // run 2 reports no dependencies

        state.fire('one.md', INCLUDE_DIR);
        await settle();
        assert.equal(state.runs, 3, 'the include is still watched');
        handle.close();
    });

    it('survives a dependency in a directory that cannot be watched', async () => {
        const listeners = new Map<string, (e: string, f: string | null) => void>();
        let runs = 0;
        const handle = startWatch(DOC, {
            run: async () => { runs++; return { sourceWritten: null, dependencies: ['/nope/gone.md'] }; },
            onError: (err) => { throw err; },
            watch: (dir, l) => {
                if (dir === path.resolve('/nope')) { throw new Error('ENOENT'); }
                listeners.set(dir, l);
                return { close: () => {} };
            },
            readFile: () => 'edited',
            debounceMs: TICK,
        });
        await settle();

        listeners.get(DIR)?.('change', BASE);
        await settle();

        assert.equal(runs, 2, 'one unwatchable directory must not take the watch down');
        handle.close();
    });
});
