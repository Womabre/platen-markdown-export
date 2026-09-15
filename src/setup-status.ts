/**
 * What `--setup` would install, without installing it: `--check-setup`.
 *
 * The VS Code extension asks this before offering to install anything, so its
 * one prompt can name exactly what is missing. It asks the CLI rather than
 * detecting for itself because the Chromium check loads playwright, which needs
 * a newer Node than the extension host of every VS Code the extension supports —
 * and because a second detector in the editor would be one refactor away from
 * disagreeing with the installer about what is there.
 *
 * Its own module, not part of bootstrap.ts: the extension `require()`s
 * bootstrap.js in-process when Node.js itself is missing, and the Chromium check
 * must not come along with it.
 */

import { findWeasyprint } from './bootstrap';
import { findDrawioCli } from './drawio';
import { mermaidUnavailableReason } from './mermaid';

/** One runtime dependency that `--setup` installs when it is missing. */
export interface SetupComponent {
    /** Stable identifier — the extension keys on it, so never rename one. */
    id: 'weasyprint' | 'chromium' | 'drawio';
    name: string;
    installed: boolean;
}

/** How each component is detected. Injected so the report is testable without the binaries. */
export interface SetupDetectors {
    weasyprint: () => boolean;
    chromium: () => Promise<boolean>;
    drawio: () => boolean;
}

const REAL_DETECTORS: SetupDetectors = {
    weasyprint: () => findWeasyprint() !== null,
    chromium:   async () => (await mermaidUnavailableReason()) === null,
    drawio:     () => findDrawioCli() !== null,
};

/** Every component `runBootstrap` installs, in the order it installs them. */
export async function setupStatus(detect: SetupDetectors = REAL_DETECTORS): Promise<SetupComponent[]> {
    return [
        { id: 'weasyprint', name: 'WeasyPrint', installed: detect.weasyprint() },
        { id: 'chromium',   name: 'Chromium',   installed: await detect.chromium() },
        { id: 'drawio',     name: 'draw.io',    installed: detect.drawio() },
    ];
}

/** The human listing `--setup --dry-run` prints without `--json`. */
export function formatSetupStatus(components: readonly SetupComponent[]): string {
    const width = Math.max(...components.map(c => c.name.length));
    const lines = components.map(c =>
        `${c.installed ? '✔' : '✖'} ${c.name.padEnd(width)}  ${c.installed ? 'installed' : 'missing'}`);
    const missing = components.filter(c => !c.installed).map(c => c.name);
    lines.push(missing.length
        ? `--setup would install: ${missing.join(', ')}`
        : 'Nothing to install.');
    return lines.join('\n');
}
