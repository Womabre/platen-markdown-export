# Themes and covers

How a theme is found, loaded and applied, and the cover rules every theme must follow. Authoring a theme is in [`docs/THEMES.md`](../THEMES.md). Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## What ships

Themes are folders under `themes/`. Built-in names match the folder case-insensitively.

- `default`: the brand-neutral fallback, aligned with the Marp default theme. The mixu/markdown-styles ports build on its base CSS and override only colours, typography and background.
- `gaia`, `uncover`: mirror those Marp themes. `github`: mirrors GitHub's rendered-markdown look.
- `modern`: the full brand-package showcase, with fifteen fruit-named palettes, per-style hero photography, a `logos` map and `paletteRoles`.
- Layouts that share a prefix are one theme whose **styles** carry the per-variant fonts, background and colours: `jasonm23` (Dark, Foghorn, Markdown, Swiss), `mixu` (Book, Bootstrap, Bootstrap2col, Gray, Page, Radar), `solarized` (Dark, Light).
- Single-layout ports stay standalone: `bootstrap3`, `markedapp-byword`, `roryg-ghostwriter`, `witex`.

The repo holds no vendor-specific brand theme. `modern` plus the `themes/acme-logo-*.svg` marks are the placeholder brand.

## Themes (`theme.ts`, `themes/<name>/theme.json`)

A theme is a brand package: logos, fonts, CSS, cover and revision HTML templates, colour `palettes` and named cover `styles`.

**Loading.** `loadTheme(nameOrPath)` reads the manifest, resolves every asset path to absolute, validates that required files exist (exit 3), computes each style's gradient and main colour from its palette ref and overlay, and resolves fonts (a literal `url`, or a named `env` var).

**Selection**, in `main()`: `--theme`, then `Theme` frontmatter, then `EXPORT_THEME`, then `default`. The active theme is a singleton: `setActiveTheme` in `main()`, lazy `getActiveTheme()` elsewhere.

**CSS variables.** `buildThemeVarsCss` (`css.ts`) injects the manifest's typography (`fontFamily`, `fontSize`) and `background` as `--font-body`, `--fs-h1`…, `--page-bg`. `buildPageCss` bakes the `@page`-safe tokens `{{PAGE_FONT}}` and `{{PAGE_BG}}`. The theme CSS references these.

**`theme.json` is the single source of truth for brand colour.** `buildThemeVarsCss` emits every palette as `--<slug>-<stop>` variables plus one `--gradient-<slug>` per palette (slug is the lowercase palette name). A theme's CSS never restates a hex value. No test enforces this; it is held by review.

**A palette's stop names are not its document roles.** A ramp authored for screens often has a pale tint at `main`, which washes out printed headings, table headers and cover gradients. The optional `paletteRoles` map names which stop plays each document role (`main`, `light`) per palette. `roleColor` resolves it and defaults to the identically named stop, so themes without the key are unaffected. Only `modern` uses it today (every fruit palette maps `main` to its `dark` stop). The emitted CSS variables still carry the manifest's values verbatim; only the exporter's choice of stop differs.

**Logos.** `EXPORT_PDF_LOGO[_WHITE]` override the theme's logos. So does the `Logo` frontmatter key through `applyLogoOverride`: a name from the manifest's optional `logos` map, or a path. An unknown name exits 3.

**Styles.** The `Style` frontmatter key picks a named style or gives a `{Color, Image, Position}` object (`resolveStyle`, `resolveStyleMainColor`, `buildStyleOverrideCss`). A named style may also carry `fontFamily`, `background`, `cssVars` and `fontImport`, which is what lets one theme host several looks.

- **`applyStyleOverrides(style)` runs in `main()` right after `setActiveTheme`, before `buildThemeVarsCss` and `buildPageCss`.** It overlays the style's font and background onto the singleton. Those builders bake the values into `@page`, where a later CSS variable cannot reach.
- `buildStyleOverrideCss` is injected last in `<head>` and emits the style's `--brand-main`, its extra `cssVars` and the `@import` for its web font.

## Theme search path (`theme.ts`)

`--theme` accepts a directory. `--theme-path` / `EXPORT_THEME_PATH` add **discovery**: `setThemeRoots` installs extra roots, each holding one directory per theme like `themes/`. `listThemeEntries()` reports every discoverable theme with its directory and whether it is `builtin` or `external`.

- **External roots are searched before the bundled ones**, so an external theme shadows a built-in of the same name. Registering a folder called `default` is how the bundled one is overridden. The shadowing is logged.
- **`applyThemeRoots` runs inside `parseArgs`, before the `--list-themes` / `--list-styles` pre-pass.** Listing without the roots applied would print a different set from the one the next export resolves against.
- The search path is a CLI concept and not an editor setting, because the terminal, the VS Code extension and any other driver must agree on which themes exist.

## Cover override slots

A cover frontmatter key reaches a theme only if that theme's `html/cover-page.html` renders the matching token. A missing slot fails silently.

- `src/tests/cover.test.ts` asserts the full slot set per theme.
- **Audit trap**: the templates list their own tokens in a header comment. A grep-based check must strip comments and the standalone-preview `<script>` block before deciding a slot exists.
- `Cover Footer Logo` drives both `{{LOGO_IMG}}` and `{{LOGO_DARK_IMG}}`, since light-background layouts (`markedapp-byword`, `witex`) render the dark variant.

## Cover title colour

Every theme's `cover.css` expresses title, subtitle and rule colours as `var(--cover-title-color, <own value>)`. `buildCoverCss` sets that property on `.cover-page` for the `Cover Title Color` frontmatter key and leaves it unset otherwise.

The inherited custom property is what reaches every theme. Override rules cannot: themes draw the title's rule differently (bottom border, full box, left bar, `::after` strip), and each renders through its own layout class (`.cover-l4`, `.cover-mx`, …) that outranks a bare `.cover-title` selector.

A per-theme test in `src/tests/cover.test.ts` fails the build when a theme hardcodes one of those colours.
