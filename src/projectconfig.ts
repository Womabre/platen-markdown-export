import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { log } from './logger';
import { windowsAppDir } from './fsutil';
import { splitThemePath } from './theme';
import { unknownKeyWarnings } from './frontmatter-keys';

/**
 * Configuration a document's own project carries, discovered rather than passed.
 *
 * `--theme-path` made external themes usable; it did not make a document that
 * uses one *portable*. The flag has to be supplied on every invocation, so the
 * VS Code extension (which passes it from a setting) exported fine while the
 * same document from a task, a terminal or CI failed with "Theme not found" —
 * naming a theme that is installed, just not on that run's search path.
 *
 * A document is not portable if the only place its theme is known is one
 * editor's settings. So the search path is discovered the way every other tool
 * discovers project configuration: a file beside the work, found by walking up
 * from it, with a per-user file underneath as the machine-wide default.
 *
 * Precedence, highest first: `--theme-path` → `EXPORT_THEME_PATH` → the nearest
 * project config (then each one above it) → the user config. Nearest wins, and
 * nothing overrides an explicit flag.
 */

/** The file looked for while walking up from a document. */
export const CONFIG_FILENAME = 'platen-markdown-export.json';

/** How far up to walk before giving up — a guard against a pathological path, not a real limit. */
const MAX_WALK_DEPTH = 40;

/** What a config file may declare. Unknown keys are ignored, so the format can grow. */
export interface ProjectConfig {
    /**
     * Theme roots, each either a folder of theme folders or a theme itself.
     *
     * Relative entries resolve against the config file's own directory — which
     * is what makes a committed `{"themePaths": ["./themes"]}` work on every
     * machine that checks the repository out.
     */
    themePaths?: string[];
    /** Template roots, resolved the same way as `themePaths`. */
    templatePaths?: string[];
    /** Frontmatter keys applied to every document under this config that does not set them itself. */
    frontmatterDefaults?: Record<string, unknown>;
}

/**
 * Expands a leading `~` to the home directory.
 *
 * Config files are hand-written, and `~/Dev/themes` is what a person types. Only
 * a leading `~/` (or a bare `~`) counts: `~backup` is a directory name.
 */
export function expandHome(p: string, home: string = os.homedir()): string {
    if (p === '~') return home;
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
    return p;
}

/**
 * Every config file from `fromDir` upwards, nearest first.
 *
 * Stops at the filesystem root. Exported for testing — the walk is the part that
 * decides which project a document belongs to.
 */
export function findProjectConfigs(fromDir: string): string[] {
    const found: string[] = [];
    let dir = path.resolve(fromDir);

    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
        const candidate = path.join(dir, CONFIG_FILENAME);
        try {
            if (fs.statSync(candidate).isFile()) found.push(candidate);
        } catch { /* not here; keep climbing */ }

        const parent = path.dirname(dir);
        if (parent === dir) break;          // reached the root
        dir = parent;
    }
    return found;
}

/**
 * The per-user config, which is how a machine-wide theme folder is set once.
 *
 * Parameterised so the platform branches can be asserted from a machine that is
 * not on that platform, the same way `cacheDir` is.
 */
export function userConfigPath(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string | null {
    if (!home) return null;
    if (platform === 'win32') {
        const appData = windowsAppDir('Roaming', env, home);
        return appData ? path.join(appData, 'platen-markdown-export', 'config.json') : null;
    }
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'),
                     'platen-markdown-export', 'config.json');
}

/**
 * Reads one config file, returning nothing when it cannot be used.
 *
 * A malformed config warns rather than failing the export: it is a convenience
 * layer, and refusing to render a document because a file two directories up has
 * a stray comma would be a poor trade. The warning still reaches `--strict`.
 */
export function readConfig(file: string): ProjectConfig {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            log(`WARNING: ${file} should hold a JSON object — ignoring it`);
            return {};
        }
        return parsed as ProjectConfig;
    } catch (err: unknown) {
        log(`WARNING: ${file} is not valid JSON (${(err as Error).message}) — ignoring it`);
        return {};
    }
}

/** The directories one config file lists under `key`, resolved against its own directory. */
function pathsFrom(file: string, key: 'themePaths' | 'templatePaths', home: string): string[] {
    const paths = readConfig(file)[key];
    if (paths === undefined) return [];
    if (!Array.isArray(paths)) {
        log(`WARNING: ${file}: "${key}" should be an array of directories — ignoring it`);
        return [];
    }
    const dir = path.dirname(file);
    return paths
        .filter((p): p is string => typeof p === 'string')
        .flatMap(p => splitThemePath(p))
        .map(p => path.resolve(dir, expandHome(p, home)));
}

