import * as fs from 'fs';
import * as path from 'path';
import { ExitError } from './errors';
import { log } from './logger';
import { parseImageSpec } from './frontmatter';
import type {
    Theme,
    ThemeManifest,
    StyleManifestEntry,
    StyleConfig,
    ColorPalette,
    FontConfig,
    ResolvedStyle,
    StyleFrontmatter,
    PaletteRole,
} from './types';

// ── Built-in theme location ───────────────────────────────────────────────────

export const THEMES_DIR = path.join(__dirname, '..', 'themes');
export const DEFAULT_THEME = 'default';

// ── External theme roots ──────────────────────────────────────────────────────

/**
 * Extra directories searched for themes, each holding theme folders the way
 * `themes/` does.
 *
 * `--theme /abs/path` already worked, because `resolveThemeDir` accepts a
 * directory. What did not work was *discovery*: `listThemes` read only the
 * bundled directory, so an external theme could be exported with but never
 * listed, picked from a menu, or validated — and `--list-themes` told you it did
 * not exist. That is fine for one person with one path in their fingers and
 * useless for a UI, which is what the VS Code settings page needs.
 *
 * A search path rather than a setting on one surface, deliberately. The CLI, the
 * extension and anything else driving this tool have to agree about which themes
 * exist; if the registry lived in the extension's own settings, the terminal
 * could not see the same list.
 */
let _themeRoots: string[] = [];

/**
 * The project config file's name, as referenced by the theme-not-found message.
 *
 * Duplicated from `projectconfig.ts` rather than imported: that module imports
 * `splitThemePath` from here, and importing a value back would close a cycle at
 * module-initialisation time. `theme.test.ts` asserts the two agree.
 */
export const CONFIG_FILENAME = 'platen-markdown-export.json';

/** The `EXPORT_THEME_PATH` env var name — `PATH`-style, `path.delimiter`-separated. */
export const THEME_PATH_ENV = 'EXPORT_THEME_PATH';

/**
 * Splits a `PATH`-style list, dropping empty segments.
 *
 * Also accepts the platform's *other* delimiter, because the value is routinely
 * typed by hand into a settings file that gets shared across machines and a
 * Windows user pasting a colon-separated list should not silently get one root
 * named `C`. Windows paths carry a drive colon, so `:` is only treated as a
 * separator when the value contains no `;` and no drive-letter prefix.
 */
export function splitThemePath(value: string): string[] {
    const parts = value.includes(';') || /^[a-z]:[\\/]/i.test(value.trim())
        ? value.split(';')
        : value.split(path.delimiter === ';' ? /[;:]/ : path.delimiter);
    return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Replaces the external theme roots.
 *
 * Called once, early, by `parseArgs` — before `--list-themes` and `--list-styles`
 * run in their pre-pass, which is the whole reason it is a module-level setting
 * rather than a parameter threaded through `loadTheme`. Same shape as
 * `setActiveTheme` below.
 */
export function setThemeRoots(roots: readonly string[]): void {
    // Absolute, de-duplicated, and only directories that exist: a stale entry in
    // a shared settings file must not turn every theme lookup into a warning.
    const seen = new Set<string>();
    _themeRoots = roots
        .map(r => path.resolve(r))
        .filter(r => !seen.has(r) && (seen.add(r), true));
}

/** The external roots currently in effect, in search order. */
export function themeRoots(): readonly string[] { return _themeRoots; }

/** External roots from the environment, for callers that do not parse argv. */
export function themeRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    return splitThemePath(env[THEME_PATH_ENV] ?? '');
}

