import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupStatus, formatSetupStatus, type SetupDetectors } from '../setup-status';

const detectors = (installed: { weasyprint: boolean; chromium: boolean; drawio: boolean }): SetupDetectors => ({
    weasyprint: () => installed.weasyprint,
    chromium:   async () => installed.chromium,
    drawio:     () => installed.drawio,
});

describe('setupStatus', () => {
    it('reports every component --setup installs, in install order', async () => {
        const components = await setupStatus(detectors({ weasyprint: true, chromium: false, drawio: true }));
        assert.deepEqual(components, [
            { id: 'weasyprint', name: 'WeasyPrint', installed: true },
            { id: 'chromium',   name: 'Chromium',   installed: false },
            { id: 'drawio',     name: 'draw.io',    installed: true },
        ]);
    });

    it('keeps the ids the VS Code extension keys on', async () => {
        // The extension remembers "don't ask again" per id, so renaming one
        // would re-ask about something the user already declined.
        const ids = (await setupStatus(detectors({ weasyprint: false, chromium: false, drawio: false }))).map(c => c.id);
        assert.deepEqual(ids, ['weasyprint', 'chromium', 'drawio']);
    });
});

describe('formatSetupStatus', () => {
    it('marks each component and names what setup would install', async () => {
        const text = formatSetupStatus(await setupStatus(detectors({ weasyprint: true, chromium: false, drawio: false })));
        assert.match(text, /✔ WeasyPrint\s+installed/);
        assert.match(text, /✖ Chromium\s+missing/);
        assert.match(text, /--setup would install: Chromium, draw\.io$/);
    });

    it('says there is nothing to install when nothing is missing', async () => {
        const text = formatSetupStatus(await setupStatus(detectors({ weasyprint: true, chromium: true, drawio: true })));
        assert.match(text, /Nothing to install\.$/);
        assert.doesNotMatch(text, /✖/);
    });
});
