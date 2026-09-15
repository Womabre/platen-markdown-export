/**
 * ```infographic fences, rendered with AntV Infographic.
 *
 * Same placeholder-then-render shape as mermaid.ts and graphviz.ts: the markdown
 * highlight hook emits a base64 placeholder, and {@link renderInfographicDiagrams}
 * later swaps each one for an embedded SVG `<img>`. The library renders through
 * its own server-side entry point (`@antv/infographic/ssr`) — no browser — but
 * inside a worker thread (see infographic-worker.ts for why), and its output is
 * made printable by infographic-svg.ts.
 *
 * Icons are the one part that can reach the network, and which service they reach
 * is the user's call: `--infographic-icons` / `EXPORT_INFOGRAPHIC_ICONS`, decided
 * per request by infographic-icons.ts and performed here through the repo's own
 * guarded fetcher. There is deliberately no frontmatter key for it: a document
 * received from someone else must not be able to opt this machine into sending
 * its text to a third party.
 */

import * as path from 'path';
import { Worker } from 'worker_threads';
import { log, logNotice } from './logger';
import { escHtml } from './frontmatter';
import { stripSvgEmoji } from './mermaid';
import { fetchRemote } from './fetch';
import { decideIconRequest, iconSearchBody, type IconRequestDecision } from './infographic-icons';
import { CONFIG, type InfographicIconProvider } from './config';
import type { FromWorker, ToWorker } from './infographic-worker';

// ── Placeholder format ────────────────────────────────────────────────────────

export const INFOGRAPHIC_PLACEHOLDER_CLASS = 'infographic-block';

/** Placeholder the markdown highlight hook emits; mirrors mermaidPlaceholder. */
export function infographicPlaceholder(source: string): string {
    return `<pre class="${INFOGRAPHIC_PLACEHOLDER_CLASS}" data-src="${Buffer.from(source).toString('base64')}"></pre>`;
}

/** CSS injected into <head> for rendered infographics and their error blocks. */
export const INFOGRAPHIC_CSS = `
/* ── Infographic styles ─────────────────── */
.infographic-figure {
    display: block;
    margin: 1.5em auto;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
}
.infographic-figure > img {
    display: block;
    margin: 0 auto;
    max-width: 100%;
}
.infographic-error {
    border: 1px solid #c00;
    border-radius: 4px;
    padding: 0.75em 1em;
    color: #c00;
    font-size: 0.9em;
}
`;

const PLACEHOLDER_RE = new RegExp(
    `<pre class="${INFOGRAPHIC_PLACEHOLDER_CLASS}" data-src="([^"]+)"></pre>`,
    'g',
);

/** Whether `html` still holds unrendered infographic placeholders. */
export function hasInfographicPlaceholders(html: string): boolean {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(html);
}

/**
 * The error block an infographic that failed to render leaves behind, and the
 * counted warning that failure raises — so `--strict` refuses it, the same as a
 * broken Mermaid diagram or a missing image.
 */
export function infographicErrorReplacement(index: number, code: string, message: string): string {
    log(`WARNING: Infographic ${index} failed to render — ${message}`);
    return (
        `<div class="infographic-error">` +
        `<p><strong>Infographic render error:</strong> ${escHtml(message)}</p>` +
        `<pre><code>${escHtml(code)}</code></pre>` +
        `</div>`
    );
}

export interface InfographicReplacement {
    placeholder: string;
    replacement: string;
}

/**
 * Substitutes rendered infographics back in one pass. A queue per placeholder,
 * because two identical sources share a placeholder byte-for-byte and each needs
 * its own replacement, in document order (see applyMermaidReplacements).
 */
export function applyInfographicReplacements(html: string, replacements: readonly InfographicReplacement[]): string {
    const queued = new Map<string, string[]>();
    for (const { placeholder, replacement } of replacements) {
        const list = queued.get(placeholder);
        if (list) list.push(replacement);
        else queued.set(placeholder, [replacement]);
    }
    PLACEHOLDER_RE.lastIndex = 0;
    return html.replace(PLACEHOLDER_RE, ph => queued.get(ph)?.shift() ?? ph);
}

