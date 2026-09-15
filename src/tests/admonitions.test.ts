import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const container = require('markdown-it-container') as (
    md: MarkdownIt.MarkdownIt, name: string, opts: object) => void;
import { containerConfig, mkdocsAdmonitions, registerAdmonitionRenderers } from '../admonitions';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMd(...containerTypes: string[]): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    md.use(mkdocsAdmonitions);
    registerAdmonitionRenderers(md);
    for (const t of containerTypes)
        md.use(container, t, containerConfig(t));
    return md;
}

function render(md: MarkdownIt.MarkdownIt, src: string): string {
    return md.render(src).trim();
}

// ── containerConfig (:::type syntax) ─────────────────────────────────────────

describe('containerConfig', () => {
    it('renders an admonition div with the correct class', () => {
        const md  = makeMd('note');
        const out = render(md, '::: note\nContent\n:::');
        assert.ok(out.includes('class="admonition admonition-note"'), `got: ${out}`);
    });

    it('includes the default label heading when no title given', () => {
        const md  = makeMd('note');
        const out = render(md, '::: note\nContent\n:::');
        assert.ok(out.includes('Note'), `expected default label: ${out}`);
    });

    it('uses a custom title when provided', () => {
        const md  = makeMd('warning');
        const out = render(md, '::: warning Important!\nContent\n:::');
        assert.ok(out.includes('Important!'));
        assert.ok(!out.includes('>Warning<'));
    });

    it('suppresses the heading when title is an empty string', () => {
        const md  = makeMd('tip');
        const out = render(md, '::: tip ""\nContent\n:::');
        assert.ok(!out.includes('admonition-heading'), `heading should be suppressed: ${out}`);
    });

    it('resolves an alias to the canonical type', () => {
        const md  = makeMd('hint');
        const out = render(md, '::: hint\nContent\n:::');
        assert.ok(out.includes('admonition-tip'), `expected tip class: ${out}`);
    });

    it('renders admonition-content wrapper around body', () => {
        const md  = makeMd('info');
        const out = render(md, '::: info\nBody text.\n:::');
        assert.ok(out.includes('admonition-content'));
        assert.ok(out.includes('Body text.'));
    });
});

// ── mkdocsAdmonitions (!!!  syntax) ──────────────────────────────────────────

describe('mkdocsAdmonitions', () => {
    it('renders a basic !!! note block', () => {
        const md  = makeMd();
        const out = render(md, '!!! note\n    Body text.');
        assert.ok(out.includes('admonition-note'), `got: ${out}`);
        assert.ok(out.includes('Body text.'));
    });

    it('uses the default label when no title is given', () => {
        const md  = makeMd();
        const out = render(md, '!!! warning\n    content');
        assert.ok(out.includes('Warning'));
    });

    it('uses a quoted title', () => {
        const md  = makeMd();
        const out = render(md, '!!! note "Custom Title"\n    body');
        assert.ok(out.includes('Custom Title'));
        assert.ok(!out.includes('>Note<'));
    });

    it('suppresses heading with an empty quoted title', () => {
        const md  = makeMd();
        const out = render(md, '!!! tip ""\n    body');
        assert.ok(!out.includes('admonition-heading'), `heading should be absent: ${out}`);
    });

    it('uses an unquoted title after the type', () => {
        const md  = makeMd();
        const out = render(md, '!!! danger Watch out\n    body');
        assert.ok(out.includes('Watch out'));
    });

    it('resolves an alias to the canonical type', () => {
        const md  = makeMd();
        const out = render(md, '!!! caution\n    content');
        assert.ok(out.includes('admonition-warning'), `expected warning class: ${out}`);
    });

    it('resolves an unknown type to note', () => {
        const md  = makeMd();
        const out = render(md, '!!! unknowntype\n    content');
        assert.ok(out.includes('admonition-note'), `expected fallback to note: ${out}`);
    });

    it('renders a block with no body', () => {
        const md  = makeMd();
        const out = render(md, '!!! note');
        assert.ok(out.includes('admonition-note'));
    });

    it('renders multi-line body', () => {
        const md  = makeMd();
        const out = render(md, '!!! info\n    Line one.\n    Line two.');
        assert.ok(out.includes('Line one.'));
        assert.ok(out.includes('Line two.'));
    });

    it('handles an interior blank line within the body', () => {
        const md  = makeMd();
        const out = render(md, '!!! note\n    Para one.\n\n    Para two.');
        assert.ok(out.includes('Para one.'));
        assert.ok(out.includes('Para two.'));
    });
});

// ── registerAdmonitionRenderers ───────────────────────────────────────────────

describe('registerAdmonitionRenderers', () => {
    it('wraps content in role="note" div', () => {
        const md  = makeMd();
        const out = render(md, '!!! note\n    text');
        assert.ok(out.includes('role="note"'), `got: ${out}`);
    });

    it('includes an SVG icon in the heading', () => {
        const md  = makeMd();
        const out = render(md, '!!! note\n    text');
        assert.ok(out.includes('<svg'), `expected SVG icon: ${out}`);
    });

    it('closes with </div></div>', () => {
        const md  = makeMd();
        const out = render(md, '!!! note\n    text');
        assert.ok(out.includes('</div>\n</div>'), `got: ${out}`);
    });
});
