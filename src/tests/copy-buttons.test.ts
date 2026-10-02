import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { convertMarkdownToHtml } from '../markdown';
import { extractFrontmatter } from '../frontmatter';
import { parseCopyFlag, splitCopyFlagFromLang } from '../markdown-extras';
import { buildCopyButtonScript, documentWantsCopyButtons } from '../copy-buttons';
import { buildHtmlExportPipeline, buildHtmlPipeline } from '../index';
import { setActiveTheme } from '../theme';

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'themed-markdown-export-copy-test-'));
    setActiveTheme('default');
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Renders a markdown body through the real markdown-it setup. */
async function render(body: string, frontmatter = 'Title: Copy'): Promise<string> {
    const file   = path.join(tmpDir, 'doc.md');
    const source = `---\n${frontmatter}\n---\n\n${body}\n`;
    return convertMarkdownToHtml(file, source, extractFrontmatter(file, source));
}

/** The opening `<pre …>` tags of a rendered document, in order. */
function preTags(html: string): string[] {
    return [...html.matchAll(/<pre\b[^>]*>/g)].map(m => m[0]);
}

// ── Fence info-string flags ───────────────────────────────────────────────────

describe('copy flags in the fence info string', () => {
    it('reads copy / nocopy, case-insensitively, last one winning', () => {
        assert.equal(parseCopyFlag(''), null);
        assert.equal(parseCopyFlag('copy'), 'on');
        assert.equal(parseCopyFlag('NoCopy'), 'off');
        assert.equal(parseCopyFlag('copy nocopy'), 'off');
        assert.equal(parseCopyFlag('title=x'), null);
    });

    it('treats a flag in the language slot as a flag on a plain block', () => {
        assert.deepEqual(splitCopyFlagFromLang('copy', ''), ['', 'on']);
        assert.deepEqual(splitCopyFlagFromLang('powershell', 'copy'), ['powershell', 'on']);
        assert.deepEqual(splitCopyFlagFromLang('powershell:2', ''), ['powershell:2', null]);
    });

    it('marks a flagged fence and leaves an unflagged one bare', async () => {
        const html = await render('```powershell copy\nGet-Service\n```\n\n```bash nocopy\nls\n```\n\n```js\nx\n```');
        assert.deepEqual(preTags(html), [
            '<pre class="hljs" data-copy="on">',
            '<pre class="hljs" data-copy="off">',
            '<pre class="hljs">',
        ]);
    });

    it('keeps syntax highlighting and line highlighting alongside the flag', async () => {
        const html = await render('```powershell:2 copy\n$a = 1\nGet-Service\n```');
        assert.match(html, /<pre class="hljs" data-copy="on">/);
        assert.match(html, /hljs-variable/, 'still highlighted as PowerShell');
        assert.match(html, /<span class="code-line hljs-line-highlight"><span class="hljs-built_in">Get-Service/);
    });

    it('accepts ```copy on a block with no language', async () => {
        const html = await render('```copy\nplain text\n```');
        assert.match(html, /<pre class="hljs" data-copy="on"><code><span class="code-line">plain text/);
    });

    it('does not turn a flagged Mermaid fence into a code block', async () => {
        const html = await render('```mermaid copy\ngraph TD; A-->B\n```');
        assert.ok(!/<pre class="hljs"/.test(html), html);
    });
});

// ── Frontmatter ───────────────────────────────────────────────────────────────

describe('Copy Buttons frontmatter key', () => {
    it('defaults to on and is turned off by false / no / off', () => {
        const at = (fm: string) => extractFrontmatter('doc.md', `---\nTitle: x\n${fm}\n---\n`).copyButtons;
        assert.equal(at(''), true);
        assert.equal(at('Copy Buttons: true'), true);
        assert.equal(at('Copy Buttons: false'), false);
        assert.equal(at('copy buttons: no'), false);
        assert.equal(at('Copy Buttons: off'), false);
    });
});

// ── Whether a document ships the script at all ────────────────────────────────

describe('documentWantsCopyButtons', () => {
    const plain   = '<pre class="hljs"><code>x</code></pre>';
    const flagged = '<pre class="hljs" data-copy="on"><code>x</code></pre>';

    it('wants them for any code block when on', () => {
        assert.equal(documentWantsCopyButtons(plain, true), true);
    });

    it('wants them when off only if a block opted in, however it is quoted', () => {
        assert.equal(documentWantsCopyButtons(plain, false), false);
        assert.equal(documentWantsCopyButtons(flagged, false), true);
        assert.equal(documentWantsCopyButtons("<pre data-copy='on'><code>x</code></pre>", false), true);
    });

    it('never wants them on a page without code', () => {
        assert.equal(documentWantsCopyButtons('<p>prose</p>', true), false);
    });
});

describe('buildCopyButtonScript', () => {
    it('bakes in the document default and cannot close its own script tag early', () => {
        const on  = buildCopyButtonScript(true);
        const off = buildCopyButtonScript(false);
        assert.match(on,  /DEFAULT_ON = true;/);
        assert.match(off, /DEFAULT_ON = false;/);
        assert.equal(on.match(/<\/script>/g)?.length, 1);
    });
});

// ── Pipelines: HTML gets the buttons, the PDF never does ──────────────────────

describe('copy buttons across the two finishing pipelines', () => {
    const body = '```powershell\nGet-Service\n```';

    it('the HTML export carries the script and its CSS', async () => {
        const file = path.join(tmpDir, 'doc.md');
        const html = await buildHtmlExportPipeline(await render(body), file, null, extractFrontmatter('doc.md', '---\nTitle: Copy\n---\n'));
        assert.match(html, /<script>[\s\S]*copy-button[\s\S]*<\/script>\s*<\/body>/);
        assert.match(html, /pre\.has-copy-button > \.copy-button/);
    });

    it('the HTML export ships nothing when buttons are off and no block opted in', async () => {
        const file = path.join(tmpDir, 'doc.md');
        const fm   = extractFrontmatter('doc.md', '---\nTitle: Copy\nCopy Buttons: false\n---\n');
        const html = await buildHtmlExportPipeline(await render(body, 'Title: Copy\nCopy Buttons: false'), file, null, fm);
        assert.ok(!html.includes('copy-button'), 'no script, no CSS');
    });

    it('the PDF pipeline carries neither script nor button CSS', async () => {
        const file = path.join(tmpDir, 'doc.md');
        const fm   = extractFrontmatter('doc.md', '---\nTitle: Copy\n---\n');
        const html = await buildHtmlPipeline(await render(body), file, null, fm, Promise.resolve(null), Promise.resolve(''));
        assert.ok(!html.includes('copy-button'), 'nothing for WeasyPrint to draw');
        assert.ok(!/<script\b/i.test(html));
    });
});