/** One discoverable theme: where it lives, and whether it shipped with the tool. */
export interface ThemeEntry {
    /**
     * The directory's own name — the stable identity `--theme` takes.
     *
     * Not the manifest's `name`: every shipped theme already disagrees with its
     * folder (`markedapp-byword` declares `Byword`), and the folder is what every
     * document, script and CI job in existence already writes.
     */
    name: string;
    /**
     * The manifest's `name`, which is what the theme calls itself.
     *
     * Also accepted by `--theme`, as an alias. A theme whose folder is
     * `acme-theme` and whose manifest says `Acme` has to resolve from a
     * document that writes `Theme: Acme`, because that is the name a person
     * sees everywhere else — on the cover, in the theme's own README.
     */
    displayName: string;
    dir: string;
    source: 'builtin' | 'external';
    /** The root it was found under — a builtin's is `THEMES_DIR`. */
    root: string;
}

/** Manifest names already read this process, keyed by path and mtime. */
const _manifestNames = new Map<string, { mtimeMs: number; name: string }>();

/**
 * The `name` a theme's manifest declares, or null when it cannot be read.
 *
 * Cached against the file's mtime so a `--watch` loop editing a theme picks the
 * new name up, and a document with thirteen themes on the search path does not
 * re-parse thirteen manifests on every lookup.
 */
function manifestName(dir: string): string | null {
    const manifestPath = path.join(dir, 'theme.json');
    try {
        const { mtimeMs } = fs.statSync(manifestPath);
        const hit = _manifestNames.get(manifestPath);
        if (hit && hit.mtimeMs === mtimeMs) return hit.name;

        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
        if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
        _manifestNames.set(manifestPath, { mtimeMs, name: parsed.name });
        return parsed.name;
    } catch {
        // A malformed manifest must not break *listing* — `loadTheme` is where
        // that becomes an error, with a message about the file it failed on.
        return null;
    }
}

// ── Colour helpers ────────────────────────────────────────────────────────────

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — the hex forms CSS accepts. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `rgb(…)` / `rgba(…)` in comma, space, or slash notation. */
const RGB_COLOR = /^rgba?\(([^()]*)\)$/i;

/** Anything a user plausibly meant as a literal rather than a palette name. */
const COLOR_LITERALISH = /^(?:#|rgba?\()/i;

/** True for a well-formed CSS colour literal (as opposed to a palette name). */
export function isColorLiteral(value: string): boolean {
    const c = value.trim();
    return HEX_COLOR.test(c) || RGB_COLOR.test(c);
}

/**
 * True when a literal already carries its own alpha channel — `#rrggbbaa`,
 * `#rgba`, `rgba(r,g,b,a)`, or the CSS Color 4 slash form `rgb(r g b / a)`.
 * Such a colour is left alone by `alpha()`: an explicit channel always wins
 * over the cover overlay's default.
 */
export function hasAlphaChannel(value: string): boolean {
    const c = value.trim();
    if (c.startsWith('#')) return c.length === 5 || c.length === 9;
    const m = c.match(RGB_COLOR);
    if (!m) return false;
    return m[1].includes('/') || m[1].split(',').length >= 4;
}

/** Strips any alpha channel, yielding the solid tone. Non-literals pass through. */
export function opaque(value: string): string {
    const c = value.trim();
    if (!hasAlphaChannel(c)) return c;
    if (c.startsWith('#')) return c.length === 5 ? c.slice(0, 4) : c.slice(0, 7);
    const inner = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')'));
    const rgb = inner.includes('/')
        ? inner.slice(0, inner.indexOf('/')).trim()
        : inner.split(',').slice(0, 3).map(p => p.trim()).join(', ');
    return `rgb(${rgb})`;
}

/**
 * Applies an alpha channel (0–1) to a colour.
 *
 * `#rrggbb` gains a two-digit hex channel (`#rrggbbaa`), `#rgb` is expanded
 * first, and `rgb(…)` becomes `rgba(…)`. A colour that already carries alpha is
 * returned untouched — that is what lets a document override the cover overlay's
 * hardcoded opacity by writing `Color: "#EC018C50"` instead of `"#EC018C"`.
 */
