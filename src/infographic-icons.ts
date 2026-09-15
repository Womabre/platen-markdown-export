/**
 * Network policy for ```infographic rendering.
 *
 * AntV Infographic resolves icons through one endpoint: Ant Group's WeaveFox
 * search service. A plain icon name (`mdi/home`) parses to a "custom" resource,
 * finds no custom loader, and falls back to a search query; an explicit
 * `ref:search:` goes there directly; and when any icon fails, the library's own
 * fallback query is the name — or, if there is none, the item's `label` or
 * `desc`. Every one of those arrives as a single GET to {@link WEAVEFOX_ICON_SERVICE}.
 *
 * That single choke point is what makes a policy enforceable: the render worker
 * routes every request the library makes through {@link decideIconRequest}, and
 * the provider decides what the search request is allowed to become. Nothing
 * here performs I/O — it only decides — so the rules are testable without a
 * network.
 */

import type { InfographicIconProvider } from './config';

/** The library's hardcoded icon search endpoint (its `ICON_SERVICE_URL`). */
export const WEAVEFOX_ICON_SERVICE = 'https://www.weavefox.cn/api/v1/infographic/icon';

/** Iconify's public API: `/{prefix}/{name}.svg` returns one icon as SVG. */
export const ICONIFY_API = 'https://api.iconify.design';

/**
 * An Iconify icon name — `mdi/home` or `mdi:home`. Iconify prefixes and names
 * are lowercase alphanumerics separated by single hyphens.
 */
const ICON_NAME_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)[/:]([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * The Iconify SVG URL for an icon name, or null when `query` is not one.
 * Every Iconify name is lowercase, so `MDI/Home` is read as `mdi/home` rather
 * than refused.
 */
export function iconifyUrl(query: string): string | null {
    const m = ICON_NAME_RE.exec(query.trim().toLowerCase());
    return m ? `${ICONIFY_API}/${m[1]}/${m[2]}.svg` : null;
}

/** What the render worker's fetch is allowed to do with one request. */
export type IconRequestDecision =
    /** Answer the icon search with this one Iconify SVG. */
    | { kind: 'iconify'; query: string; url: string }
    /** Answer the icon search with "nothing found" — no network. */
    | { kind: 'no-result'; query: string }
    /** Let the search go to WeaveFox as the library intended, unchanged. */
    | { kind: 'weavefox'; query: string; url: string }
    /** A remote asset the document named itself (`ref:remote:https://…`). */
    | { kind: 'remote'; url: string }
    /** Refuse outright. */
    | { kind: 'blocked'; url: string };

/**
 * Decides one request the library wants to make.
 *
 * - `iconify` (default): a search whose query is a well-formed icon name becomes
 *   a fetch of exactly that icon from Iconify. Any other query — free text, and
 *   in particular the label/desc fallback — gets "nothing found", so document
 *   prose never leaves the machine; only icon names do.
 * - `weavefox`: the search goes to WeaveFox unchanged.
 * - `none`: no request of any kind.
 *
 * A request that is not the icon search is a remote asset the document named
 * explicitly. It is allowed unless the provider is `none`, and the caller
 * fetches it through the same private-host guard as every other remote asset.
 */
export function decideIconRequest(url: string, provider: InfographicIconProvider): IconRequestDecision {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { kind: 'blocked', url }; }

    if (`${parsed.origin}${parsed.pathname}` === WEAVEFOX_ICON_SERVICE) {
        const query = parsed.searchParams.get('text') ?? '';
        if (provider === 'weavefox') return { kind: 'weavefox', query, url };
        if (provider === 'none')     return { kind: 'no-result', query };
        const target = iconifyUrl(query);
        return target ? { kind: 'iconify', query, url: target } : { kind: 'no-result', query };
    }

    if (provider === 'none') return { kind: 'blocked', url };
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { kind: 'blocked', url };
    return { kind: 'remote', url };
}

/** The body the library expects back from its icon search endpoint. */
export function iconSearchBody(svg: string | null): string {
    return JSON.stringify(svg ? { success: true, data: [svg] } : { success: false, data: [] });
}