/** A post-processed infographic SVG as a data URI, emoji stripped unless told otherwise. */
export function infographicSvgToDataUrl(svg: string, stripEmoji: boolean = true): string {
    const out = stripEmoji ? stripSvgEmoji(svg) : svg;
    return `data:image/svg+xml;base64,${Buffer.from(out).toString('base64')}`;
}

// ── Network broker ────────────────────────────────────────────────────────────

/**
 * Icons fetched from Iconify this process, keyed by URL (null = not found).
 *
 * In memory only. Iconify's URLs are not versioned, so the bytes behind one can
 * change, and a disk cache would serve a stale icon nobody could clear — the rule
 * images.ts states for every unpinned remote asset. A process-lifetime cache
 * still means one fetch per icon per export, and across a `--watch` session.
 */
const iconCache = new Map<string, string | null>();

/** What an export's icon traffic amounted to, reported once at the end. */
export interface IconAccounting {
    /** Requests that went to WeaveFox. */
    weavefox: number;
    /** Icon queries that produced no icon. */
    unresolved: Set<string>;
}

interface FetchAnswer { status: number; contentType: string; body: Uint8Array }

const EMPTY = new Uint8Array();
const jsonAnswer = (svg: string | null): FetchAnswer =>
    ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(iconSearchBody(svg)) });

/**
 * Performs one decided request. Exported for testing with an injected fetcher;
 * the export itself uses the repo's guarded {@link fetchRemote}, so private
 * hosts, the metadata endpoint, oversized bodies and timeouts are refused the
 * same way they are for every other remote asset.
 */
export async function answerIconRequest(
    decision: IconRequestDecision,
    accounting: IconAccounting,
    fetcher: typeof fetchRemote = fetchRemote,
): Promise<FetchAnswer> {
    switch (decision.kind) {
        case 'iconify': {
            if (!iconCache.has(decision.url)) {
                let svg: string | null = null;
                try {
                    const { buffer } = await fetcher(decision.url);
                    const text = buffer.toString('utf8').trim();
                    svg = text.startsWith('<svg') ? text : null;
                } catch { /* not found, or unreachable — reported below */ }
                iconCache.set(decision.url, svg);
            }
            const svg = iconCache.get(decision.url) ?? null;
            if (!svg) accounting.unresolved.add(decision.query);
            return jsonAnswer(svg);
        }
        case 'no-result':
            if (decision.query.trim()) accounting.unresolved.add(decision.query.trim());
            return jsonAnswer(null);
        case 'weavefox':
        case 'remote': {
            if (decision.kind === 'weavefox') accounting.weavefox++;
            try {
                const { buffer, mimeType } = await fetcher(decision.url);
                return { status: 200, contentType: mimeType, body: new Uint8Array(buffer) };
            } catch {
                return { status: 502, contentType: 'text/plain', body: EMPTY };
            }
        }
        case 'blocked':
            return { status: 403, contentType: 'text/plain', body: EMPTY };
    }
}

// ── Worker session ────────────────────────────────────────────────────────────

const WORKER_FILE = path.join(__dirname, 'infographic-worker.js');

/**
 * One export's worker: renders one diagram at a time, brokers its network
 * requests, and is replaced after any failure — a crash, an exit, or a render
 * that outlives its timeout — so one bad diagram never takes the rest with it.
 */