/** The theme roots one config file contributes, resolved against its own directory. */
export function themePathsFrom(file: string, home: string = os.homedir()): string[] {
    return pathsFrom(file, 'themePaths', home);
}

/** The template roots one config file contributes, resolved against its own directory. */
export function templatePathsFrom(file: string, home: string = os.homedir()): string[] {
    return pathsFrom(file, 'templatePaths', home);
}

/**
 * Theme roots declared by configuration, nearest project file first.
 *
 * `fromDir` is the document's own directory when there is one, so the config
 * that wins is the one beside the work rather than the one beside wherever the
 * command happened to be run.
 */
export function discoveredThemeRoots(
    fromDir: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string[] {
    return configFiles(fromDir, platform, env, home).flatMap(f => themePathsFrom(f, home));
}

/** Every config file that applies to `fromDir`, nearest project file first, the user config last. */
function configFiles(fromDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
    const files = [...findProjectConfigs(fromDir)];
    const user = userConfigPath(platform, env, home);
    if (user) files.push(user);
    return files;
}

/** Template roots declared by configuration, nearest project file first. */
export function discoveredTemplateRoots(
    fromDir: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string[] {
    return configFiles(fromDir, platform, env, home).flatMap(f => templatePathsFrom(f, home));
}

// ── Frontmatter defaults ──────────────────────────────────────────────────────

/**
 * Keys a default may not set.
 *
 * The revision keys because `--release` and the date stamp rewrite them in the
 * document itself, and a value that lives in a config file has no line there to
 * rewrite. `Title` because it names one document. `Mode` and `Export On Save`
 * because the VS Code extension reads them from the document's own text to
 * decide whether saving exports it: a default `Mode` would export from the
 * terminal and silently never on save.
 */
export const NOT_DEFAULTABLE = [
    'Title', 'Document Info', 'Revisions', 'Revision', 'Version', 'Status', 'Date', 'Mode', 'Export On Save',
] as const;

/** Frontmatter defaults in effect for a document, and which file each key came from. */
export interface FrontmatterDefaults {
    values: Record<string, unknown>;
    /** Key (as written) → the config file it came from, for the log line. */
    sources: Record<string, string>;
}

/**
 * The `frontmatterDefaults` of every config file that applies to `fromDir`,
 * merged so the nearest file wins per key.
 *
 * Keys are compared case-insensitively, as the frontmatter reader compares
 * them, so `theme` in a nearer file overrides `Theme` in a farther one.
 * `Variables` is merged per name rather than replaced, so a user config can
 * hold a company name while a project config adds the customer. A key that may
 * not be defaulted, or that looks like a misspelling of a real key, warns with
 * the file named and is ignored.
 */
export function discoveredFrontmatterDefaults(
    fromDir: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): FrontmatterDefaults {
    const values: Record<string, unknown> = {};
    const sources: Record<string, string> = {};
    const owner = new Map<string, string>();       // lowercased key → key as stored

    // Farthest first, so each nearer file overwrites what it repeats.
    for (const file of configFiles(fromDir, platform, env, home).reverse()) {
        const raw = readConfig(file).frontmatterDefaults;
        if (raw === undefined) continue;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            log(`WARNING: ${file}: "frontmatterDefaults" should be an object of frontmatter keys — ignoring it`);
            continue;
        }
        for (const warning of unknownKeyWarnings(raw)) log(`${warning.replace(/^WARNING: /, `WARNING: ${file}: `)}`);

        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (NOT_DEFAULTABLE.some(k => k.toLowerCase() === key.toLowerCase())) {
                log(`WARNING: ${file}: "${key}" cannot be a frontmatter default — set it in each document. Ignoring it.`);
                continue;
            }
            const lower = key.toLowerCase();
            const previous = owner.get(lower);
            if (lower === 'variables' && previous !== undefined && isMapping(values[previous]) && isMapping(value)) {
                values[previous] = { ...(values[previous] as object), ...(value as object) };
                sources[previous] = file;
                continue;
            }
            if (previous !== undefined) { delete values[previous]; delete sources[previous]; }
            values[key] = value;
            sources[key] = file;
            owner.set(lower, key);
        }
    }
    return { values, sources };
}

function isMapping(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
