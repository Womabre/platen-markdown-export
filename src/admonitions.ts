import type MarkdownIt from 'markdown-it';

type Token      = ReturnType<MarkdownIt.MarkdownIt['parse']>[number];
type StateBlock = Parameters<Parameters<MarkdownIt.MarkdownIt['block']['ruler']['at']>[1]>[0];

// ─── Types ────────────────────────────────────────────────────────────────────

type AdmonitionType =
    | 'note'
    | 'abstract'
    | 'info'
    | 'tip'
    | 'success'
    | 'question'
    | 'warning'
    | 'failure'
    | 'danger'
    | 'bug'
    | 'example'
    | 'quote';

interface AdmonitionConfig {
    label: string;
    icon: string;
}

// ─── Aliases → canonical type ─────────────────────────────────────────────────

const ADMONITION_ALIASES: Record<string, AdmonitionType> = {
    note:       'note',
    abstract:   'abstract',
    summary:    'abstract',
    tldr:       'abstract',
    info:       'info',
    todo:       'info',
    tip:        'tip',
    hint:       'tip',
    important:  'tip',
    success:    'success',
    check:      'success',
    done:       'success',
    question:   'question',
    help:       'question',
    faq:        'question',
    warning:    'warning',
    caution:    'warning',
    attention:  'warning',
    failure:    'failure',
    fail:       'failure',
    missing:    'failure',
    danger:     'danger',
    error:      'danger',
    bug:        'bug',
    example:    'example',
    quote:      'quote',
    cite:       'quote',
};

// ─── Per-type config ──────────────────────────────────────────────────────────

const ADMONITION_CONFIGS: Record<AdmonitionType, AdmonitionConfig> = {
    note: {
        label: 'Note',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.41 11.58l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .59 1.42l9 9A2 2 0 0 0 13 22a2 2 0 0 0 1.41-.59l7-7A2 2 0 0 0 22 13a2 2 0 0 0-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>',
    },
    abstract: {
        label: 'Abstract',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>',
    },
    info: {
        label: 'Info',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    },
    tip: {
        label: 'Tip',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    },
    success: {
        label: 'Success',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
    },
    question: {
        label: 'Question',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
    },
    warning: {
        label: 'Warning',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    },
    failure: {
        label: 'Failure',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>',
    },
    danger: {
        label: 'Danger',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>',
    },
    bug: {
        label: 'Bug',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C13 5.06 12.51 5 12 5s-1 .06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>',
    },
    example: {
        label: 'Example',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.8 18.4L14 10.67V6.5l1.35-1.69c.26-.33.03-.81-.39-.81H9.04c-.42 0-.65.48-.39.81L10 6.5v4.17L4.2 18.4c-.49.66-.02 1.6.8 1.6h14c.82 0 1.29-.94.8-1.6z"/></svg>',
    },
    quote: {
        label: 'Quote',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
    },
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function resolveType(rawType: string): AdmonitionType {
    return ADMONITION_ALIASES[rawType.toLowerCase()] ?? 'note';
}

function buildOpenTag(type: AdmonitionType, customTitle: string | null): string {
    const cfg = ADMONITION_CONFIGS[type];
    // customTitle === null  → use default label
    // customTitle === ''    → suppress heading entirely
    // customTitle === 'Foo' → use 'Foo' as title
    const heading = customTitle === ''
        ? ''
        : `<div class="admonition-heading">\n  ${cfg.icon}\n  ${customTitle ?? cfg.label}\n</div>`;

    return `<div class="admonition admonition-${type}" role="note">\n${heading}\n<div class="admonition-content">`;
}

const CLOSE_TAG = `</div>\n</div>`;

// ─── 1. containerConfig — for markdown-it-container (:::type Title) ───────────

export function containerConfig(rawType: string) {
    const type = resolveType(rawType);

    return {
        validate(params: string): boolean {
            return params.trim().startsWith(rawType);
        },

        render(tokens: Token[], idx: number): string {
            if (tokens[idx].nesting === 1) {
                const info      = tokens[idx].info.trim();
                const afterType = info.slice(rawType.length).trim();

                let customTitle: string | null = null;
                if (afterType === '""' || afterType === "''") {
                    customTitle = '';
                } else if (afterType.length > 0) {
                    customTitle = afterType;
                }

                return buildOpenTag(type, customTitle) + '\n';
            }
            return CLOSE_TAG + '\n';
        },
    };
}

// ─── 2. mkdocsAdmonitions — block rule for !!! syntax ────────────────────────

export function mkdocsAdmonitions(md: MarkdownIt.MarkdownIt): void {
    md.block.ruler.before(
        'fence',
        'mkdocs_admonition',
        mkdocsAdmonitionRule,
        { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
}

// Matches: !!! type, !!! type "title", !!! type "", !!! type Unquoted Title
// Group 1 = admonition type
// Group 2 = quoted title (may be empty string → suppress heading)
// Group 3 = unquoted title (everything after the type, trimmed)
const OPENING_RE = /^!!![ \t]+(\w+)(?:[ \t]+"([^"]*)"[ \t]*|[ \t]+([^"\s].*))?$/;

