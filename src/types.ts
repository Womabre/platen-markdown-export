// ── Shared types ──────────────────────────────────────────────────────────────

export interface FontConfig {
    name: string;
    url: string;
    family: string;
    weight: number;
    style: string;
}

// Tool-level config (theme/brand data lives in a Theme, see below).
export interface Config {
    weasyprintDpi: number;
    fetchTimeoutMs: number;
    imageJpegQuality: number;
    maxResponseBytes: number;
    /** Max renderers in flight at once (Mermaid pages, image decodes). */
    concurrency: number;
    /**
     * Allow remote fetches to reach loopback, link-local and private-network
     * addresses. Off by default; see `assertPublicHost` in `fetch.ts`.
     */
    allowPrivateHosts: boolean;
    /**
     * `EXPORT_PDF_VARIANT` default, applied when `--pdf-variant` is not given.
     * Null (the default) produces an ordinary PDF.
     */
    pdfVariant: string | null;
    /**
     * `EXPORT_INFOGRAPHIC_ICONS` default, applied when `--infographic-icons` is
     * not given. `iconify` unless the environment says otherwise.
     */
    infographicIcons: 'iconify' | 'weavefox' | 'none';
}

export interface ColorPalette {
    extraLight: string;
    light: string;
    main: string;
    regular: string;
    medium: string;
    dark: string;
    extraDark: string;
}

/**
 * Roles a document draws from a palette: `main` tints headings, table headers
 * and the cover gradient's start; `light` is the gradient's end. A theme can
 * point these at any ramp stop via `paletteRoles` — see ThemeManifest.
 */
export type PaletteRole = 'main' | 'light';

// ── Theme (brand package) ─────────────────────────────────────────────────────

/** A style entry as authored in a theme's theme.json manifest (declarative). */
export interface StyleManifestEntry {
    /** Hero/cover image path, relative to the theme directory (or a URL). */
    image?: string;
    /** Horizontal crop offset 0–1 (default 0.5). */
    position?: number;
    /** Palette name (from the theme's `palettes`) used to build the gradient. */
    palette?: string;
    /** Explicit hex colour, used instead of a palette reference. */
    color?: string;
    /** Gradient overlay opacity as [start, end]; defaults to [0.6, 1]. */
    overlay?: [number, number];
    /** Fully-formed CSS gradient string, overriding palette/colour/overlay. */
    gradient?: string;
    /** Per-style typography, overriding the theme's `fontFamily`. */
    fontFamily?: { body?: string; heading?: string };
    /** Per-style page/body background, overriding the theme's `background`. */
    background?: string;
    /** Extra body-content CSS variables to inject (e.g. `--link-color`, `--code-bg`). */
    cssVars?: Record<string, string>;
    /** Web-font stylesheet URL to `@import` for this style. */
    fontImport?: string;
}

/** Raw theme.json manifest shape (paths relative to the theme directory). */
export interface ThemeManifest {
    name: string;
    slogan?: string;
    address?: string[];
    logo: string;
    logoWhite: string;
    css: { stylesheet: string; page: string; cover: string };
    html: { cover: string; revision: string };
    fonts?: Array<{ name: string; env?: string; url?: string; family: string; weight: number; style?: string }>;
    /** CSS font-family stacks for body text and headings. */
    fontFamily?: { body?: string; heading?: string };
    /** CSS font sizes for body text and each heading level. */
    fontSize?: { body?: string; h1?: string; h2?: string; h3?: string; h4?: string; h5?: string; h6?: string };
    /** Page/body background colour (default: none → white). */
    background?: string;
    defaultPalette?: string;
    palettes: Record<string, ColorPalette>;
    styles: Record<string, StyleManifestEntry>;
    /** Named brand logos selectable via the `Logo:` frontmatter key. */
    logos?: Record<string, string>;
    /**
     * Per-palette override of which ramp stop plays a document role, e.g.
     * `{ Cherry: { main: "dark" } }`. Lets a theme mirror an upstream ramp
     * verbatim while still choosing print-appropriate colours from it.
     * Any palette or role left out falls back to the identically-named stop.
     */
    paletteRoles?: Record<string, Partial<Record<PaletteRole, keyof ColorPalette>>>;
    /**
     * Per-palette naming overrides for the CSS a palette generates.
     *
     * `slug` replaces the default lowercased palette name in `--<slug>-<stop>`
     * and `--gradient-<slug>`; `aliases` add extra class-name spellings beside
     * `.<theme>-<slug>-scheme`. Both exist for one reason: a theme ported from
     * another project whose variable and class names a document may already
     * carry, where the ramp is named one way and its scheme class another. Such
     * a mapping is data about that theme, so it lives in its manifest rather
     * than as a special case in the exporter.
     *
     * e.g. `{ "SeaGreen": { "slug": "sea", "aliases": ["seaGreen"] } }` emits
     * `--sea-main` and matches both `.<theme>-sea-scheme` and
     * `.<theme>-seaGreen-scheme`. Omitted palettes use the lowercased name and
     * no aliases.
     */
    paletteNames?: Record<string, { slug?: string; aliases?: string[] }>;
}

