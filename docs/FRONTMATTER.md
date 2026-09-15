# Frontmatter reference

Every key a document can set, and what each one does. This is the page you look
things up in mid-document, which is why it is its own file rather than a third of
the README — see the [README](../README.md) for installation, usage and the
markdown feature set.

All keys are case-insensitive (`Title:` or `title:`).

```yaml
---
Title: My Document — Subtitle         # text after " — " (or ": ") becomes a cover subtitle
Header: Custom running header        # default: Title
Footer:                              # default: "page N of M"
Lang: en                             # en, nl, de, fr, es (affects glossary labels)
Mode: pdf                            # pdf, html, debug — comma-separated allowed
Export On Save: false                # VS Code only: keep this document out of export-on-save
Status: Work In Progress             # see "Revision workflow" below

Document Info:                       # rendered on the cover page
    Author: Acme Corp
    Date: "2026-04-08"
    Revision: 1
    Status: Final

Revisions:                           # revision history table
    - {Revision: 1, Date: "2026-04-08", Author: Acme Corp, Remarks: Initial version}
Revisions Visible: 3                 # how many entries show on the cover (0 hides the table)

Theme: default                       # brand package (a folder under themes/, or under a --theme-path root; default: the neutral "default" theme)
Style: Navy                          # named cover style, or an object:
# Style:
#     Name: Navy                     # named style + a document hero image:
#     Image: path/or/url.jpg         # gradient/fonts/background from the style, photo from Image
# Style:
#     Color: "#224466"               # custom: hex, rgb()/rgba(), or a palette name (Navy, Grey, …)
#     Image: path/or/url.jpg         # optional "position: 30%" suffix for crop offset
#     Position: 30%                  # alternative to the inline suffix
# Style:
#     Color: "#22446650"             # 8-digit hex (or rgba) sets the wash opacity yourself —
#     Image: path/or/url.jpg         # here 0x50/255 ≈ 31% instead of the default 80%
# Style:
#     Color: Navy                    # a palette name works the same way as a literal hex
#     Image: path/or/url.jpg
#     Overlay: [0.3, 0.9]            # gradient start/end opacity — overrides the flat 80% default;
#                                     # works with Name+Image too, not just Color+Image

Logo: Cherry                         # brand mark: a name from the theme's `logos`
                                     # map, or a path — independent of Style

Cover Logo:                          # plain path/URL, or:
    - Path: assets/logo.png
    - Background: '#ffffff'          # optional backdrop — a colour or a palette name

Cover Page: true                     # false suppresses the cover but keeps Style's colours
Cover Slogan: Engineering, delivered. # replaces the theme slogan; false removes it
Cover Address:                       # replaces the theme address; false removes it
    - Acme Manufacturing B.V.
    - Industrieweg 12
Cover Title Color: "#FFD84D"         # cover title + subtitle, and the title's rule where a
                                     # theme draws one — same values as Style.Color
Cover Footer Logo: Cherry            # cover's bottom-right mark; false removes it
Footer Logo: Cherry                  # bottom-centre mark on every page; false removes it

# Document controls — all default to off
Numbered Headings: true              # 1, 1.1, 1.1.1 on h2–h6 (numbers flow into the TOC)
Running Header: true                 # top-left header tracks the current section
List of Tables: true                 # index of captioned tables, after the TOC
List of Figures: true                # index of captioned figures, after the TOC
Code Line Numbers: true              # number every line of every fenced code block
Trademark Symbols: true              # (c)/(r)/(tm) -> ©/®/™; off (default) keeps them literal
Watermark: DRAFT                     # diagonal stamp; `true` reuses Status
Classification: Internal             # Public | Internal | Confidential
TOC Depth: 3                         # deepest heading level listed in the TOC
Page Size: A4                        # A3 | A4 | A5 | Letter | Legal | Tabloid, or "210mm 297mm"
Margins: 20mm                        # 1–4 CSS lengths, like the CSS margin shorthand
Orientation: portrait                # portrait | landscape — the whole document
PDF Variant: pdf/a-2b                # tags the PDF as a conformance level (PDF/A, PDF/UA, PDF/X)
                                      # instead of an ordinary PDF — full list: --help
Variables:                           # {{Name}} substitutions applied to the body
    Customer: Acme Manufacturing
---
```