class WorkerSession {
    private worker: Worker | null = null;
    private nextId = 0;
    private pending: { id: number; resolve: (svg: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

    constructor(
        private readonly provider: InfographicIconProvider,
        private readonly accounting: IconAccounting,
        private readonly timeoutMs: number,
    ) {}

    render(source: string): Promise<string> {
        const worker = this.worker ?? (this.worker = this.spawn());
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.settle(new Error(`timed out after ${this.timeoutMs / 1000} s`));
                void this.discard();
            }, this.timeoutMs);
            this.pending = { id, resolve, reject, timer };
            worker.postMessage({ type: 'render', id, source } satisfies ToWorker);
        });
    }

    async close(): Promise<void> {
        await this.discard();
    }

    private spawn(): Worker {
        const worker = new Worker(WORKER_FILE);
        worker.on('message', (msg: FromWorker) => this.onMessage(worker, msg));
        worker.on('error', (err: unknown) => this.settle(err instanceof Error ? err : new Error(String(err))));
        worker.on('exit', code => {
            if (this.worker === worker) this.worker = null;
            this.settle(new Error(`the renderer stopped unexpectedly (exit ${code})`));
        });
        return worker;
    }

    private onMessage(worker: Worker, msg: FromWorker): void {
        if (msg.type === 'fetch') {
            void answerIconRequest(decideIconRequest(msg.url, this.provider), this.accounting).then(answer => {
                try {
                    worker.postMessage({ type: 'fetch-result', fetchId: msg.fetchId, ...answer } satisfies ToWorker);
                } catch { /* the worker is gone; its render has already failed */ }
            });
            return;
        }
        if (this.pending?.id !== msg.id) return;
        if (msg.ok) this.settle(null, msg.svg);
        else        this.settle(new Error(msg.error));
    }

    private settle(err: Error | null, svg?: string): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        if (err) p.reject(err);
        else     p.resolve(svg as string);
    }

    private async discard(): Promise<void> {
        const worker = this.worker;
        this.worker = null;
        if (worker) await worker.terminate();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InfographicRenderOptions {
    /** Strip emoji from the output — see colorEmojiRenderingSupported. Default true. */
    stripEmoji?: boolean;
    /** Where icons come from. Default: CONFIG.infographicIcons. */
    iconProvider?: InfographicIconProvider;
    /** Per-diagram limit, after which the worker is replaced. Default 30 s. */
    timeoutMs?: number;
}

/** The line that tells the user their document text left the machine, and where. */
export function weavefoxNotice(requests: number): string {
    return `${requests} infographic icon request(s) went to www.weavefox.cn — Ant Group's WeaveFox service. `
         + `Data may go to servers in China. The default, --infographic-icons iconify, sends only icon names, to Iconify.`;
}

/**
 * Renders every infographic placeholder in `html` and returns the result.
 * A document with none returns unchanged, having started no worker.
 */
export async function renderInfographicDiagrams(html: string, opts: InfographicRenderOptions = {}): Promise<string> {
    PLACEHOLDER_RE.lastIndex = 0;
    const matches = [...html.matchAll(PLACEHOLDER_RE)];
    if (matches.length === 0) return html;

    const provider = opts.iconProvider ?? CONFIG.infographicIcons;
    log(`Rendering ${matches.length} infographic(s) (icons: ${provider})...`);

    const accounting: IconAccounting = { weavefox: 0, unresolved: new Set() };
    const session = new WorkerSession(provider, accounting, opts.timeoutMs ?? 30_000);
    const replacements: InfographicReplacement[] = [];
    try {
        for (const [i, match] of matches.entries()) {
            const index = i + 1;
            const code = Buffer.from(match[1], 'base64').toString('utf8');
            try {
                const dataUrl = infographicSvgToDataUrl(await session.render(code), opts.stripEmoji ?? true);
                log(`  infographic ${index}: rendered → SVG (${(dataUrl.length / 1024).toFixed(0)} KB)`);
                replacements.push({
                    placeholder: match[0],
                    replacement: `<div class="diagram-figure infographic-figure"><img src="${dataUrl}" alt="Infographic ${index}"></div>`,
                });
            } catch (err: unknown) {
                replacements.push({
                    placeholder: match[0],
                    replacement: infographicErrorReplacement(index, code, err instanceof Error ? err.message : String(err)),
                });
            }
        }
    } finally {
        await session.close();
    }

    if (accounting.weavefox > 0) logNotice(weavefoxNotice(accounting.weavefox));
    if (accounting.unresolved.size > 0) {
        const names = [...accounting.unresolved].map(q => `"${q}"`).join(', ');
        if (provider === 'iconify')
            log(`WARNING: Infographic icon(s) not found on Iconify, left out: ${names} — use an Iconify name such as mdi/home`);
        else if (provider === 'none')
            log(`Infographic icons are off (--infographic-icons none); left out: ${names}`);
    }

    return applyInfographicReplacements(html, replacements);
}