export function alpha(color: string, opacity: number): string {
    let c = color.trim();
    if (hasAlphaChannel(c)) return c;

    const m = c.match(RGB_COLOR);
    if (m) {
        const parts = m[1].split(/[\s,]+/).filter(Boolean);
        return `rgba(${parts.join(', ')}, ${Number(opacity.toFixed(4))})`;
    }

    // #rgb → #rrggbb, so the appended channel lands on a six-digit base.
    if (c.length === 4) c = '#' + [...c.slice(1)].map(ch => ch + ch).join('');
    return c + Math.round(opacity * 255).toString(16).padStart(2, '0');
}

/**
 * Classifies a `Style.Color` value as an explicit CSS literal or a palette name.
 * A value that looks like a literal but doesn't parse throws rather than falling
 * through to the palette lookup: emitting malformed CSS makes WeasyPrint drop the
 * whole `background-image` declaration, which silently blanks the cover.
 */
function classifyStyleColor(color: string): 'literal' | 'palette' {
    const c = color.trim();
    if (!COLOR_LITERALISH.test(c)) return 'palette';
    if (!isColorLiteral(c))
        throw new ExitError(
            `Invalid colour "${color}" — expected #rgb, #rgba, #rrggbb, #rrggbbaa, ` +
            'rgb(…), rgba(…), or a palette name.',
            2,
        );
    return 'literal';
}

function buildGradient(main: string, [start, end]: [number, number]): string {
    return `linear-gradient(150deg, ${alpha(main, start)} 0%, ${alpha(main, end)} 90%)`;
}

// ── Palette roles ─────────────────────────────────────────────────────────────

/**
 * The colour a palette contributes for a document role.
 *
 * Defaults to the identically-named stop, so a theme that declares no
 * `paletteRoles` behaves exactly as before. It exists for a theme whose ramps
 * are ported verbatim from somewhere else — the shared CSS variables have to
 * match that source exactly — while still drawing print colours from the stop
 * that suits a page. A ramp authored for the screen frequently puts a pale tint
 * at `main`, which washes out headings and table headers on paper; `modern` maps
 * every fruit palette's `main` role to its `dark` stop for exactly that reason.
 */
function roleColor(
    paletteName: string | undefined,
    palette: ColorPalette | undefined,
    role: PaletteRole,
    roles?: Record<string, Partial<Record<PaletteRole, keyof ColorPalette>>>,
): string | undefined {
    if (!palette) return undefined;
    const stop = paletteName ? roles?.[paletteName]?.[role] : undefined;
    return palette[stop ?? role];
}

/** `roleColor` against the active theme — the common case away from load time. */
function activeRoleColor(paletteName: string | undefined, role: PaletteRole): string | undefined {
    const theme = getActiveTheme();
    const palette = paletteName ? theme.palettes[paletteName] : undefined;
    return roleColor(paletteName, palette, role, theme.paletteRoles);
}

// ── Manifest → resolved style ─────────────────────────────────────────────────

