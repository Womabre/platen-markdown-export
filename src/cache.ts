import * as fs     from 'fs';
import * as os     from 'os';
import * as path   from 'path';
import * as crypto from 'crypto';
import { windowsAppDir } from './fsutil';

/**
 * On-disk cache for immutable remote assets.
 *
 * Two kinds of thing an export fetches never change once fetched: an icon-font
 * stylesheet at a pinned CDN version, and a Twemoji SVG at a pinned release.
 * Everything else — a logo behind a URL the user controls, a document's own
 * remote image — can change under us and is deliberately not cached here.
 *
 * The icon cache was already doing this; the emoji were not, so a document with
 * three emoji hit a CDN three times on every single save-triggered export. That
 * is the offline story as much as the speed one: the same document should export
 * on a train.
 */

/**
 * Per-user cache root, split by namespace.
 *
 * NOT a shared temp directory. Entries here are trusted on the next read and
 * inlined into a PDF, so a world-writable path would let anyone on the machine
 * choose what lands in another user's documents (base64 `@font-face` payloads
 * included). A directory under the user's own home, created 0700, removes the
 * shared namespace and the write permission together.
 *
 * Falls back to a private subdirectory of tmpdir on a system with no usable home
 * directory, which is still better than the shared root.
 *
 * Parameterised so the platform branches — three of which are unreachable from
 * the machine running the suite — can be asserted directly, including the
 * security property above: with a home directory available, the result is never
 * under the shared tmpdir.
 */
export function cacheDir(
    namespace: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    if (!home) return path.join(os.tmpdir(), `platen-markdown-export-${process.getuid?.() ?? 'user'}`, namespace);
    if (platform === 'win32')
        // `home` is non-empty here (guarded above), so this never returns null.
        return path.join(windowsAppDir('Local', env, home)!, 'platen-markdown-export', namespace);
    if (platform === 'darwin')
        return path.join(home, 'Library', 'Caches', 'platen-markdown-export', namespace);
    return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'),
                     'platen-markdown-export', namespace);
}

/**
 * The directory holding every namespace — what `--clear-cache` removes.
 *
 * `cacheDir` appends the namespace to this, so clearing the parent clears all of
 * them at once and leaves nothing behind to guess at.
 */
export function cacheRoot(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    return path.dirname(cacheDir('any', platform, env, home));
}

/**
 * Empties the cache, returning the directory removed and whether it was there.
 *
 * Entries here are trusted on the next read and inlined straight into a PDF —
 * a base64 `@font-face` payload, a Twemoji SVG — and nothing expires them or
 * bounds their size. That is fine while every entry is what it claims to be, and
 * unrecoverable when one is not: a truncated write or a bad fetch is served
 * happily forever, and until now the only remedy was knowing the platform's
 * cache path and deleting it by hand. An escape hatch that needs documentation
 * to find is not an escape hatch.
 */
export function clearCache(): { dir: string; existed: boolean } {
    const dir = cacheRoot();
    const existed = fs.existsSync(dir);
    if (existed) fs.rmSync(dir, { recursive: true, force: true });
    return { dir, existed };
}

/**
 * Schema version stamped onto every entry filename.
 *
 * The cache had no invalidation story at all: no expiry, no size bound, and no
 * way to say "the code that produced this changed". An entry is trusted on the
 * next read and inlined straight into a PDF, so a release that alters how CSS is
 * flattened or how an image is encoded would keep serving output built by the
 * previous release, indefinitely, on every machine that had exported once.
 *
 * Bump this whenever the *shape* of a cached value changes — not on every
 * release. Entries carrying an older stamp become unreadable by construction
 * (the filename no longer matches) and are swept by {@link pruneStaleEntries},
 * so a bump costs one re-fetch and leaves nothing behind.
 */
export const CACHE_SCHEMA = 'v1';

/**
 * Where one key lands. The key is hashed, so a URL is a legal filename; the
 * schema is a plain prefix so stale entries can be recognised without reading
 * them.
 */
function entryPath(namespace: string, key: string, ext: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(cacheDir(namespace), `${CACHE_SCHEMA}-${hash}${ext}`);
}

/** Namespaces already swept this process — the sweep is per-run, not per-write. */
const pruned = new Set<string>();

/**
 * Deletes entries left by an older {@link CACHE_SCHEMA}.
 *
 * Without this a schema bump would leak the whole previous generation onto disk
 * forever: unreachable, unbounded, and removable only by knowing the platform's
 * cache path. Best-effort and once per namespace per process — it is tidying,
 * and must never be a reason an export fails.
 */
function pruneStaleEntries(namespace: string): void {
    if (pruned.has(namespace)) return;
    pruned.add(namespace);
    try {
        const dir = cacheDir(namespace);
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith(`${CACHE_SCHEMA}-`)) continue;
            fs.rmSync(path.join(dir, name), { force: true });
        }
    } catch { /* nothing cached yet, or unreadable — either way nothing to tidy */ }
}

/** The cached value for `key`, or null when there is none (or it is unreadable). */
export function readCache(namespace: string, key: string, ext = '.txt'): string | null {
    try {
        return fs.readFileSync(entryPath(namespace, key, ext), 'utf8');
    } catch {
        return null;
    }
}

/** Stores a value. Best-effort: a cache that cannot be written must never fail an export. */
export function writeCache(namespace: string, key: string, value: string, ext = '.txt'): void {
    try {
        // 0700/0600: the entry is trusted on the next read, so nobody else may
        // write it. (A no-op on Windows, where the per-user LOCALAPPDATA path is
        // already outside other accounts' reach.)
        fs.mkdirSync(cacheDir(namespace), { recursive: true, mode: 0o700 });
        pruneStaleEntries(namespace);
        fs.writeFileSync(entryPath(namespace, key, ext), value, { encoding: 'utf8', mode: 0o600 });
    } catch { /* best-effort cache */ }
}
