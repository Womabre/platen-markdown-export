# Themes

A theme is a brand package: logos, fonts, CSS, cover and revision templates,
colour palettes and named cover styles. This is the reference for authoring or
customising one — see the [README](../README.md) for everything else.

A **theme** is a self-contained brand package — a folder under `themes/` holding
the CSS, fonts, logos, hero images, cover/revision HTML templates, colour
palettes and cover styles for one brand. The bundled themes:

| Theme                                                          | Look                                                                                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`                                                      | Aligned with the [Marp default theme](https://github.com/marp-team/marp-core/tree/main/themes) — navy headings, GitHub-dark text, blue links, Helvetica/Hiragino fonts. Used when no theme is specified. |
| `gaia`, `uncover`                                              | The Marp Gaia and Uncover themes.                                                                                                                                                                        |
| `modern`                                                       | A brand-neutral package with fifteen bright, fruit-named colour palettes (Cherry, Blueberry, Lime, …), each with its own cover photo and style.                                                          |
| [`platen`](../themes/platen/README.md)                           | Platen Markdown Export's house theme: serif typography, warm paper cover, paired printer's rules and the Platen wordmark. Ink, Oxblood, Forest and Indigo styles. |
| `github`                                                       | The [GitHub](https://github.com) markdown look — colors and typography from github-markdown-css, authored in the shared theme structure.                                                                 |
| `jasonm23`                                                     | Ports of the jasonm23 layouts as **styles**: `Dark`, `Foghorn`, `Markdown`, `Swiss`. Each style carries its own fonts, background and colours.                                                           |
| `mixu`                                                         | Ports of the [mixu/markdown-styles](https://github.com/mixu/markdown-styles) layouts as **styles**: `Book`, `Bootstrap`, `Bootstrap2col`, `Gray`, `Page`, `Radar`.                                       |
| `solarized`                                                    | Solarized in two **styles**: `Dark` and `Light`.                                                                                                                                                         |
| `bootstrap3`, `markedapp-byword`, `roryg-ghostwriter`, `witex` | Further ports of the mixu/markdown-styles layouts — the shared base structure with each layout's colors/typography/background.                                                                           |

Run `--list-themes` for the full list. Point `--theme` (or the `Theme`
frontmatter / `EXPORT_THEME` env var) at any built-in name, folder, or
`theme.json` path to rebrand without touching the code. Each bundled theme is
self-contained (its own CSS, HTML templates and logos), so it's a good starting
point to copy and tweak.

A theme is described by a declarative `theme.json` manifest (all paths are
relative to the theme directory):

```jsonc
{
  "name": "Acme",
  "slogan": "Acme. Build better.",
  "address": ["Acme Inc.", "1 Main St", "Anytown"],
  "logo": "logos/logo.svg",
  "logoWhite": "logos/logo-white.svg",
  "css":  { "stylesheet": "css/theme.css", "page": "css/page.css", "cover": "css/cover.css" },
  "html": { "cover": "html/cover-page.html", "revision": "html/revision-table.html" },
  "fonts": [
    { "name": "Brand Sans", "env": "ACME_FONT_URL", "family": "brand-sans", "weight": 400 }
  ],
  "fontFamily": {
    "body":    "\"brand-sans\", system-ui, sans-serif",
    "heading": "\"brand-sans\", system-ui, sans-serif"
  },
  "fontSize": {
    "body": "9pt", "h1": "2em", "h2": "1.5em", "h3": "1.17em",
    "h4": "1em", "h5": "0.83em", "h6": "0.67em"
  },
  "background": "#ffffff",
  "defaultPalette": "Acme",
  "palettes": {
    "Acme": { "extraLight": "#eef", "light": "#99f", "main": "#0033cc",
              "regular": "#2255dd", "medium": "#3366ee", "dark": "#002299", "extraDark": "#001144" }
  },
  "styles": {
    "none":  { "palette": "Acme", "overlay": [1, 1] },
    "Hero":  { "image": "hero/banner.webp", "position": 0.4, "palette": "Acme", "overlay": [0.6, 1] },
    "Slate": { "palette": "Acme", "background": "#1e1e1e", "fontImport": "https://…/css2?family=Inter",
               "fontFamily": { "body": "Inter, sans-serif", "heading": "Inter, sans-serif" },
               "cssVars": { "--link-color": "#7aa2f7", "--code-bg": "#2a2a2a" } }
  }
}
```

- **palettes** — named seven-stop colour scales. The `main` stop tints headings,
  table headers and gradients. Every palette is also emitted into the document as
  CSS variables — `--<name>-<stop>` in lowercase (`--cherry-main`,
  `--blueberry-extra-light`) plus a `--gradient-<name>` token (135°, `light` →
  `dark`) — so theme stylesheets reference the manifest instead of restating hex
  values. The manifest is the single source of truth; a theme's CSS should never
  redeclare a palette colour. See **paletteNames** below to override the slug a
  palette generates.
- **styles** — the per-document variants chosen with the `Style` frontmatter
  key. A style references a `palette` (or an explicit `color`) plus optional
  `image`, `position` (0–1 crop offset) and `overlay` (gradient start/end opacity,
  default `[0.6, 1]`); the gradient is computed from those, or a `gradient` string
  overrides it. A style may also carry its own **`fontFamily`** (`body`/`heading`),
  **`background`**, body-content **`cssVars`** (e.g. `--link-color`, `--code-bg`),
  and a **`fontImport`** web-font URL — letting one theme host several distinct
  looks as styles (see `jasonm23`, `mixu`, `solarized`). These override the
  theme-level values only for that style; a style that omits them inherits the
  theme defaults. Reference such a style from a document with a bare `Style: Name`
  string, or `Style: { Name, Image }` to add a cover photo. (A custom
  `{ Color, Image }` style sets the cover colour only, not these per-style overrides.)
  A document can override a style's `overlay` per export with its own top-level
  `Overlay: [start, end]` frontmatter key — see the frontmatter reference above.
- **`Cover Title Color`** (`Cover Title Colour` also works) recolours the cover
  title and subtitle in one go, along with the title's rule, box or accent bar in
  the themes that draw one — `modern` underlines the title, other layouts vary and
  some have no rule at all. It takes exactly the values `Style.Color` takes — a hex
  literal, `rgb()`/`rgba()`, or a palette name — and alpha behaves as you'd expect,
  so `"rgba(255,255,255,0.6)"` gives a softer headline over a busy photo. Omit the
  key and every theme keeps its own cover typography, unchanged. The same colour
  carries over to the `--mode html` banner's title and subtitle (no rule there).
- **`Cover Logo.Background`** takes the same values, so a backdrop can name a
  palette instead of repeating a hex. Every colour key is checked against that
  one grammar before the export starts, so a typo exits 2 immediately — naming
  the key that carried it — rather than rendering nothing or costing a full run.
- **`Style.Color` accepts** a palette name, a hex literal (`#rgb`, `#rgba`,
  `#rrggbb`, `#rrggbbaa`), or `rgb(…)`/`rgba(…)` in comma, space, or slash
  notation. Over a cover photo the colour is applied as an **80% wash** so the
  image reads through; giving the colour **its own alpha channel overrides that
  default** — `Color: "#EC018C50"` or `Color: "rgba(236,1,140,0.31)"` washes at
  ~31% instead. The alpha is cover-only: headings, table headers and
  `--brand-main` always take the solid tone, so a translucent wash never fades
  body content. Without a cover photo the colour is used at full strength unless
  you give it alpha. A value that starts like a literal but doesn't parse (e.g.
  `"#EC018C5"`) is rejected with exit code 2 rather than silently emitting CSS
  that WeasyPrint drops — which would blank the whole cover.
