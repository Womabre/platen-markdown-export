import { runBootstrap } from './bootstrap';
import { setupStatus, formatSetupStatus } from './setup-status';
import { clearCache } from './cache';
import { logResult, setQuiet } from './logger';

/**
 * The flags that run a command of their own instead of an export.
 *
 * `--setup`, `--check-setup` and `--clear-cache` read no document: the first
 * installs the runtime dependencies, the second reports what the first would
 * install, the third empties the asset cache. They used to be three `if` blocks
 * at the top of `main()`, which made their precedence and `--check-setup
 * --json`'s quiet stdout reachable only through a whole `main()` call that
 * could, on a wrong branch, install WeasyPrint on the test machine. With the
 * side effects injected they are tested on their own.
 */
export interface StandaloneFlags {
    setup: boolean;
    checkSetup: boolean;
    json: boolean;
    clearCache: boolean;
}

export interface StandaloneDeps {
    runBootstrap: () => void;
    setupStatus: typeof setupStatus;
    formatSetupStatus: typeof formatSetupStatus;
    clearCache: () => { dir: string; existed: boolean };
    logResult: (text: string) => void;
    setQuiet: (quiet: boolean) => void;
}

const REAL_DEPS: StandaloneDeps = { runBootstrap, setupStatus, formatSetupStatus, clearCache, logResult, setQuiet };

/**
 * The standalone command the flags name, ready to run — or null when they name
 * none and the export should go ahead.
 *
 * Returns the command rather than running it so the export path never awaits
 * here. `main()` reads the source document before its first `await`, and the
 * tests for an edit that lands mid-export depend on that: an `await` this early
 * would let their concurrent write land before the read instead of during the
 * export.
 */
export function standaloneCommand(
    flags: StandaloneFlags,
    deps: StandaloneDeps = REAL_DEPS,
): (() => Promise<void>) | null {
    if (flags.setup) return async () => { deps.runBootstrap(); };

    if (flags.checkSetup) return async () => {
        // The extension parses --json from stdout, so detection's own progress
        // lines ("draw.io CLI: …") must not land there first. Warnings still
        // reach stderr.
        if (flags.json) deps.setQuiet(true);
        const components = await deps.setupStatus();
        deps.logResult(flags.json
            ? JSON.stringify({ components }, null, 2)
            : deps.formatSetupStatus(components).split('\n').join('\n  '));
    };

    // Nothing in the cache is authored by anyone — every entry is a re-fetchable
    // remote asset — so this needs no confirmation and loses nothing but the
    // next export's speed.
    if (flags.clearCache) return async () => {
        const { dir, existed } = deps.clearCache();
        deps.logResult(existed ? `✔ Cache cleared: ${dir}` : `Nothing to clear — no cache at ${dir}`);
    };

    return null;
}