function resolveStyleEntry(
    entry: StyleManifestEntry,
    dir: string,
    palettes: Record<string, ColorPalette>,
    defaultPalette: string,
    paletteRoles: Record<string, Partial<Record<PaletteRole, keyof ColorPalette>>>,
): StyleConfig {
    // Main colour: explicit hex wins, else the referenced (or default) palette.
    const paletteName = entry.palette ?? defaultPalette;
    const mainColor = entry.color
        ?? roleColor(paletteName, palettes[paletteName], 'main', paletteRoles)
        ?? roleColor(defaultPalette, palettes[defaultPalette], 'main', paletteRoles)
        ?? null;

    const overlay = entry.overlay ?? [0.6, 1];
    const gradient =
        entry.gradient ??
        (mainColor ? buildGradient(mainColor, overlay) : null);

    const image = entry.image
        ? (/^https?:\/\//.test(entry.image) ? entry.image : path.resolve(dir, entry.image))
        : undefined;

    return {
        image,
        position: entry.position,
        gradient,
        mainColor,
        palette: entry.palette ?? defaultPalette,
        fontFamily: entry.fontFamily,
        background: entry.background,
        cssVars: entry.cssVars,
        fontImport: entry.fontImport,
    };
}

function resolveFonts(manifest: ThemeManifest): FontConfig[] {
    return (manifest.fonts ?? [])
        .map(f => {
            const url = f.env ? process.env[f.env] : f.url;
            if (!url) return null;
            return { name: f.name, url, family: f.family, weight: f.weight, style: f.style ?? 'normal' };
        })
        .filter((f): f is FontConfig => f !== null);
}

// ── Theme loading ─────────────────────────────────────────────────────────────

/**
 * Resolves a theme reference to its directory + manifest path.
 * Accepts a built-in theme name (under themes/), a theme directory, or a
 * direct path to a theme.json file.
 */
function resolveThemeDir(nameOrPath: string): { dir: string; manifestPath: string } {
    const candidates: string[] = [];
    if (nameOrPath.endsWith('.json')) {
        candidates.push(nameOrPath);
    } else {
        candidates.push(path.join(nameOrPath, 'theme.json'));          // explicit dir

        // By name, across every root, external first. Matched case-insensitively
        // so `Theme: Default` resolves to `themes/default` on a case-sensitive
        // filesystem — and against the manifest's own name as well as the
        // folder's, because those disagree for every theme that ships here
        // (`markedapp-byword` declares `Byword`) and a document is as likely to
        // write one as the other.
        const wanted = nameOrPath.toLowerCase();
        const matches = listThemeEntries()
            .filter(e => e.name.toLowerCase() === wanted || e.displayName.toLowerCase() === wanted);

        // Shadowing is allowed — registering a folder called `default` is how you
        // override the bundled one — but never silent: a document that suddenly
        // renders in someone else's brand should say which folder it came from.
        if (matches.length > 1 && matches[0].source === 'external') {
            log(`Theme "${matches[0].name}" resolved from ${matches[0].dir} ` +
                `(shadows the ${matches[1].source} theme at ${matches[1].dir})`);
        }

        for (const m of matches) candidates.push(path.join(m.dir, 'theme.json'));
    }
    for (const manifestPath of candidates) {
        if (fs.existsSync(manifestPath))
            return { dir: path.dirname(manifestPath), manifestPath };
    }
    // What IS available, not just where we looked. "Theme not found" plus a list
    // of directories asks you to go and check them by hand; the names are the
    // thing that answers the question — a folder whose manifest calls it
    // something else shows both, since either spelling resolves.
    const available = listThemeEntries()
        .map(e => (e.displayName.toLowerCase() === e.name.toLowerCase()
            ? e.name
            : `${e.name} (${e.displayName})`));
    const known = available.length
        ? `\nAvailable: ${[...new Set(available)].sort().join(', ')}`
        : '\nNo themes are installed or on the theme search path.';
    const roots = _themeRoots.length
        ? `\nSearched: ${[..._themeRoots, THEMES_DIR].join(', ')}`
        : '';
    // The durable fix, named where the failure is seen. An external theme that
    // resolves in one editor and nowhere else is the shape this message is
    // usually reporting — a search path supplied per invocation rather than
    // recorded next to the work.
    const hint =
        '\nTo make an external theme resolve everywhere — a task, a terminal, CI — put a\n' +
        `${CONFIG_FILENAME} beside the document (or anywhere above it):\n` +
        '  { "themePaths": ["../themes", "~/Dev/my-theme"] }';
    throw new ExitError(
        `Theme not found: "${nameOrPath}". Looked for ${candidates.join(', ')}.${known}${roots}${hint}`,
        3,
    );
}

function requireFile(p: string, label: string): string {
    if (!fs.existsSync(p))
        throw new ExitError(`Theme ${label} not found: ${p}`, 3);
    return p;
}

export function loadTheme(nameOrPath: string): Theme {
    const { dir, manifestPath } = resolveThemeDir(nameOrPath);

    let manifest: ThemeManifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ThemeManifest;
    } catch (err: unknown) {
        throw new ExitError(`Could not parse theme manifest ${manifestPath}: ${(err as Error).message}`, 3);
    }

    const defaultPalette = manifest.defaultPalette ?? Object.keys(manifest.palettes ?? {})[0];
    if (!defaultPalette)
        throw new ExitError(`Theme "${manifest.name}" defines no palettes`, 3);

    const resolve = (rel: string): string => path.resolve(dir, rel);

    const paletteRoles = manifest.paletteRoles ?? {};

    const styles: Record<string, StyleConfig> = {};
    for (const [name, entry] of Object.entries(manifest.styles ?? {}))
        styles[name] = resolveStyleEntry(entry, dir, manifest.palettes, defaultPalette, paletteRoles);

    const logos: Record<string, string> = {};
    for (const [name, rel] of Object.entries(manifest.logos ?? {}))
        logos[name] = requireFile(resolve(rel), `logo "${name}"`);

    const theme: Theme = {
        name: manifest.name,
        dir,
        slogan: manifest.slogan ?? '',
        address: manifest.address ?? [],
        logo:             requireFile(resolve(manifest.logo),            'logo'),
        logoWhite:        requireFile(resolve(manifest.logoWhite),       'logo (white)'),
        stylesheetFile:   requireFile(resolve(manifest.css.stylesheet),  'stylesheet'),
        pageCssFile:      requireFile(resolve(manifest.css.page),        'page CSS'),
        coverCssFile:     requireFile(resolve(manifest.css.cover),       'cover CSS'),
        coverHtmlFile:    requireFile(resolve(manifest.html.cover),      'cover HTML template'),
        revisionHtmlFile: requireFile(resolve(manifest.html.revision),   'revision HTML template'),
        fallbackFonts: resolveFonts(manifest),
        fontBody:    manifest.fontFamily?.body ?? 'system-ui, sans-serif',
        fontHeading: manifest.fontFamily?.heading ?? manifest.fontFamily?.body ?? 'system-ui, sans-serif',
        fontSizes: {
            body: manifest.fontSize?.body ?? '9pt',
            h1:   manifest.fontSize?.h1   ?? '2em',
            h2:   manifest.fontSize?.h2   ?? '1.5em',
            h3:   manifest.fontSize?.h3   ?? '1.17em',
            h4:   manifest.fontSize?.h4   ?? '1em',
            h5:   manifest.fontSize?.h5   ?? '0.83em',
            h6:   manifest.fontSize?.h6   ?? '0.75em',
        },
        background: manifest.background ?? '',
        defaultPalette,
        palettes: manifest.palettes,
        styles,
        logos,
        paletteRoles,
        paletteNames: manifest.paletteNames ?? {},
    };

    // Env overrides — let CI swap logos without editing a theme.
    if (process.env.EXPORT_PDF_LOGO)       theme.logo = process.env.EXPORT_PDF_LOGO;
    if (process.env.EXPORT_PDF_LOGO_WHITE) theme.logoWhite = process.env.EXPORT_PDF_LOGO_WHITE;

    return theme;
}