- **Title / subtitle split** — on the cover page the `Title` is split into a headline and a subtitle at the first *spaced* em-dash (`A — B`), en-dash (`A – B`), or colon (`A: B`). The part before becomes the large headline; the part after is rendered as a smaller subtitle beneath it. A title with no such separator shows as a single headline (no empty subtitle). This only affects the cover — the running header and PDF metadata use the full title. Example: `Title: Solarized — A Precision Colour Scheme` → headline **Solarized**, subtitle *A Precision Colour Scheme*.
- **Revision** shown in the footer comes from `Document Info.Revision`, then the last `Revisions` entry, then top-level `Version`/`Revision`.
- **Theme** selects the brand package (see [Themes](#themes)); defaults to the brand-neutral `default` theme.
- **Named styles** vary per theme — run `--list-styles` to see what a theme offers. Each pairs a cover gradient with a brand colour; the style colour also tints headings and table headers.
- **`Style: { Name, Image }`** combines a named style with a per-document hero photo: the style supplies the gradient colour (and, in multi-style themes like `jasonm23`/`mixu`/`solarized`, the fonts/background/colors), while `Image` supplies the cover photo layered under a translucent wash of that colour. A bare `Style: Foo` string uses the style without a cover photo.
- **`Overlay: [start, end]`** sets the resolved colour's opacity at the gradient's top (0%) and bottom (90%) stops — works with `Color` (hex or palette name) and with `Name`+`Image` alike. Without it, a document photo gets a flat 80% wash (`[0.8, 0.8]`) and a colour-only cover (no photo) is fully opaque (`[1, 1]`). Every stop uses the *same* colour at different opacities, so `[0.3, 0.9]` reads as a soft top-to-bottom fade, not a blend between two hues.
- Without a `Style`, no cover page is generated.
- **`Logo`** overrides the brand mark shown in the cover footer and page header, **independently of `Style`** — so a document can pair one brand's cover style with another's logo. The value is either a key from the theme's `logos` map (matched case-insensitively; run `--list-styles` or read the theme's `theme.json`) or a path to an image, resolved against the theme directory first and then the working directory. An unrecognised name exits with code 3 rather than silently falling back to the house logo. Distinct from `Cover Logo`, which overlays a *third-party* logo on the cover.

- **Cover element overrides** — four keys tune the generated cover without touching the theme. `Cover Slogan` and `Cover Address` replace the theme's text (the address also accepts a YAML list, one line per entry), `Cover Footer Logo` swaps the bottom-right brand mark, and each accepts `false` to remove that element outright. `Footer Logo` does the same for the bottom-centre mark in the page margin of *every* page; the top-left header mark keeps following `Logo`. Logo values resolve exactly like `Logo` — a name from the theme's `logos` map, or a path — so an unknown one exits 3 rather than silently falling back.
- **`Cover Page: false`** — suppresses the cover page entirely while leaving `Style` in place, so the document keeps its brand colours. Omitting `Style` also removes the cover, but takes the heading and table-header tints with it.

### Document controls

Seven optional switches, all off unless set. Each theme's `sample *.md` enables all of them, so the bundled sample PDFs double as a live reference.

| Key                  | Effect                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Numbered Headings`  | Prefixes `##`–`######` with a hierarchical number (`##` = 1, `###` = 1.1). `#` is never numbered — it is the title. Applied before the TOC is rebuilt, so body and TOC numbering can never diverge. |
| `Running Header`     | Replaces the static `Header:` string in the top-left margin with the title of the section currently being read.                                                                                    |
| `List of Tables`     | Emits a "List of Tables" index after the TOC, with live page numbers. Built from `Table:` captions; emits nothing if the document has none.                                                        |
| `List of Figures`    | As above, for `Figure:` captions. Tables and figures are numbered independently.                                                                                                                   |
| `Code Line Numbers`  | Numbers every line of every fenced code block. Pairs with the ` ```lang:2,4-6 ` line-highlighting syntax.                                                                                          |
| `Trademark Symbols`  | Converts `(c)`, `(r)`, `(tm)` to ©/®/™. Off by default, so a literal parenthetical like `(R)` (e.g. a revision marker) isn't silently swapped for the registered-trademark glyph. Smart quotes and dash/ellipsis typography from `typographer` are unaffected either way. |
| `Watermark`          | Stamps a faint diagonal label across every page. A string is used verbatim; `true` reuses the document's `Status`. Suppressed entirely once `Status` is `Released` / `Vrijgegeven` — a signed-off document is never stamped. PDF only.  |
| `Classification`     | Prints a sensitivity label in the **top-right** margin — a Phosphor duotone shield (colour fill, black outline) plus the word: `Public` green, `Internal` amber, `Confidential` orange.            |
| `TOC Depth`          | Deepest heading level listed in the table of contents (`3` = down to `###`). Deeper headings still render and are still numbered; they just leave the contents page.                              |
| `Page Size`          | `A3`/`A4`/`A5`/`Letter`/`Legal`/`Tabloid`, or a literal `W H` pair. Defaults to A4.                                                                                                               |
| `Margins`            | `@page` margin as 1–4 CSS lengths (`20mm`, `25mm 15mm`, …). Defaults to `2cm`. Together with `Page Size` this also caps diagram height so a tall chart is scaled to the sheet rather than clipped. |
| `Orientation`        | `portrait` (default) or `landscape` for every page. Individual pages override it with the `::: landscape` / `::: portrait` containers. The cover follows it too. |
| `PDF Variant`        | Tags the PDF as a conformance level — PDF/A (archival), PDF/UA (accessible), or PDF/X (print production) — instead of an ordinary PDF, e.g. `pdf/a-2b`. Full list: `--help`. Same key WeasyPrint's own `--pdf-variant` accepts; precedence is `--pdf-variant` → `PDF Variant` → `EXPORT_PDF_VARIANT`. |
| `Variables`          | A mapping substituted into the body as `{{Name}}`. See below.                                                                                                                                     |

Two related print features need no frontmatter switch:

- **Cross-references with page numbers** — add `{.page-ref}` to any internal link and the resolved page number is appended at export time: `See [the sizing table](#sizing){.page-ref}` → "See the sizing table (page 12)".
- **Frontmatter variables** — `{{Name}}` anywhere in the body is replaced from the `Variables:` mapping before parsing, so one template can serve many customers. Unknown placeholders are left verbatim and warned about (never silently blanked). Occurrences inside code fences and inline code are left alone, so documentation about the feature stays literal.
- **Page orientation** — `Orientation: landscape` turns the whole document (cover included) landscape. Either way, `::: landscape` and `::: portrait` containers force one sheet of that orientation, so a portrait document can hold a landscape table and a landscape document can hold a portrait page of prose.
