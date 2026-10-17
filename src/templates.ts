import * as fs   from 'fs';
import * as path from 'path';
import frontMatter from 'front-matter';
import { ExitError } from './errors';
import { log } from './logger';
import { frontmatterTemplate } from './frontmatter';
import { splitThemePath } from './theme';
import { closestMatch } from './strings';
import type { FrontmatterAnswers } from './types';

/**
 * Document templates: a starting point for one kind of document.
 *
 * A template is a folder holding `template.md` — preset frontmatter plus a body
 * outline — and optionally `template.json` with a one-line `description`. It is
 * the `--init` scaffold with opinions: a meeting-notes template knows it wants
 * no cover and numbered headings, and what its sections are called.
 *
 * Rendering never assembles frontmatter of its own. It starts from
 * `frontmatterTemplate`, the one implementation of answers → frontmatter (which
 * is what quotes a title with a colon in it correctly), and merges the
 * template's blocks into that, so a template can only ever add to or change what
 * the scaffold says, never break how it says it.
 *
 * Templates are found the way themes are: `--template-path`, then
 * `EXPORT_TEMPLATE_PATH`, then `templatePaths` in the project and user config
 * files, then the ones that ship in `templates/`. An external template shadows
 * a built-in one of the same name, which is how an organisation replaces
 * `report` with its own.
 */

/** The bundled templates, beside `themes/` in the package. */
export const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

/** The env var naming extra template roots, `PATH`-style like `EXPORT_THEME_PATH`. */
export const TEMPLATE_PATH_ENV = 'EXPORT_TEMPLATE_PATH';

const TEMPLATE_FILE = 'template.md';
const TEMPLATE_META = 'template.json';

/** One template, as `--list-templates --json` reports it. */
export interface TemplateEntry {
    name: string;
    description: string;
    /** The template's Markdown file — `template.md` in its folder, or a loose `.md`. */
    file: string;
    source: 'builtin' | 'external';
    /** The top-level frontmatter keys the template sets, as it writes them. */
    sets: string[];
    /** The template's own `Theme`, when it names one — a wizard asks for styles of this theme. */
    theme: string | null;
}

/** Template roots from `EXPORT_TEMPLATE_PATH`. */
export function templateRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env[TEMPLATE_PATH_ENV];
    return raw ? splitThemePath(raw).map(p => path.resolve(p)) : [];
}

/**
 * Reads one template: `file` is its `template.md` (or a loose `.md`), `name`
 * what it is listed and selected as. Null when the file cannot be read.
 */
function readEntry(file: string, name: string, source: TemplateEntry['source']): TemplateEntry | null {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

    let description = '';
    const metaFile = path.join(path.dirname(file), TEMPLATE_META);
    if (fs.existsSync(metaFile)) {
        try {
            const meta: unknown = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            const d = (meta as { description?: unknown } | null)?.description;
            if (typeof d === 'string') description = d;
        } catch (err: unknown) {
            log(`WARNING: ${metaFile} is not valid JSON (${(err as Error).message}) — ignoring it`);
        }
    }

    let attributes: Record<string, unknown> = {};
    try {
        const parsed = frontMatter(text).attributes;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) attributes = parsed as Record<string, unknown>;
    } catch (err: unknown) {
        log(`WARNING: ${file} has frontmatter that is not valid YAML (${(err as Error).message})`);
    }
    const themeKey = Object.keys(attributes).find(k => k.toLowerCase() === 'theme');
    const theme = themeKey && attributes[themeKey] != null ? String(attributes[themeKey]) : null;

    return { name, description, file, source, sets: Object.keys(attributes), theme };
}

/** Every template under one root: each subfolder with a `template.md`. */
function entriesIn(root: string, source: TemplateEntry['source']): TemplateEntry[] {
    let names: string[];
    try { names = fs.readdirSync(root).sort(); } catch { return []; }
    return names
        .map(n => path.join(root, n))
        .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
        .map(d => readEntry(path.join(d, TEMPLATE_FILE), path.basename(d), source))
        .filter((e): e is TemplateEntry => e !== null);
}

/**
 * Every discoverable template, external roots first, one entry per name — the
 * first root that has a name wins, as it does for themes.
 */
