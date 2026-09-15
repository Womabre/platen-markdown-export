import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { log } from './logger';
import { windowsAppDir } from './fsutil';
import { splitThemePath } from './theme';

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

/** The theme roots one config file contributes, resolved against its own directory. */
export function themePathsFrom(file: string, home: string = os.homedir()): string[] {
    const { themePaths } = readConfig(file);
    if (themePaths === undefined) return [];
    if (!Array.isArray(themePaths)) {
        log(`WARNING: ${file}: "themePaths" should be an array of directories — ignoring it`);
        return [];
    }
    const dir = path.dirname(file);
    return themePaths
        .filter((p): p is string => typeof p === 'string')
        .flatMap(p => splitThemePath(p))
        .map(p => path.resolve(dir, expandHome(p, home)));
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
    const files = [...findProjectConfigs(fromDir)];
    const user = userConfigPath(platform, env, home);
    if (user) files.push(user);
    return files.flatMap(f => themePathsFrom(f, home));
}