/**
 * Lists installed built-in themes (directories under themes/ with a theme.json).
 *
 * Symlinks count: a theme kept in its own repo (a brand package whose assets
 * must not live in this tree) is linked in as `themes/<name>` and is then
 * usable by name like any built-in. `readdirSync`'s Dirent does not follow
 * symlinks — `isDirectory()` is false for one — so entries are accepted on
 * either flag and the `theme.json` probe (which does follow the link) is what
 * actually decides.
 */
/** Builds one entry, taking the alias from the manifest when it is readable. */
function entryAt(dir: string, source: 'builtin' | 'external', root: string): ThemeEntry {
    const name = path.basename(dir);
    return { name, displayName: manifestName(dir) ?? name, dir, source, root };
}

/**
 * The themes a root offers.
 *
 * A root is normally a folder of theme folders, the way `themes/` is — but a
 * root that IS a theme (a `theme.json` directly inside) counts as one too.
 *
 * That second case is not a nicety. "Add my external theme" is what a person
 * means when they point this at `~/Dev/acme-theme`, and the distinction between
 * a theme and a folder of themes is obvious only once you already know the
 * answer. Getting it wrong produced "Theme not found", naming the theme rather
 * than the folder that did not contain it — which sends you looking in exactly
 * the wrong place. Accepting both removes the question.
 *
 * Never throws: a root that has been moved or deleted is an ordinary state for a
 * path typed into a settings file months ago, and it must not fail a lookup the
 * other roots would have answered.
 */