- **Cover template slots** — a theme's `html/cover-page.html` must carry a slot
  for every cover override, or that key silently does nothing on that theme: the
  frontmatter parses, the engine fills the token, and the layout never renders it.
  The required set is `{{COVER_TITLE_MAIN}}`, `{{COVER_SUBTITLE}}`,
  `{{COVER_INFO_ROWS}}`, `{{COVER_ADDRESS}}`, `{{COVER_SLOGAN}}`,
  `{{REVISION_TABLE}}`, `{{COVER_LOGO_IMG}}`, and either `{{LOGO_IMG}}` or
  `{{LOGO_DARK_IMG}}` (light-background layouts use the dark variant; `Cover
  Footer Logo` drives both). A theme that omits `{{COVER_SLOGAN}}` or
  `{{COVER_ADDRESS}}` should also let them collapse when emptied —
  `.cover-slogan:empty, .cover-address:empty { display: none; }` — since
  `Cover Slogan: false` blanks the slot rather than removing the element. A test
  walks every built-in theme and fails the build on a missing slot.
- **Cover CSS — `--cover-title-color`** (a stylesheet contract, not a manifest
  key) — every theme's `cover.css` has to honour it. Any colour it paints on `.cover-title` or `.cover-subtitle` —
  the text, the rule under the title, a box, a left accent bar, a `::after`
  strip — must be written as `var(--cover-title-color, <the theme's own value>)`.
  The exporter sets that property on `.cover-page` only when a document uses
  `Cover Title Color`, so the fallback is what normally renders and nothing
  changes by default. A bare colour literal there makes the theme silently ignore
  the frontmatter key, so a test walks every built-in theme and fails the build if
  one drifts.