function mkdocsAdmonitionRule(
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
): boolean {
    const pos      = state.bMarks[startLine] + state.tShift[startLine];
    const lineText = state.src.slice(pos, state.eMarks[startLine]);
    const match    = OPENING_RE.exec(lineText);

    if (!match) return false;
    if (silent)  return true;

    const rawType     = match[1]!;
    const type        = resolveType(rawType);
    const customTitle = match[2] !== undefined ? (match[2] as string)
                      : match[3] !== undefined ? match[3].trim()
                      : null;

    // Collect 4-space-indented body lines, allowing interior blank lines
    let nextLine        = startLine + 1;
    let lastContentLine = startLine;

    while (nextLine < endLine) {
        if (state.isEmpty(nextLine)) { nextLine++; continue; }
        if (state.sCount[nextLine] < 4) break;
        lastContentLine = nextLine;
        nextLine++;
    }

    const blockEnd = lastContentLine + 1;

    // Emit open token
    const openToken  = state.push('admonition_open', 'div', 1);
    openToken.markup = '!!!';
    openToken.info   = rawType;
    openToken.meta   = { type, customTitle };
    openToken.map    = [startLine, blockEnd];
    openToken.block  = true;

    // Parse body into the parent token stream
    if (blockEnd > startLine + 1) {
        type StateBlockCtor = new (src: string, md: MarkdownIt.MarkdownIt, env: unknown, tokens: Token[]) => StateBlock;
        const bodyState = new (state.constructor as StateBlockCtor)(
            extractBody(state, startLine + 1, blockEnd),
            state.md,
            state.env,
            [],
        );
        state.md.block.parse(bodyState.src, state.md, state.env, bodyState.tokens);
        for (const t of bodyState.tokens) state.tokens.push(t);
    }

    // Emit close token
    const closeToken  = state.push('admonition_close', 'div', -1);
    closeToken.markup = '!!!';
    closeToken.block  = true;

    state.line = blockEnd;
    return true;
}

function extractBody(state: StateBlock, from: number, to: number): string {
    const lines: string[] = [];
    for (let i = from; i < to; i++) {
        if (state.isEmpty(i)) { lines.push(''); continue; }
        const raw = state.src.slice(state.bMarks[i], state.eMarks[i]);
        lines.push(raw.replace(/^ {1,4}/, ''));
    }
    return lines.join('\n');
}

// ─── Renderer rules ───────────────────────────────────────────────────────────

export function registerAdmonitionRenderers(md: MarkdownIt.MarkdownIt): void {
    md.renderer.rules['admonition_open'] = (tokens, idx) => {
        const { type, customTitle } = tokens[idx].meta as {
            type: AdmonitionType;
            customTitle: string | null;
        };
        return buildOpenTag(type, customTitle) + '\n';
    };

    md.renderer.rules['admonition_close'] = () => CLOSE_TAG + '\n';
}