export function listTemplateEntries(externalRoots: readonly string[], builtinRoot: string = TEMPLATES_DIR): TemplateEntry[] {
    const seen = new Map<string, TemplateEntry>();
    const all = [
        ...externalRoots.flatMap(r => entriesIn(r, 'external')),
        ...entriesIn(builtinRoot, 'builtin'),
    ];
    for (const entry of all) {
        const key = entry.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, entry);
    }
    return [...seen.values()];
}

/**
 * The template `nameOrPath` names: a template name (case-insensitive), a folder
 * holding `template.md`, or a `.md` file used directly.
 *
 * An unknown name exits 3 — like a missing theme — with the nearest name
 * suggested, because a typo here would otherwise silently scaffold nothing.
 */
export function resolveTemplate(
    nameOrPath: string,
    externalRoots: readonly string[],
    builtinRoot: string = TEMPLATES_DIR,
): TemplateEntry {
    const asPath = path.resolve(nameOrPath);
    if (/\.md$/i.test(nameOrPath) && fs.existsSync(asPath)) {
        // `my-templates/report/template.md` is the template `report`; `memo.md` is `memo`.
        const name = path.basename(asPath).toLowerCase() === TEMPLATE_FILE
            ? path.basename(path.dirname(asPath)) : path.basename(asPath, path.extname(asPath));
        return readEntry(asPath, name, 'external')!;
    }
    if (/[\\/]/.test(nameOrPath) && fs.existsSync(path.join(asPath, TEMPLATE_FILE))) {
        return readEntry(path.join(asPath, TEMPLATE_FILE), path.basename(asPath), 'external')!;
    }

    const entries = listTemplateEntries(externalRoots, builtinRoot);
    const hit = entries.find(e => e.name.toLowerCase() === nameOrPath.toLowerCase());
    if (hit) return hit;

    const guess = closestMatch(nameOrPath, entries.map(e => e.name));
    throw new ExitError(
        `Error: template "${nameOrPath}" not found${guess ? ` — did you mean "${guess}"?` : ''}\n` +
        `  Available: ${entries.map(e => e.name).join(', ') || '(none)'}\n` +
        '  Run --list-templates to see where each one comes from.\n', 3);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** One top-level frontmatter entry as text: its key line plus everything indented under it. */
interface Block { key: string | null; lines: string[] }

/** A top-level key line: not indented, not a comment, not a list item. */
const KEY_LINE = /^([^\s#\-][^:]*?)[ \t]*:/;

/**
 * Splits a frontmatter body into top-level blocks, as text.
 *
 * Text rather than parsed YAML, so a template's comments, quoting and layout
 * reach the new document exactly as the template's author wrote them. Comment
 * lines at the top level belong to the block after them; any after the last
 * key form a block of their own with no key.
 */
export function splitBlocks(yaml: string): Block[] {
    const blocks: Block[] = [];
    let pending: string[] = [];
    for (const line of yaml.split('\n')) {
        const m = KEY_LINE.exec(line);
        if (m) {
            blocks.push({ key: m[1].trim(), lines: [...pending, line] });
            pending = [];
        } else if (blocks.length && line.trim() && /^(\s|-(\s|$))/.test(line)) {
            // Indented, or an unindented `- item` list: still the last block,
            // including any blank lines held back since it.
            blocks[blocks.length - 1].lines.push(...pending, line);
            pending = [];
        } else {
            pending.push(line);
        }
    }
    const tail = pending.filter((l, i) => l.trim() || i < pending.length - 1);
    if (tail.length) blocks.push({ key: null, lines: tail });
    return blocks;
}

/** Which frontmatter key each answer sets, for "an answered key beats the template". */
const ANSWER_KEYS: Record<keyof FrontmatterAnswers, string> = {
    title: 'Title', author: 'Document Info', date: 'Document Info', revision: 'Document Info',
    status: 'Document Info', remarks: 'Revisions', revisionsVisible: 'Revisions Visible',
    theme: 'Theme', style: 'Style', mode: 'Mode', lang: 'Lang', pageSize: 'Page Size',
    orientation: 'Orientation', margins: 'Margins', classification: 'Classification',
    watermark: 'Watermark', numberedHeadings: 'Numbered Headings', runningHeader: 'Running Header',
    listOfTables: 'List of Tables', listOfFigures: 'List of Figures',
    codeLineNumbers: 'Code Line Numbers', tocDepth: 'TOC Depth',
};

/** Keys whose content is the document's own identity: always the scaffold's, never the template's. */
const IDENTITY = new Set(['title', 'revisions']);

/** The `Document Info` labels the scaffold writes itself; a template may add any other. */
const SCAFFOLD_INFO = new Set(['author', 'date', 'revision', 'status']);

function answeredKeys(answers: FrontmatterAnswers): Set<string> {
    const keys = new Set<string>();
    for (const [field, value] of Object.entries(answers)) {
        if (value === undefined || value === '' || value === false) continue;
        const key = ANSWER_KEYS[field as keyof FrontmatterAnswers];
        if (key) keys.add(key.toLowerCase());
    }
    return keys;
}

/**
 * The template's extra `Document Info` labels (a `Customer:`, a `Project:`)
 * appended to the scaffold's own block, which keeps its Author, Date, Revision
 * and Status — those carry today's date and the answered author.
 */
function mergeDocumentInfo(base: Block, template: Block): Block {
    const extra = template.lines.slice(1).filter(line => {
        const m = /^\s+([^\s#\-][^:]*?)[ \t]*:/.exec(line);
        return m ? !SCAFFOLD_INFO.has(m[1].trim().toLowerCase()) : false;
    });
    if (!extra.length) return base;
    const indent = /^(\s+)/.exec(base.lines[1] ?? '    ')?.[1] ?? '    ';
    return { key: base.key, lines: [...base.lines, ...extra.map(l => indent + l.trimStart())] };
}

/** `{{Title}}`, `{{Author}}` and `{{Date}}` in the body — the three filled in when a document is created. */
const CREATION_TOKENS = /\{\{\s*(Title|Author|Date)\s*\}\}/g;

/**
 * Renders a template into a new document.
 *
 * Frontmatter: the scaffold `frontmatterTemplate(today, answers)` would print,
 * with the template's blocks merged in — `Title` and `Revisions` are always the
 * scaffold's, `Document Info` gains the template's extra labels, a key the
 * answers set keeps the answer, any other key the template sets replaces the
 * scaffold's, and keys the scaffold lacks are added.
 *
 * Body: the template's, with `{{Title}}`, `{{Author}}` and `{{Date}}` filled in.
 * Every other `{{Name}}` is left alone for `Variables` to fill at export.
 */
export function renderTemplate(
    entry: TemplateEntry,
    today: string = new Date().toISOString().slice(0, 10),
    answers: FrontmatterAnswers = {},
): string {
    const text = fs.readFileSync(entry.file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const m = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
    const templateYaml = m ? m[1] : '';
    const templateBody = m ? m[2] : text;

    const scaffold = frontmatterTemplate(today, answers);
    const sm = /^---\n([\s\S]*?)\n---\n/.exec(scaffold)!;
    const base = splitBlocks(sm[1]);
    const answered = answeredKeys(answers);

    const index = (key: string): number => base.findIndex(b => b.key?.toLowerCase() === key);
    const tailAt = (): number => { const i = base.findIndex(b => b.key === null); return i === -1 ? base.length : i; };

    for (const block of splitBlocks(templateYaml)) {
        if (!block.key) continue;
        const key = block.key.toLowerCase();
        if (IDENTITY.has(key)) continue;
        const at = index(key);
        if (key === 'document info') {
            if (at !== -1) base[at] = mergeDocumentInfo(base[at], block);
            continue;
        }
        if (at !== -1) {
            if (!answered.has(key)) base[at] = block;
        } else {
            base.splice(tailAt(), 0, block);
        }
    }

    const values: Record<string, string> = {
        Title:  answers.title  ?? 'Document Title',
        Author: answers.author ?? 'Your Name',
        Date:   answers.date   ?? today,
    };
    const body = templateBody.replace(/^\n+/, '')
        .replace(CREATION_TOKENS, (_all, name: string) => values[name]);

    const yaml = base.flatMap(b => b.lines).join('\n');
    return `---\n${yaml}\n---\n\n${body.replace(/\n*$/, '\n')}`;
}