/** A resolved style: image path absolute, gradient and main colour computed. */
export interface StyleConfig {
    image?: string;
    position?: number;
    gradient: string | null;
    mainColor: string | null;
    /** Resolved palette key this style draws from (for image-overlay gradients). */
    palette?: string;
    fontFamily?: { body?: string; heading?: string };
    background?: string;
    cssVars?: Record<string, string>;
    fontImport?: string;
}

/** A loaded theme — manifest with all file paths resolved to absolute. */
export interface Theme {
    name: string;
    dir: string;
    slogan: string;
    address: string[];
    logo: string;
    logoWhite: string;
    stylesheetFile: string;
    pageCssFile: string;
    coverCssFile: string;
    revisionHtmlFile: string;
    coverHtmlFile: string;
    fallbackFonts: FontConfig[];
    fontBody: string;
    fontHeading: string;
    fontSizes: { body: string; h1: string; h2: string; h3: string; h4: string; h5: string; h6: string };
    background: string;
    defaultPalette: string;
    palettes: Record<string, ColorPalette>;
    styles: Record<string, StyleConfig>;
    /** Named brand logos (absolute paths), selectable via `Logo:` frontmatter. */
    logos: Record<string, string>;
    /** Per-palette role → ramp-stop overrides; see ThemeManifest.paletteRoles. */
    paletteRoles: Record<string, Partial<Record<PaletteRole, keyof ColorPalette>>>;
    /** Per-palette CSS slug/class-alias overrides; see ThemeManifest.paletteNames. */
    paletteNames: Record<string, { slug?: string; aliases?: string[] }>;
}

// ── Per-document style selection ──────────────────────────────────────────────

export interface ResolvedStyle {
    imageSource: string | null;
    position: number;
    gradient: string | null;
}

export interface StyleFrontmatter {
    /** Named style to base on (its palette/colour, fonts, background, cssVars). */
    name?: string | null;
    color?: string | null;
    image?: string | null;
    position?: number | null;
    /**
     * Gradient overlay opacity as [start, end], applied to `color` (or the
     * resolved palette/named-style colour) at the cover's 0% and 90% gradient
     * stops. Defaults to a flat 80% wash over an image, or fully opaque without
     * one — see `resolveStyle` in theme.ts.
     */
    overlay?: [number, number] | null;
}

export interface DocumentInfoEntry {
    label: string;
    value: string;
}

export interface RevisionEntry {
    revision: string;
    date: string;
    author: string;
    remarks: string;
}

export interface CoverLogoSpec {
    path: string;
    background: string | null;
}

/** Document sensitivity label shown in the top-right page margin. */
export type Classification = 'Public' | 'Internal' | 'Confidential';

