/**
 * Worker thread that renders ```infographic diagrams with AntV Infographic's SSR.
 *
 * Why a thread of its own: the library's SSR shim assigns `window`, `document`,
 * `DOMParser`, some forty DOM constructors and `requestAnimationFrame` onto
 * `globalThis`, and never takes them back. In the main process every other
 * library would go on believing it runs in a browser for the rest of the export
 * — and of a `--watch` session. Here those globals end with the thread. So does
 * an exception thrown from one of the library's timers, which would otherwise
 * end the export.
 *
 * Network: the library captures `globalThis.fetch` when it is imported, so a
 * proxy is installed before the import. Every request it makes is posted to the
 * main thread, which decides it (infographic-icons.ts), performs it through the
 * repo's guarded fetcher, and replies. This thread never touches the network.
 */

import { parentPort } from 'worker_threads';
import { postProcessInfographicSvg, type MeasureText, type EmbeddedFont } from './infographic-svg';
import { bundledFontFor, fontFaceCss } from './infographic-fonts';
import { attrValues } from './attributes';
import { closestMatch } from './strings';

/** Messages the main thread sends. */
export type ToWorker =
    | { type: 'render'; id: number; source: string }
    | { type: 'fetch-result'; fetchId: number; status: number; contentType: string; body: Uint8Array };

/** Messages this thread sends. */
export type FromWorker =
    | { type: 'fetch'; fetchId: number; url: string }
    | { type: 'rendered'; id: number; ok: true; svg: string }
    | { type: 'rendered'; id: number; ok: false; error: string };

if (!parentPort) throw new Error('infographic-worker must run as a worker thread');
const port = parentPort;

// A failed icon lookup logs a full stack trace from inside the library. What
// matters is reported once, by the main thread, through the repo's own logger.
console.log = console.info = console.warn = console.error = console.debug = () => { /* silenced */ };

type FetchReply = Extract<ToWorker, { type: 'fetch-result' }>;
const pendingFetches = new Map<number, (reply: FetchReply) => void>();
let nextFetchId = 0;

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const fetchId = ++nextFetchId;
    const reply = await new Promise<FetchReply>(resolve => {
        pendingFetches.set(fetchId, resolve);
        port.postMessage({ type: 'fetch', fetchId, url } satisfies FromWorker);
    });
    // `.slice()` copies into a plain ArrayBuffer, which is what Response accepts.
    return new Response(reply.body.slice(), { status: reply.status, headers: { 'content-type': reply.contentType } });
};

// After the proxy, never before: see the header.
const ready = (async () => {
    const [{ renderToString }, { parseSyntax, getTemplate, getTemplates }, measury, arial] = await Promise.all([
        import('@antv/infographic/ssr'),
        import('@antv/infographic'),
        import('measury'),
        import('measury/fonts/Arial-Regular'),
    ]);
    measury.registerFont(arial.default);
    const measure: MeasureText = (text, fontSize) =>
        measury.measureText(text, { fontFamily: 'Arial', fontSize }).width;

    /**
     * The bundled font a rendered diagram asks for, with a measurer that uses
     * its own metrics — so the wrapping matches the glyphs that get drawn, and
     * matches the boxes the library sized, which it measured in the same font.
     *
     * Registering it is idempotent and cheap after the first diagram, and only
     * a theme that names a font we ship reaches this at all.
     */
    const registered = new Map<string, MeasureText>();
    const embedFont = async (rawSvg: string): Promise<{ font: EmbeddedFont; measure: MeasureText } | null> => {
        const font = bundledFontFor(attrValues(rawSvg, 'font-family')[0]);
        if (!font) return null;
        let measureIn = registered.get(font.family);
        if (!measureIn) {
            const data = await import(font.measury);
            measury.registerFont(data.default);
            measureIn = (text, fontSize) => measury.measureText(text, { fontFamily: font.family, fontSize }).width;
            registered.set(font.family, measureIn);
        }
        return { font: { family: font.family, faceCss: fontFaceCss(font) }, measure: measureIn };
    };

    /**
     * Checks a block with the library's own parser before rendering it. Its
     * parser is lenient by design — it accepts incomplete syntax so an AI can
     * stream into it — which leaves two failures silent: garbage input waits out
     * the library's 10-second internal timeout and reports only "SSR render
     * timeout", and an unknown template name quietly renders a *different*
     * template. Both are refused here, immediately, saying what is wrong.
     */
    const validate = (source: string): void => {
        const { options, errors } = parseSyntax(source);
        if (errors.length) {
            const detail = errors.map((e: { line?: number; message: string }) =>
                (e.line ? `line ${e.line}: ` : '') + e.message).join('; ');
            throw new Error(`invalid infographic syntax — ${detail}`);
        }
        const template = options.template;
        if (!template) throw new Error('no template — start the block with "infographic <template-name>"');
        if (!getTemplate(template)) {
            const guess = closestMatch(template, getTemplates());
            throw new Error(`unknown template "${template}"${guess ? ` — did you mean "${guess}"?` : ''}`);
        }
    };
    return { renderToString, measure, validate, embedFont };
})();

port.on('message', async (msg: ToWorker) => {
    if (msg.type === 'fetch-result') {
        pendingFetches.get(msg.fetchId)?.(msg);
        pendingFetches.delete(msg.fetchId);
        return;
    }
    try {
        const { renderToString, measure, validate, embedFont } = await ready;
        validate(msg.source);
        const raw = await renderToString(msg.source);
        const themed = await embedFont(raw);
        const svg = postProcessInfographicSvg(raw, themed?.measure ?? measure, themed?.font);
        port.postMessage({ type: 'rendered', id: msg.id, ok: true, svg } satisfies FromWorker);
    } catch (err: unknown) {
        port.postMessage({ type: 'rendered', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FromWorker);
    }
});
