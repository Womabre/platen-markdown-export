import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code and runs the integration suite inside it.
 *
 * Reuses an already-installed VS Code when there is one. `runTests` will
 * otherwise download a build (~150 MB) on first run, which is the right default
 * on a CI runner and a poor one on a laptop that has the editor open.
 *
 * `--user-data-dir` is a scratch profile: without it the run inherits the
 * developer's own settings, and `platenMarkdownExport.theme` set to a brand
 * theme would quietly change what the wizard test asserts. Isolation is what
 * makes the result mean the same thing on every machine.
 */

/** An installed VS Code's Electron binary, or null to let the harness download one. */
function installedVSCode(): string | null {
    const candidates = process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : process.platform === 'win32'
            ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')]
            : ['/usr/share/code/code', '/usr/bin/code', '/snap/bin/code'];
    return candidates.find(c => c && fs.existsSync(c)) ?? null;
}

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
    const extensionTestsPath       = path.resolve(__dirname, 'suite', 'index.js');
    // The repository, so the extension's CLI resolution finds the freshly built
    // dist/index.js — the thing under test — rather than whatever is on PATH.
    const workspacePath            = path.resolve(extensionDevelopmentPath, '..');

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmex-vscode-profile-'));

    try {
        await runTests({
            vscodeExecutablePath: installedVSCode() ?? undefined,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspacePath,
                '--user-data-dir', userDataDir,
                // Another extension's prompts and its own activation cost have no
                // business in this result.
                '--disable-extensions',
                '--disable-gpu',
                '--no-sandbox',
            ],
        });
    } finally {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