export interface FrontmatterData {
    title: string;
    documentInfo: DocumentInfoEntry[];
    revisions: RevisionEntry[];
    revisionsVisible: number;
    revision: string | null;
    status: string | null;
    author: string | null;
    date: string | null;
    header: string | null;
    footer: string | null;
    lang: string;
    mode: string | null;
    theme: string | null;
    style: string | StyleFrontmatter | null;
    /**
     * Brand logo override — a name from the theme's `logos` map (e.g. `Cherry`
     * in the `modern` theme) or a path to an image. Independent of `style`, so a
     * document can carry one brand's logo while using a different cover style.
     */
    logo: string | null;
    coverLogo: CoverLogoSpec | null;
    /** Auto-number h2–h6 as 1, 1.1, 1.1.1 (numbers flow into the TOC too). */
    numberedHeadings: boolean;
    /** Replace the static top-left header with the current section's title. */
    runningHeader: boolean;
    /** Emit a "List of Tables" index after the TOC. */
    listOfTables: boolean;
    /** Emit a "List of Figures" index after the TOC. */
    listOfFigures: boolean;
    /** Diagonal watermark text, or null for none. */
    watermark: string | null;
    /** Number every line of every fenced code block. */
    codeLineNumbers: boolean;
    /**
     * Convert `(c)`, `(r)`, `(tm)` to ©/®/™. Off by default — those sequences
     * read as literal parentheticals far more often than as intended trademark
     * marks, so a document has to opt in.
     */
    trademarkSymbols: boolean;
    /** Sensitivity label for the top-right page margin (Public renders nothing). */
    classification: Classification | null;
    /** `{{Name}}` substitutions applied to the body before parsing. */
    variables: Record<string, string>;
    /** Deepest heading level (1–6) listed in the TOC; null = every level. */
    tocDepth: number | null;
    /** `PDF Variant` — a conformance level, validated against WeasyPrint's own enum. */
    pdfVariant: string | null;
    /** Paper size for `@page`, e.g. `A4`, `Letter`, or a literal `210mm 297mm`. */
    pageSize: string | null;
    /** `@page` margin shorthand, e.g. `20mm` or `25mm 15mm`. */
    margins: string | null;
    /** Orientation of every page unless a `::: portrait` / `::: landscape` block overrides it. */
    orientation: PageOrientation;
    /** Whether a cover page is generated at all (`Cover Page: false` suppresses it). */
    coverPage: boolean;
    /** Bottom-centre page-margin logo: replace with another mark, or drop it. */
    footerLogo: Override;
    /** Cover slogan line: replace the theme's, or drop it. */
    coverSlogan: Override;
    /** Cover address block: replace the theme's, or drop it. */
    coverAddress: Override;
    /** Cover bottom-right brand mark: replace with another, or drop it. */
    coverFooterLogo: Override;
    /**
     * Colour of the cover title, the rule beneath it, and the subtitle.
     * Same grammar as `Style.Color` — hex, `rgb()`/`rgba()`, or a palette
     * name. Null leaves each theme's own cover typography untouched.
     */
    coverTitleColor: string | null;
}

/**
 * A frontmatter override that can also switch its element off.
 *   `null`   — key absent, use the theme default
 *   `false`  — remove the element entirely
 *   `string` — replace the theme's value with this one
 */
export type Override = string | false | null;

/** Sheet orientation, from the `Orientation` frontmatter key. */
export type PageOrientation = 'portrait' | 'landscape';

/** Portrait dimensions of the named paper sizes, in millimetres. */
export interface PaperDimensions {
    /** Short edge — also the usable height once the page is rotated landscape. */
    widthMm: number;
    heightMm: number;
}

export interface FetchResult {
    buffer: Buffer;
    mimeType: string;
}

export interface CoverPage {
    css: string;
    html: string;
}