function themesUnder(root: string, source: 'builtin' | 'external'): ThemeEntry[] {
    try {
        if (fs.existsSync(path.join(root, 'theme.json'))) {
            return [entryAt(root, source, path.dirname(root))];
        }
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(d => (d.isDirectory() || d.isSymbolicLink())
                && fs.existsSync(path.join(root, d.name, 'theme.json')))
            .map(d => d.name)
            .sort()
            .map(name => entryAt(path.join(root, name), source, root));
    } catch {
        return [];
    }
}

/**
 * Every theme discoverable right now, external roots first.
 *
 * Order is the resolution order: an external theme **shadows** a builtin of the
 * same name. That direction is deliberate — someone who registers a folder
 * called `default` is overriding the bundled one on purpose, and the opposite
 * rule would make that impossible to do at all. {@link resolveThemeDir} warns
 * when it happens, so it is never silent.
 */
export function listThemeEntries(): ThemeEntry[] {
    return [
        ..._themeRoots.flatMap(root => themesUnder(root, 'external')),
        ...themesUnder(THEMES_DIR, 'builtin'),
    ];
}

/**
 * Theme names, de-duplicated and sorted.
 *
 * The name-only view the CLI's `--list-themes` and the `Theme:` lookup use;
 * {@link listThemeEntries} is the one a UI wants.
 */
export function listThemes(): string[] {
    return [...new Set(listThemeEntries().map(e => e.name))].sort();
}

// ── Active theme singleton ────────────────────────────────────────────────────

let _activeTheme: Theme | null = null;

/** Loads (and remembers) the active theme. Lazily defaults to the built-in theme. */
export function setActiveTheme(nameOrPath: string): Theme {
    _activeTheme = loadTheme(nameOrPath);
    return _activeTheme;
}

export function getActiveTheme(): Theme {
    if (!_activeTheme)
        _activeTheme = loadTheme(process.env.EXPORT_THEME || DEFAULT_THEME);
    return _activeTheme;
}

// ── Style resolution (per-document cover variant) ─────────────────────────────

/** Canonical style key matching `name` case-insensitively, or undefined. */
function findStyleKey(name: string): string | undefined {
    const styles = getActiveTheme().styles;
    const lower = name.toLowerCase();
    return Object.keys(styles).find(k => k.toLowerCase() === lower);
}

/** Canonical palette key matching `name` case-insensitively, or undefined. */
function findPaletteKey(name: string): string | undefined {
    const palettes = getActiveTheme().palettes;
    const lower = name.toLowerCase();
    return Object.keys(palettes).find(k => k.toLowerCase() === lower);
}

/**
 * Returns the primary solid colour for a style — the same colour used as the
 * cover gradient base. Used to tint body headings and table headers.
 *
 * - Named style string → the style's main colour (palette-derived), falling
 *   back to a matching palette name, then the theme's default palette.
 * - Custom style object → the literal colour, or a named palette's main.
 * Any alpha channel is stripped: on `Style.Color` alpha means "wash the cover
 * at this opacity", not "fade every heading and table header on every page".
 * Returns null when the style carries no colour information.
 */
export function resolveStyleMainColor(style: string | StyleFrontmatter | null): string | null {
    if (!style) return null;
    const theme = getActiveTheme();
    if (typeof style === 'string') {
        const styleKey = findStyleKey(style);
        if (styleKey) return theme.styles[styleKey].mainColor;
        const paletteKey = findPaletteKey(style);
        return activeRoleColor(paletteKey ?? theme.defaultPalette, 'main') ?? null;
    }
    // Object form with an explicit named style → that style's main colour.
    const named = namedStyleConfig(style);
    if (named) return named.mainColor ? opaque(named.mainColor) : null;
    const { color } = style;
    if (!color) return null;
    if (classifyStyleColor(color) === 'literal') return opaque(color);
    const key = findPaletteKey(color);
    return key ? activeRoleColor(key, 'main') ?? null : null;
}

