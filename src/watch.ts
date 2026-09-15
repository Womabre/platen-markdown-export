import * as fs   from 'fs';
import * as path from 'path';
import { log } from './logger';

/**
 * The `--watch` loop: re-export the document every time it changes.
 *
 * Two things make this less trivial than it looks.
 *
 * The first is that the export **writes to the document it is watching**: the
 * revision-date stamp, and on a release the revision bump. A naive watcher sees
 * its own write and re-exports forever. The guard is content, not timing —
 * `run()` returns exactly what it wrote, and a change whose content equals that
 * is this process's own. Timing-based guards (ignore events for N ms after a
 * run) look simpler and quietly drop the edit you made *during* an export;
 * comparing content cannot, because a real edit never matches what we wrote.
 *
 * The second is that the directory is watched rather than the file. Both
 * `writeFileAtomic` and most editors replace a file by renaming a new one over
 * it, which on several platforms silently detaches a watcher bound to the old
 * inode — the watch appears to work and then simply stops firing.
 *
 * The third is that a document is rarely one file. `[!include]` is a headline
 * feature, so a book is a document including parts including chapters — and
 * watching only the file named on the command line meant editing a chapter did
 * nothing until you also touched the book. Each export reports the files it
 * actually read (includes, local images, draw.io sources, the stylesheet) and
 * the watch re-points at that set afterwards, so the graph tracks the document
 * as it changes: add an include and its file is watched from the next run on.
 *
 * Watching what was *read* rather than the folder is the whole distinction —
 * an unrelated file changing beside the document still triggers nothing.
 *
 * This lives in its own module, with the filesystem and the export itself
 * injected, because none of the above was reachable from a test while it was a
 * closure inside `main()`'s file: every branch needs a real directory, a real
 * editor's write pattern and a real export to provoke. The self-write guard in
 * particular is the highest-consequence rule in the tool — it decides whether
 * the process loops forever on its own output — and it was enforced by a
 * comment.
 */

/** Coalescing window for a burst of writes — editors often save in several steps. */
export const WATCH_DEBOUNCE_MS = 250;

/** The part of `fs.FSWatcher` this module uses. */
export interface Watcher {
    close(): void;
}

/** What one export reports back: see `ExportResult` in types.ts. */
export interface RunResult {
    /** What the run wrote back to the source document — the self-write guard. */
    sourceWritten: string | null;
    /** Every other file the run read. Watched from the next event onwards. */
    dependencies?: readonly string[];
}

export interface WatchDeps {
    /** One export. */
    run: () => Promise<RunResult>;
    /**
     * Reports a failed run. A failure must never end the watch: the usual cause
     * is a typo in the frontmatter that the next save fixes.
     */
    onError: (err: unknown) => void;
    /** Directory watcher. Defaults to `fs.watch`. One per directory watched. */
    watch?: (dir: string, listener: (event: string, filename: string | null) => void) => Watcher;
    /** Reads the watched document. Defaults to a utf8 `readFileSync`. */
    readFile?: (file: string) => string;
    /** Overrides {@link WATCH_DEBOUNCE_MS}. */
    debounceMs?: number;
}

export interface WatchHandle {
    /** Stops watching and cancels any pending run. Safe to call more than once. */
    close(): void;
}

/**
 * Starts watching `inputFile`, running an initial export immediately.
 *
 * Returns as soon as the watch is installed — the initial run continues in the
 * background — so the caller owns the "run until interrupted" part and this
 * function stays a unit.
 */
export function startWatch(inputFile: string, deps: WatchDeps): WatchHandle {
    const resolved = path.resolve(inputFile);
    const base     = path.basename(resolved);

    const watchDir   = deps.watch ?? ((d, listener) => fs.watch(d, listener));
    const readFile   = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
    const debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;

    /** What this process last wrote to the source — never a reason to re-export. */
    let selfWrite: string | null = null;
    let running = false;
    let queued  = false;
    let closed  = false;
    let timer: NodeJS.Timeout | null = null;

    /** Absolute paths a change to which should re-export. Grows after the first run. */
    let interesting = new Set<string>([resolved]);
    /** One watcher per directory holding an interesting file. */
    const watchers = new Map<string, Watcher>();

    const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            if (running) { queued = true; return; }
            void runOnce();
        }, debounceMs);
    };

    /**
     * Handles one directory's events.
     *
     * `filename` is relative to the directory that fired, which is why the
     * listener is built per directory rather than shared: two watched folders can
     * both contain a `chapter.md` and only one of them is ours.
     */
    const listenerFor = (dir: string) => (_event: string, filename: string | null): void => {
        if (closed || filename === null) return;
        const changed = path.join(dir, filename);
        if (!interesting.has(changed)) return;

        // The self-write guard applies to the source document alone: it is the
        // only file the export writes, so it is the only one whose change can be
        // ours. An include or an image changing is always someone else.
        if (changed === resolved) {
            let current: string;
            try { current = readFile(resolved); }
            catch { return; }                 // mid-rename; the next event has it
            if (current === selfWrite) return;
        }
        schedule();
    };

    /**
     * Re-points the watchers at the files the last export actually read.
     *
     * Directories, not files: `writeFileAtomic` and most editors replace a file
     * by renaming a new one over it, which silently detaches an inode-bound
     * watcher. One watcher per directory covers every interesting file in it.
     */
    const watchDependencies = (files: readonly string[]): void => {
        if (closed) return;
        interesting = new Set<string>([resolved, ...files.map(f => path.resolve(f))]);

        const wanted = new Set([...interesting].map(f => path.dirname(f)));
        for (const dir of wanted) {
            if (watchers.has(dir)) continue;
            // A dependency can live somewhere unreadable, or be deleted between
            // the run and this call. One unwatchable directory must not take the
            // whole watch down with it.
            try { watchers.set(dir, watchDir(dir, listenerFor(dir))); }
            catch { /* not watchable — its changes simply do not trigger a run */ }
        }
        for (const [dir, watcher] of watchers) {
            if (wanted.has(dir)) continue;
            watcher.close();
            watchers.delete(dir);
        }
    };

    const runOnce = async (): Promise<void> => {
        running = true;
        try {
            const result = await deps.run();
            selfWrite = result.sourceWritten ?? selfWrite;
            // Only when the run got far enough to report them: a failed export,
            // or one with no Mode set, reads nothing and must not drop the set
            // built by the run before it.
            if (result.dependencies?.length) watchDependencies(result.dependencies);
        } catch (err: unknown) {
            deps.onError(err);
        } finally {
            running = false;
        }
        // A change that landed mid-run is honoured once, after it — not dropped,
        // and not run concurrently with the export that was already going.
        if (queued && !closed) { queued = false; void runOnce(); }
    };

    watchDependencies([]);   // the document itself, before the first run
    log(`Watching ${base} for changes — press Ctrl-C to stop`);
    void runOnce();

    return {
        close: () => {
            if (closed) return;
            closed = true;
            queued = false;
            if (timer) { clearTimeout(timer); timer = null; }
            for (const watcher of watchers.values()) watcher.close();
            watchers.clear();
        },
    };
}
