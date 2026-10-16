import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { standaloneCommand, type StandaloneDeps, type StandaloneFlags } from '../commands';

/** Runs the named command, reporting whether there was one. */
async function run(flags: StandaloneFlags, deps: StandaloneDeps): Promise<boolean> {
    const command = standaloneCommand(flags, deps);
    if (command) await command();
    return command !== null;
}

/** Fakes for every side effect, recording what was called. */
function fakes(cacheExisted = true): { deps: StandaloneDeps; calls: string[]; output: string[] } {
    const calls: string[] = [];
    const output: string[] = [];
    const deps: StandaloneDeps = {
        runBootstrap:      () => { calls.push('bootstrap'); },
        setupStatus:       async () => { calls.push('status'); return []; },
        formatSetupStatus: () => 'line one\nline two',
        clearCache:        () => { calls.push('clear'); return { dir: '/cache', existed: cacheExisted }; },
        logResult:         (text) => { output.push(text); },
        setQuiet:          (q) => { calls.push(`quiet:${q}`); },
    };
    return { deps, calls, output };
}

const none: StandaloneFlags = { setup: false, checkSetup: false, json: false, clearCache: false };

describe('standaloneCommand', () => {
    it('runs nothing and lets the export go ahead when no command is named', async () => {
        const { deps, calls, output } = fakes();
        assert.equal(await run(none, deps), false);
        assert.deepEqual(calls, []);
        assert.deepEqual(output, []);
    });

    it('decides synchronously and runs nothing until called', () => {
        // main() must not await before it reads the document; see commands.ts.
        const { deps, calls } = fakes();
        assert.equal(standaloneCommand(none, deps), null);
        assert.equal(typeof standaloneCommand({ ...none, setup: true }, deps), 'function');
        assert.deepEqual(calls, []);
    });

    it('--setup installs and stops, ahead of the others', async () => {
        const { deps, calls } = fakes();
        assert.equal(await run({ ...none, setup: true, checkSetup: true, clearCache: true }, deps), true);
        assert.deepEqual(calls, ['bootstrap']);
    });

    it('--check-setup reports and installs nothing', async () => {
        const { deps, calls, output } = fakes();
        assert.equal(await run({ ...none, checkSetup: true, clearCache: true }, deps), true);
        assert.deepEqual(calls, ['status']);
        assert.deepEqual(output, ['line one\n  line two']);
    });

    it('--check-setup --json goes quiet first, so stdout carries only the JSON', async () => {
        const { deps, calls, output } = fakes();
        await run({ ...none, checkSetup: true, json: true }, deps);
        assert.deepEqual(calls, ['quiet:true', 'status']);
        assert.deepEqual(JSON.parse(output[0]), { components: [] });
    });

    it('--clear-cache says whether there was anything to clear', async () => {
        for (const existed of [true, false]) {
            const { deps, output } = fakes(existed);
            assert.equal(await run({ ...none, clearCache: true }, deps), true);
            assert.match(output[0], existed ? /Cache cleared: \/cache/ : /Nothing to clear/);
        }
    });
});