/**
 * Resolves a user-supplied colour to a CSS value, using exactly the grammar
 * `Style.Color` accepts: a validated literal passes through unchanged, a palette
 * name yields that palette's document `main` stop. Shared so a second colour key
 * can never drift from the first.
 */
export function resolveColorValue(value: string): string {
    const c = value.trim();
    if (classifyStyleColor(c) === 'literal') return c;
    const key = findPaletteKey(c);
    const resolved = key ? activeRoleColor(key, 'main') : undefined;
    if (!resolved)
        throw new ExitError(
            `Unknown colour "${value}" — expected a hex or rgb()/rgba() literal, or a palette name.`,
            2,
        );
    return resolved;
}

/** The style name referenced by a style value — a bare string, or an object's `name`. */
function effectiveStyleName(style: string | StyleFrontmatter | null): string | null {
    if (typeof style === 'string') return style;
    return style?.name ?? null;
}

/** The resolved StyleConfig for a named style, or null (custom/unknown styles). */
function namedStyleConfig(style: string | StyleFrontmatter | null): StyleConfig | null {
    const name = effectiveStyleName(style);
    if (!name) return null;
    const key = findStyleKey(name);
    return key ? getActiveTheme().styles[key] : null;
}

/**
 * Overlays a named style's typography and background onto the active theme
 * singleton. These tokens are baked into `@page` rules and theme CSS vars at
 * build time (and so cannot be overridden by a late `:root` rule), so they must
 * be applied before the CSS pipelines run. No-op for custom `{Color, Image}`
 * styles and for styles that carry no font/background overrides — leaving every
 * existing single-style theme unchanged.
 */
export function applyStyleOverrides(style: string | StyleFrontmatter | null): void {
    const cfg = namedStyleConfig(style);
    if (!cfg) return;
    const theme = getActiveTheme();
    if (cfg.fontFamily?.body)    theme.fontBody = cfg.fontFamily.body;
    if (cfg.fontFamily?.heading) theme.fontHeading = cfg.fontFamily.heading;
    if (cfg.background)          theme.background = cfg.background;
}

/**
 * Applies the `Logo:` frontmatter override to the active theme.
 *
 * Accepts a name from the theme's `logos` map (case-insensitive, so `cherry`
 * and `Cherry` both work) or a path to an image file. Deliberately independent
 * of `Style:` — a document can run the Cherry mark on a Blueberry cover.
 *
 * Both logo slots are set: a named mark is a single full-colour SVG with no
 * white variant, so the same file serves the cover and the page footer.
 * Unknown names are a hard error (exit 3) rather than a silent fallback to the
 * house logo — a wrong brand mark on a client deliverable must not ship quietly.
 */
/**
 * Resolves a logo reference to an absolute file path: first a name from the
 * theme's `logos` map (case-insensitive), otherwise a path tried against the
 * theme directory and then as given. Shared by every logo override so a name
 * means the same thing wherever it is written, and an unknown one always fails
 * loudly (exit 3) rather than silently falling back to the house logo.
 */
export function resolveLogoPath(logo: string): string {
    const theme = getActiveTheme();

    const lower = logo.toLowerCase();
    const key = Object.keys(theme.logos).find(k => k.toLowerCase() === lower);
    if (key) return theme.logos[key];

    const candidates = [path.resolve(theme.dir, logo), path.resolve(logo)];
    const file = candidates.find(f => fs.existsSync(f));
    if (!file) {
        const names = Object.keys(theme.logos).join(', ') || '(none defined)';
        throw new ExitError(
            `Unknown logo "${logo}" — not a named logo of theme "${theme.name}" (${names}) and not a readable file path`,
            3,
        );
    }
    return file;
}