- **Cover gradient direction** — element-based covers can layer
  `var(--cover-overlay), var(--cover-photo)` and set `--cover-overlay-angle`
  on `.cover-page` to rotate the standard colour gradient. It defaults to
  `150deg`; Platen uses `180deg` for a vertical fade. This does not change
  the literal background emitted into `@page`; gradients with another
  explicit direction retain it.
- **logos** — optional map of brand-mark names to image paths, selectable per
  document with the `Logo` frontmatter key independently of `Style`. The `modern`
  theme uses this for its fruit-icon marks.
- **paletteRoles** — optional per-palette override of which ramp stop supplies a
  document role: `main` (headings, table headers, cover gradient start) and
  `light` (gradient end). Anything omitted falls back to the identically-named
  stop, so most themes never need this. It exists for palettes mirrored from an
  upstream source with different priorities, or — as in `modern` — where a
  palette's own `main` stop is a pale tint unsuited to print and a different
  stop (e.g. `medium`) should drive headings and the cover gradient instead.
- **paletteNames** — optional per-palette override of the CSS names a palette
  generates. `slug` replaces the lowercased palette name in `--<slug>-<stop>` and
  `--gradient-<slug>`; `aliases` add extra class spellings beside
  `.<theme>-<slug>-scheme`:

  ```jsonc
  "paletteNames": {
    "SeaGreen": { "slug": "sea", "aliases": ["seaGreen"] }
  }
  ```

  emits `--sea-main` and matches both `.acme-sea-scheme` and
  `.acme-seaGreen-scheme`. Omitted palettes use the lowercased name and no
  aliases, so most themes never need this — like `paletteRoles`, it exists for a
  palette ported from another project, where documents may already carry that
  project's variable and class names and a ramp was named one way while its
  scheme class was named another.
- **fonts** — each entry's URL is a literal `url`, or comes from a named `env`
  var when a theme prefers to keep it out of the manifest; missing URLs are
  skipped silently.
- **fontFamily** — the `body` and `heading` CSS font-family stacks, injected as
  the `--font-body` / `--font-heading` variables the theme CSS references. Omit to
  fall back to a `system-ui, sans-serif` stack. Every table uses `--font-body`:
  the tables in the document, and the revision table and document-details rows
  on the cover. The cover's title, subtitle, slogan and address use
  `--font-heading`.
- **fontSize** — the body and per-level heading sizes (`body`, `h1`…`h6`),
  injected as `--fs-body` / `--fs-h1`…`--fs-h6`. Each key is optional; defaults are
  `9pt` body with an em-based heading scale.
- **background** — page/body background colour. Applied to the body (HTML export)
  and the printed page via `@page` (PDF). Omit for white.
- Required files (logos, CSS, HTML templates) are validated when the theme loads;
  a missing one fails with exit code 3.

Run `--list-themes` to see installed themes and `--list-styles` for the active
theme's styles.
