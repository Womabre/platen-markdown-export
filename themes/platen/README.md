# Platen

The house theme for **Platen Markdown Export**: serif typography, a full-page colour
cover, fine rules and the original Platen wordmark. The paired cover rule echoes
the two lines in the P logo. Content pages stay white for print.

```yaml
Theme: Platen
Style: Ink
```

Or use `platen-markdown-export --theme platen document.md`.
The CLI command retains its current name until the application rebrand.

| Style | Ink colour |
| --- | --- |
| `Ink` (default palette) | Warm charcoal |
| `Oxblood` | Muted wine red |
| `Forest` | Deep green |
| `Indigo` | Subdued blue |
| `none` | Plain Ink styling (no cover photograph) |

Choose a style explicitly to generate a cover; use `Cover Page: false` to hide
the cover while keeping the selected palette. Headings use Songti SC, with
Georgia, Times New Roman and the system serif as fallbacks. Body text uses
Georgia, with Times New Roman and the system serif as fallbacks. Songti SC must
be installed locally; it is not bundled with the theme.
Navigation, labels and page details use Helvetica Neue / Arial. Tables use the
body font, including the cover's document details and revision table. No webfonts are needed;
the optional icon libraries follow the other themes' imports.

The PDF cover includes document details, revision history, an optional customer
logo and all standard cover overrides. An optional `Style.Image` fills
the cover beneath the selected theme-colour gradient, like Modern. Use
`Style.Overlay: [0.5, 1]` to reveal the photo at the top and fade to solid colour
below; `Style.Position` sets its horizontal focal point. Cover text and rules
are white for contrast. The named styles need no photograph. The HTML export
uses the exporter's shared banner with the white wordmark, serif title and
selected palette, plus its standard dark appearance support.

`Logo: Logo` selects the compact P; `Logo: Wordmark` selects the default.
`Cover Title Color` recolours the title, subtitle and paired rule.
An explicit `Logo` uses that exact asset in both variants; use
`Cover Footer Logo: ./logos/platen-logo-white.svg` for a white P on the cover.

Export [sample platen.md](sample%20platen.md) for the complete feature showcase: typography, tables,
callouts, code, Mermaid and Graphviz diagrams, infographics, Draw.io, equations,
Markdown extras, palettes and document controls. The sample includes the same
feature sections as Modern. Diagram rendering needs Chromium and Draw.io; icons
and emoji may need network access. The editable
[Draw.io source](architecture.drawio) is included beside the sample.

```sh
node dist/index.js --no-bump "themes/platen/sample platen.md"
```

The files in `logos/` are exact copies of the matching SVGs in `brand/`, included
here because the npm package ships `themes/` but not `brand/`. After updating
the brand artwork and running `npm run brand`, copy the four corresponding SVGs
into this folder again. The Platen logo identifies the project and is not
covered by the code's MIT licence; replace it when making your own brand theme.