export function applyLogoOverride(logo: string | null): void {
    if (!logo) return;
    const theme = getActiveTheme();
    const file = resolveLogoPath(logo);
    theme.logo = file;
    theme.logoWhite = file;
}

/**
 * Builds a <style> block overriding the brand colour tokens in the theme
 * stylesheet so headings, table headers and borders reflect the document's
 * chosen style rather than the theme's default brand colour. For named styles
 * it also carries any per-style `cssVars` (e.g. `--link-color`, `--code-bg`)
 * and `fontImport` web-font, since this block is injected last in <head>.
 */
export function buildStyleOverrideCss(style: string | StyleFrontmatter | null): string {
    const main = resolveStyleMainColor(style);
    const cfg = namedStyleConfig(style);
    const cssVars = cfg?.cssVars ?? {};
    const extraVars = Object.entries(cssVars).map(([k, v]) => `${k}: ${v};`).join(' ');
    if (!main && !extraVars && !cfg?.fontImport) return '';

    // @import must be the first statement inside the <style> element.
    const importLine = cfg?.fontImport ? `@import url("${cfg.fontImport}");\n` : '';
    const brandLine = main ? `--brand-main: ${main};` : '';
    const rootLine = (brandLine || extraVars)
        ? `:root { ${[brandLine, extraVars].filter(Boolean).join(' ')} }\n`
        : '';
    const headingRules = main ? `.github-markdown-body h1,
.github-markdown-body h2,
.github-markdown-body h3,
.github-markdown-body h4,
.github-markdown-body h5,
.github-markdown-body h6 { color: ${main} !important; }
table { border-color: ${main}; }
table thead tr { background-color: ${main}; }
table thead tr th { border-color: ${main}; }
` : '';

    return `<style>
${importLine}/* Style override (${typeof style === 'string' ? style : 'custom'}) */
${rootLine}${headingRules}</style>`;
}

export function resolveStyle(style: string | StyleFrontmatter): ResolvedStyle {
    const theme = getActiveTheme();

    if (typeof style === 'string') {
        const key = findStyleKey(style);
        const cfg = key ? theme.styles[key] : undefined;
        return {
            imageSource: cfg?.image ?? null,
            position:    cfg?.position ?? 0.5,
            gradient:    cfg?.gradient ?? null,
        };
    }

    const { color, image, position: explicitPosition } = style;
    const { src: imageSource, position: inlinePosition } = parseImageSpec(image ?? null);
    const position = explicitPosition ?? inlinePosition;
    const hasImage = !!imageSource;

    // Default overlay when the document doesn't supply its own `Overlay: [start, end]`:
    // a flat 80% wash so a photo underneath still reads through; fully opaque with
    // no image, since a translucent colour over the page background looks washed out.
    const defaultOverlay: [number, number] = hasImage ? [0.8, 0.8] : [1, 1];
    const overlay: [number, number] = style.overlay ?? defaultOverlay;

    // Object form with an explicit named style: take the named style's palette
    // main colour and the document's own image/position/overlay.
    const named = namedStyleConfig(style);
    if (named) {
        const pMain = activeRoleColor(named.palette, 'main');
        const gradient = (hasImage && pMain)
            ? buildGradient(pMain, overlay)
            : named.gradient ?? null;
        return {
            imageSource: imageSource ?? named.image ?? null,
            position:    explicitPosition ?? (hasImage ? inlinePosition : named.position ?? 0.5),
            gradient,
        };
    }

    let gradient: string | null = null;
    if (color) {
        if (classifyStyleColor(color) === 'literal') {
            gradient = buildGradient(color, overlay);
        } else {
            const paletteKey = findPaletteKey(color);
            const palette = paletteKey ? theme.palettes[paletteKey] : undefined;
            if (!palette) throw new Error(`Unknown style colour name: "${color}"`);
            const pMain = activeRoleColor(paletteKey, 'main') ?? palette.main;
            gradient = buildGradient(pMain, overlay);
        }
    }

    return { imageSource, position, gradient };
}