export interface ParsedArgs {
    inputFile: string;
    stylesheetPath: string | null;
    theme: string | null;
    mode: string | null;
    output: string | null;
    dpi: number | null;
    quiet: boolean;
    open: boolean;
    noBump: boolean;
    /**
     * `--release`: cut the release — append the revisions row, bump every
     * `Revision:` scalar and reset `Status`. Nothing else does this.
     */
    release: boolean;
    /**
     * `--no-revision-bump`: accepted and ignored. It suppressed the release
     * bump back when an ordinary export performed one; `--release` is now the
     * only thing that does, so there is nothing left to suppress. Kept so
     * existing scripts and the extension's older settings keep working.
     */
    noRevisionBump: boolean;
    /**
     * `--dry-run`: validate and report what would be written, then stop. Runs
     * every check an export runs — theme, style, colours, assets, output paths,
     * and WeasyPrint's presence when the mode includes pdf — but renders
     * nothing, writes nothing, and does not touch the source document.
     */
    dryRun: boolean;
    /** `--clear-cache`: empty the on-disk asset cache and exit. Reads no document. */
    clearCache: boolean;
    /**
     * `--strict`: exit 6 if the run raised any warning.
     *
     * An export whose image is missing, whose include does not resolve or whose
     * font failed to fetch still exits 0 and still writes a file — with the dead
     * reference in it. That is the right default for a draft and the wrong one
     * for a pipeline producing deliverables, which has no way to notice.
     */
    strict: boolean;
    /** `--setup`: install runtime dependencies and stop, with no document work. */
    setup: boolean;
    /** `--watch`: re-export whenever the input document changes, until interrupted. */
    watch: boolean;
    /**
     * `--inspect`: print the resolved frontmatter as JSON and stop.
     *
     * Reads the document and nothing else — no render, no write, no source
     * mutation. It exists because tooling needs to *ask* about a document before
     * acting on it: the VS Code extension checks whether the revision it is about
     * to release already carries a note, and the alternative was a second YAML
     * reader living in the editor.
     */
    inspect: boolean;
    /**
     * `--release-note`: the Remarks for the revision being released.
     *
     * The *outgoing* revision — the current last `Revisions` row, describing the
     * work being signed off — not the fresh row `--release` appends for the next
     * one. Null when not given. A usage error without `--release`.
     */
    releaseNote: string | null;
    /** `--theme-path`: extra theme search roots, in the order written. */
    themePaths: string[];
    /**
     * `--pdf-variant`: a PDF/A, PDF/UA or PDF/X conformance level, passed
     * through verbatim to WeasyPrint's own `--pdf-variant`. Null (the default)
     * produces an ordinary PDF with no conformance metadata.
     */
    pdfVariant: string | null;
    /**
     * `--infographic-icons`: where ```infographic icons come from. Null when not
     * given, so the `EXPORT_INFOGRAPHIC_ICONS` / built-in default applies.
     * Machine-level on purpose — there is deliberately no frontmatter key, so a
     * document received from someone else cannot opt this machine into sending
     * its text to a third party.
     */
    infographicIcons: 'iconify' | 'weavefox' | 'none' | null;
}

/**
 * The answers `--init --answers <file>` fills a frontmatter scaffold from.
 *
 * Every field optional: an answer that was not given falls back to the same
 * placeholder `--init` prints on its own, so a wizard that asks three questions
 * and one that asks twelve both produce a document that parses.
 */
export interface FrontmatterAnswers {
    title?: string;
    author?: string;
    date?: string;
    revision?: string | number;
    status?: string;
    theme?: string;
    style?: string;
    mode?: string;
    lang?: string;
    pageSize?: string;
    orientation?: string;
    margins?: string;
    classification?: string;
    watermark?: string;
    numberedHeadings?: boolean;
    runningHeader?: boolean;
    listOfTables?: boolean;
    listOfFigures?: boolean;
    codeLineNumbers?: boolean;
    tocDepth?: number;
    revisionsVisible?: number;
    remarks?: string;
}

/**
 * What one export reports back to its caller.
 *
 * `--watch` needs both halves: `sourceWritten` is how it recognises its own
 * write-back (the revision stamp) rather than looping on it, and `dependencies`
 * is what it subscribes to so that editing an include or an image re-exports the
 * document that uses it.
 */
export interface ExportResult {
    /** Content written back to the source document, or null when nothing was. */
    sourceWritten: string | null;
    /** Absolute paths the export read besides the document itself. */
    dependencies: string[];
}

export interface PageCssTokens {
    title: string;
    header: string | null;
    footer: string | null;
    date: string | null;
    revision: string | null;
    status: string | null;
    author: string | null;
    /** When true the top-left header tracks the current section via string(section). */
    runningHeader?: boolean;
    /** When true the top-right margin pulls in the running classification element. */
    classification?: boolean;
    /** Paper size for `@page`; omitted falls back to the theme/WeasyPrint default. */
    pageSize?: string | null;
    /** `@page` margin shorthand; omitted falls back to the 20mm default. */
    margins?: string | null;
    /** Orientation of the default `@page`; omitted means portrait. */
    orientation?: PageOrientation;
    /** Whether a cover page is being generated — `@page :first` dresses the cover. */
    hasCover?: boolean;
}
