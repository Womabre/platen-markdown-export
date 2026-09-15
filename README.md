# platen-markdown-export

Converts Markdown (or HTML) to print-quality PDF via [WeasyPrint](https://weasyprint.org/), with swappable theming: branded cover pages, running headers/footers, revision tables, and a rebuilt table of contents.

Several bundled themes ship a feature-demo sample under their folder, e.g. [themes/default/sample default.md](themes/default/sample%20default.md) (rendered: [sample default_Rev1.pdf](themes/default/sample%20default_Rev1.pdf)).

## Requirements

- **Node.js ≥ 20.9**
- **WeasyPrint** — the PDF engine (macOS/Linux: `brew install weasyprint` / `pip install weasyprint`; Windows: `--setup` downloads a pinned, SHA-256-verified standalone executable from [WeasyPrint's GitHub releases](https://github.com/Kozea/WeasyPrint/releases) — no Python or GTK runtime needed)
- **Playwright** *(optional dependency)* — only needed for Mermaid diagrams, and installed by default. Declaring it optional means an install that cannot fetch it (an offline registry, an unsupported platform) still succeeds, and a document containing a Mermaid diagram then fails with a sentence naming the remedy rather than a stack trace. To drop it deliberately, remove the package (`npm uninstall playwright`) — **not** `npm install --omit=optional`, which is not package-scoped and would also strip sharp's platform binaries, breaking image handling. The browser itself is a separate download: `npx playwright install chromium`, or `--setup`.
- **draw.io desktop app** *(optional)* — only needed to render `.drawio` diagrams (`--setup` installs it too)
- **Graphviz** — nothing to install. `@hpcc-js/wasm-graphviz` is a regular (non-optional) dependency: a pure WASM build with zero runtime deps, so `npm install` alone is enough — no `--setup` step, no browser, no network.
- **AntV Infographic** — nothing to install either. `@antv/infographic` is a regular dependency, pinned to an exact version, and renders through its own server-side entry point — no browser. Icons, and any remote image a diagram names, are the only parts that can reach the network, and where icons come from is your choice: see [`--infographic-icons`](#what-a-document-can-reach).

## Installation

```sh
npm install
npm run build
node dist/index.js --setup   # installs WeasyPrint + Playwright Chromium + draw.io if missing
```

## Usage

```sh
platen-markdown-export [options] [stylesheet.css] <file.md|file.html>
```

Examples:

```sh
platen-markdown-export document.md                          # mode taken from frontmatter
platen-markdown-export --mode pdf --open document.md        # force PDF, open the result
platen-markdown-export --mode pdf,html document.md          # both outputs in one run
platen-markdown-export -s style.css -o out.pdf document.md  # custom stylesheet + output path
platen-markdown-export --theme acme document.md             # use the themes/acme brand package
```

### Options

| Option                         | Description                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `-i, --input <file>`           | Input `.md` or `.html` file (overrides positional)                                                          |
| `-s, --stylesheet <file>`      | CSS stylesheet to inline (default: the active theme's stylesheet; pass `none` to export without one)        |
| `-o, --output <file>`          | Output path (default: `<name>_Rev<revision>.pdf` next to the input)                                         |
| `--theme <name\|dir>`          | Brand package to use (default: `default`); overrides the `Theme` frontmatter and `EXPORT_THEME`             |
| `--mode <pdf\|html\|debug>`    | Override the `Mode` frontmatter field; comma-separated for multiple                                         |
| `--dpi <number>`               | Override WeasyPrint DPI (default: 300)                                                                      |
| `--pdf-variant <id>`           | Tag the PDF as a conformance level — `pdf/a-2b`, `pdf/ua-1`, `pdf/x-4`, … (full list: `--help`) — instead of an ordinary PDF |
| `--infographic-icons <provider>` | Where ` ```infographic ` icons come from: `iconify` (default — sends only icon names), `weavefox` (Ant Group's service; **data may go to servers in China**), or `none` |
| `--open`                       | Open the result in the default viewer after export                                                          |
| `--watch`                      | Re-export whenever the input document changes, until interrupted (Ctrl-C)                                   |
| `--no-bump`                    | Don't modify the source markdown (skips revision-date update and post-release revision bump) — useful in CI |
| `--no-revision-bump`           | Skip only the post-release revision bump; the revision date is still stamped                                |
| `--init`                       | Print a starter frontmatter block on stdout and exit (`--init > report.md`)                                  |
| `--dry-run`                    | Validate the document (includes and local images too) and report what it would write, writing nothing        |
| `--strict`                     | Exit 6 if the run raised any warning (missing image, unresolved include, font that failed to fetch)         |
| `--theme-path <dir>`           | Extra folder to search for themes, each holding one directory per theme. Repeatable; a value may itself be a `PATH`-style list. An external theme shadows a built-in one of the same name |
| `--release-note <text>`        | Sets the `Remarks` of the revision being released — the current last `Revisions` row, describing the work being signed off. Only with `--release` |
| `--inspect`                    | Print the document's resolved frontmatter as JSON and exit. Reads the document; renders nothing, writes nothing |
| `--answers <file.json>`        | With `--init`: fill the scaffold in from a JSON object instead of the placeholders |
| `--json`                       | With `--list-themes` / `--list-styles` / `--check-setup`: print JSON instead of the human listing |
| `--clear-cache`                | Delete the on-disk cache of immutable remote assets (icon fonts, Twemoji) and exit. Rarely needed: a stylesheet that could not be fully inlined is no longer cached, and entries are stamped with a schema version so an upgrade never serves output built by an older release |
| `--list-themes`                | Print available brand packages (themes) and exit                                                            |
| `--list-styles`                | Print the active theme's cover styles and exit                                                              |
| `--setup`                      | Install WeasyPrint, Playwright Chromium, and draw.io if missing, then exit                                  |
| `--check-setup`                | Report which of those `--setup` would install, install nothing, and exit                                   |
| `-q, --quiet`                  | Suppress progress output (warnings and the result line still show)                                          |
| `-v, --version` / `-h, --help` | Version / help                                                                                              |

**`--dry-run`** checks everything that can be decided before rendering — the
theme loads, the `Style` and colour keys parse, the stylesheet and input exist,
the output paths are writable, and for a `pdf` mode WeasyPrint is present — then
reports what it *would* write and stops. Nothing is rendered, nothing is written,
and the source document is left byte-for-byte as it was found, so it is safe to
run against a document you have not finished. It exists because `Mode:` in the
frontmatter had no CLI override meaning "produce nothing".

It also renders the markdown — and only the markdown — so an unresolved
`[!include]` and a missing local image are both reported. No diagram is
rendered, nothing is fetched over the network and nothing is written, which
makes **`--dry-run --strict`** the check to put in a pre-commit hook or a CI
lint job: it exits 6 on a document with a broken reference and 0 on a clean one,
without producing a file.

**`--strict`** turns any warning into exit 6. An export whose image is missing or
whose include does not resolve otherwise exits 0 and writes the file anyway, with
the dead reference in it — right for a draft, wrong for a pipeline producing
deliverables, which has no way to notice. The output is still written under
`--strict`; the exit code is what refuses it, because seeing the broken artifact
is usually how you work out what the warning meant.

**Modes:** `pdf` exports a PDF, `html` exports a standalone self-contained HTML file (banner instead of cover page), `debug` is `pdf` but keeps the intermediate `_tmp-<pid>.html` for inspection.

The HTML export adapts to the OS theme via `prefers-color-scheme: dark` — surfaces, code, tables, alerts and admonitions restyle for dark mode. The PDF is always light.

### Exit codes

`0` success · `1` unexpected error · `2` CLI usage error · `3` input file or asset not found · `4` WeasyPrint not found/failed · `5` network error · `6` warnings raised under `--strict`

## Frontmatter reference

Every key a document can set lives in **[docs/FRONTMATTER.md](docs/FRONTMATTER.md)** —
the cover, page geometry, revisions, TOC and document-control keys, with examples.
It is the page you look things up in while writing, so it is its own file.

The minimum a document needs:

```yaml
---
Title: Document Title
Mode: pdf          # pdf, html, debug — or a comma-separated combination
Theme: default     # a folder under themes/
Style: Navy        # a cover style from that theme
Document Info:
    Author: Your Name
    Revision: 1
    Status: Work In Progress
Revisions:
    - {Revision: 1, Date: "2026-01-15", Author: Your Name, Remarks: Initial version}
---
```

## Themes

The new **[Platen theme](themes/platen/README.md)** pairs the Platen wordmark with
serif typography, a full-page colour cover and four restrained ink palettes. Try
`Theme: Platen` with `Style: Ink`, or export its
[sample document](themes/platen/sample%20platen.md).

Authoring and customising a brand package — palettes, styles, logos, templates —
is documented in **[docs/THEMES.md](docs/THEMES.md)**. To use one, name it:

```sh
node dist/index.js --theme modern document.md   # or the Theme: frontmatter key
node dist/index.js --list-themes                # what is installed
node dist/index.js --theme modern --list-styles # and its cover styles
```

### External themes

A theme is a folder with a `theme.json`; `--theme` has always accepted a path to
one. What `--theme-path` adds is **discovery** — pointing the tool at a folder of
themes so they can be listed, picked and validated by name:

```sh
platen-markdown-export --theme-path ~/brand-themes --list-themes
platen-markdown-export --theme-path ~/brand-themes --theme acme document.md
export EXPORT_THEME_PATH=~/brand-themes        # same thing, for every run
```

A root is either a folder of theme folders (like the tool's own `themes/`) or a
single theme folder — one holding a `theme.json` directly, which is what a theme
kept in its own repository looks like. Both work, so you can point this at the
theme itself. Repeat the flag for several roots, or give one `PATH`-style list.
An external theme **shadows** a built-in of the same name — registering a folder
called `default` is how you override the bundled one — and the run says so.

A theme resolves by **either** its folder name or the `name` its `theme.json`
declares. Those routinely differ: the bundled `markedapp-byword` calls itself
`Byword`, and a theme kept in `~/Dev/acme-theme` may well declare `Acme`. Both
spellings work in `--theme` and in a document's `Theme:` key; listings show the
folder name, with the declared name beside it where it differs.

The search path is a CLI concept rather than an editor setting on purpose: the
terminal, the VS Code extension and anything else driving this tool have to agree
about which themes exist. `--list-themes --json` reports each theme's directory
and whether it shipped with the tool, which is what the extension's theme picker
reads.

#### Making a document portable

A flag has to be supplied on every invocation, so a document that uses an
external theme exports from the extension (which passes `--theme-path` from a
setting) and fails from a task, a terminal or CI. Record the path instead of
passing it — put a `platen-markdown-export.json` beside the document, or anywhere
above it:

```json
{ "themePaths": ["./themes", "~/Dev/my-theme"] }
```

It is found by walking up from the **document**, not from the working directory,
so it works whatever the command was run from. Relative entries resolve against
the config file itself, which is what lets a committed `./themes` work on every
machine that checks the repository out; `~` expands. A per-user file at
`~/.config/platen-markdown-export/config.json` (`%APPDATA%` on Windows) sets a
machine-wide default beneath it.

Precedence, highest first: `--theme-path` → `EXPORT_THEME_PATH` → the nearest
project config, then each one above it → the user config.

## Watch mode

`--watch` re-exports the document every time it changes, until you stop it with
Ctrl-C — the same loop the VS Code extension runs on save, for anyone not using
VS Code:

```sh
platen-markdown-export --watch --mode html document.md
```

Two things are worth knowing about it.

An export **writes to the document it is watching** — the revision-date stamp,
and on a release the revision bump. Watch mode recognises those writes by their
content, not by timing, so it neither loops on itself nor loses an edit you make
while an export is running.

Running `--watch` *and* the VS Code extension's export-on-save against the same
document is safe but wasteful: both fire on every save, so you pay for two
exports and one of them logs `The source document changed during the export`. The
compare-and-swap that produces that warning is what keeps the two from clobbering
each other's revision stamp — no output is wrong, and the next export writes the
stamp that was skipped. There is deliberately no lock file: a stale one would
make the tool refuse to export, which is a worse failure than doing the work
twice. Pick one of the two, or set `Export On Save: false` on that document.

It watches **what the export read**, not just the file you named. Each run
reports the files it opened — includes, local images, draw.io sources, the
stylesheet — and the watch re-points at that set afterwards, so editing a chapter
re-exports the book that includes it. The set follows the document as it changes:
add an include and its file is watched from the next run onwards. Files that
merely sit beside a dependency are not watched, only the ones actually used.

## Live preview in your theme

The export is the only place a document used to look like its theme. While
writing, VS Code's Markdown preview — or Markdown Preview Enhanced — showed it in
their own style. `--preview-kit` closes most of that gap: it writes, for every
theme on the search path and every style each one offers, the stylesheet an HTML
export of such a document carries, built by the same code the export runs.

```sh
platen-markdown-export --preview-kit ./preview-kit                            # index.json, one .css per theme/style, preview-plugin.js
platen-markdown-export --preview-kit .crossnote --preview-format mpe           # a parser.js for Markdown Preview Enhanced
```

**VS Code's built-in preview** needs nothing: the extension builds a kit in its
own storage when it starts (and again when theme folders change) and themes the
preview through a markdown-it plugin. **Markdown Preview Enhanced** runs
**Markdown Export: Theme Markdown Preview Enhanced in This Workspace** once, which
writes `.crossnote/parser.js`. MPE evaluates that file in a sandbox with no file
access and ignores `@import "x.css"` unless script execution is on, so the
stylesheets travel inside the parser. Set MPE's `previewTheme` to `none.css` (the
command offers to) so its own theme does not show underneath. An existing
`parser.js` with hooks of your own is never replaced — the command refuses, and
says so. One side effect to know: MPE also runs that hook when it *converts* a
document (its Pandoc and Markdown exports), so those outputs of an export document
end with an empty `<div data-pme-preview="…">`.

Which stylesheet a document gets follows the export exactly:

- Only a document whose frontmatter has a top-level `Mode`, `Theme` or `Style` is
  themed. A README keeps the previewer's look.
- The theme is `--theme` (the extension's `theme` setting) → `Theme` → `EXPORT_THEME`
  → `default`, matched by folder or manifest name. A theme the kit does not hold —
  a typo, or one named by a path — is left unthemed rather than guessed.
- `Style` picks that style; a name the theme does not know tints headings with its
  default palette, as the export does. An inline `Style:` mapping (`Color:` …) is
  previewed with the theme's base stylesheet.

What a preview cannot show stays export-only: pages and page breaks, the cover and
revision table, running headers and footers, TOC page numbers, and anything the
export *draws* rather than styles — Mermaid, Graphviz, draw.io and infographic
rendering, captions, `[!include]`, code-line highlighting. Code blocks keep the
previewer's own syntax colours where it uses its own highlighter (MPE uses Prism).
The preview always sits on the page's own background, whatever your editor theme
— it stands in for paper. Other extensions that restyle the preview (GitHub
styles, Markdown All in One, MkDocs Material…) keep working on every other
Markdown file, but inside a themed document their styling is reset so the theme's
wins; diagrams (SVG) and KaTeX maths are left untouched. A table or a display
formula wider than the preview pane scrolls sideways inside its own box, so a
narrow side-by-side preview never scrolls the whole page. After editing a theme's CSS, run **Markdown Export:
Refresh Preview Themes** (or re-run `--preview-kit`).

## Revision workflow

Two different things happen to a document, and only one of them is automatic.

**The date stamp is automatic.** When `Status` is `Work In Progress` or
`Released` / `Vrijgegeven`, every export stamps today's date on the **last**
`Revisions` entry, so an exported file and the document it came from never
disagree about the document's own date.

**Cutting a release is not.** Pass `--release`, and after a successful export the
tool will:

1. append a new `Revisions` entry (next revision, today's date, same author),
2. update every `Revision:` scalar to the new value,
3. reset `Status:` to `Work In Progress`.

It only does this for a document whose `Status` is `Released` / `Vrijgegeven` —
the status is the document declaring it is final, the flag is you saying cut it
now. A `Revisions` row recording a release that never happened would be a lie in
the document's own history.

```sh
platen-markdown-export --release document.md    # export, then cut the release
platen-markdown-export document.md              # export; the document is untouched
```

Revision increments: `1 → 2`, `A → B`, `Rev1 → Rev2`, `1.0 → 1.1`.

> This used to happen on *any* export of a `Released` document, which was right
> for the export you meant as a release and wrong for the other three ways an
> export happens — the extension firing on save, a CI run, a colleague
> re-exporting to read it. `--no-revision-bump` existed to hold it back and is
> now accepted and ignored.

`--no-bump` suppresses **all** source-file modification, the date stamp included.
Use it in CI, where the checkout is disposable and should stay untouched.

Source edits are written **only after an export succeeds**. A failed export, or a
run with no `Mode` set, leaves the document exactly as it found it. And if the
document changed on disk while the export was running — another window, a watch
in another terminal — the write is skipped with a warning rather than
overwriting that change.

Export on save is **on by default** (`platenMarkdownExport.exportOnSave`). It is deliberately silent — it runs on every save, and a notification each time would be unbearable — so the status bar carries the answer instead: with a Markdown document open it shows whether saving will export it, and hovering says why not when it will not.

One thing worth knowing, because it looks exactly like the feature breaking: **the output filename follows the document's revision.** Cut a release and `report_Rev4.pdf` becomes `report_Rev5.pdf`. If you had the old file open in a viewer it simply stops changing, while saves quietly keep exporting — to the new name.

The VS Code extension's export-on-save only fires for documents that declare a `Mode:` frontmatter key (or when a mode is forced in its settings), so saving a README or a scratch note starts nothing. A document that should be exported by hand but not on every save can opt out on its own with `Export On Save: false` — the CLI ignores that key, since "on save" is not a concept it has.

Releasing has its own command there, **Markdown Export: Export and cut a release**, on the editor and explorer context menus for any Markdown file; no save-triggered export can cut one. It asks the CLI (`--inspect`) whether the revision being released already carries a `Remarks` note and prompts for one only when it does not — the note lands on that outgoing revision, which is the row the cover's revision table shows. Escape abandons the release; an empty box releases without a note, which is what happened before the prompt existed.

Right-clicking gives you a **Markdown Export** submenu in both places: inside a Markdown document it sits next to Format Document, and in the Explorer next to Open. It holds the three frontmatter commands, then the four export modes and the release. Right-clicking a *folder* offers just the new-document wizard, since the rest need a document.

Frontmatter has two commands beside the wizard's: **Markdown Export: Frontmatter Wizard (fill in this document)…** asks the wizard's questions and inserts the block at the top of the file you already have open (refusing one that already has a block), while **Insert Frontmatter Template (static)** drops the placeholder scaffold with no questions at all — instant, and works even when the CLI cannot be resolved.

Two more commands round out the editor side. **Markdown Export: New Document (wizard)…** walks through title, author, theme, cover style, export mode and the optional document controls, then writes the file — the frontmatter itself comes from the CLI's own `--init --answers`, so there is one implementation of the scaffold and it is the one the exporter parses. **Markdown Export: Add External Theme Folder…** registers a folder of themes (see [External themes](#external-themes)) after checking it actually contains some, and **Markdown Export: Select Theme…** picks from every theme the CLI can see, built-in and external.

## Markdown features

Beyond standard markdown-it (tables, typographer, linkify):

- **Includes** — `[!include](other.md)` on its own line splices in another file: frontmatter and its own TOC are stripped, `(Rev. X)` is appended to its first heading, relative image paths are rewritten, circular includes are guarded. Two extensions:
  - **Non-markdown files** are quoted as a fenced code block with the language inferred from the extension (`.ts` → typescript, `.ps1` → powershell, …), so docs can quote live source instead of a copy that rots. The fence is grown longer than any backtick run inside the file.
  - **`#L` fragments** take only those lines — `[!include](src/types.ts#L10-L25)`, or `#L10` for one line. On a markdown include the excerpt is spliced inline (no page break, no revision heading).
  - **A link title overrides the language** — `[!include](Main.config "xml")`, for extensions that don't identify their content. Combines with a range: `[!include](Main.config#L5-L40 "xml")`. Because a language only means anything for a code block, giving one also *forces* code-block treatment — which is how a `.md` file can be quoted as source instead of spliced in.
- **Table of contents** — an existing TOC list (e.g. from VS Code's *Markdown All in One*) is detected, wrapped in `<nav class="toc">`, and rebuilt from the merged headings of the final document.
- **Admonitions** — MkDocs style (`!!! warning "Title"` with 4-space-indented body) and container style (`::: tip Title` … `:::`). Aliases: note, abstract/summary/tldr, info/todo, tip/hint/important, success/check/done, question/help/faq, warning/caution/attention, failure/fail/missing, danger/error, bug, example, quote/cite.
- **GitHub alerts** — `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`.
- **Mermaid** — ` ```mermaid ` fences are rendered to SVG via headless Chromium.
- **Graphviz** — ` ```dot ` or ` ```graphviz ` fences are laid out to SVG via a WASM build of Graphviz (`@hpcc-js/wasm-graphviz`) — no browser, no network, no external binary to install.
- **Infographics** — ` ```infographic ` fences render [AntV Infographic](https://github.com/antvis/infographic)'s declarative syntax — lists, sequences, hierarchies, comparisons and charts, 276 templates — to SVG, with no browser. A block starts with `infographic <template-name>`; an unknown name is refused, naming the closest real one when there is one, rather than silently rendering a different template. Text is set in Arial, since the library's fonts live on Ant Group's CDN — except the one the built-in `hand-drawn` theme asks for, which ships with this tool (a 53 KB Latin subset of [851手書き雑フォント](https://pm85122.onamae.jp/851fontpage.html), embedded in each diagram that uses it; see `assets/fonts/`) so that `theme hand-drawn` looks hand-drawn in the PDF and the HTML export alike. Many templates give text a **fixed slot**: keep labels short, or they wrap into the text below — exactly as they do in a browser. Icons are [Iconify](https://icon-sets.iconify.design/) names such as `mdi/home`; see `--infographic-icons`. One PDF limitation: WeasyPrint draws nothing for a shape filled with a partly transparent gradient, so 15 of the templates lose some shapes there — the arrows between `sequence-steps-simple`'s steps, for one.
- **Colour emoji in a diagram label** render when the installed WeasyPrint can actually draw them, and are otherwise stripped rather than crashing the export — checked once per run against the real binary, not guessed from a version number.
- **draw.io** — `![Caption](diagram.drawio)` renders page 1; `![…](diagram.drawio#page=2)` selects a page. Requires the draw.io desktop app.
- **Math** — KaTeX, inline `$…$` and block `$$…$$`.
- **Abbreviations** — `*[ABBR]: Definition` definitions get `<abbr>` markup plus an auto-generated, alphabetised glossary section (localised via `Lang`).
- **Footnotes, task lists** — task checkboxes are replaced with print-safe SVGs.
- **Emoji** — rendered as inline [Twemoji](https://github.com/jdecked/twemoji) SVG images (baseline-aligned, font-independent, inlined as data URIs) so they look the same in every theme and on any host.
- **Icons** — Font Awesome Free (`fa-…`) and Phosphor (`ph ph-…`, `ph-bold …`) classes are auto-detected; only the needed font CSS is fetched (and disk-cached for offline reuse).
- **Attributes** — `{.class}` via markdown-it-attrs, e.g. `## Chapter {.page-break-before}`.
- **Resizing an inline image** — `![Caption](image.png){style="width:150px"}`. Use `style="width:..."`, not a bare `{width=150px}`: every theme's CSS sets `img { width: auto }`, which overrides a plain HTML `width` attribute but not an inline `style`.
- **Hex color chips** — inline code containing a hex value (`` `#009146` ``) is rendered with that color as background.
- **Keyboard keys** — `<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd>` renders as key caps.
- **Highlight, subscript, superscript** — `==highlighted==`, `H~2~O`, `x^2^`.
- **Redline marks** — `<ins>inserted</ins>` and `<del>deleted</del>` render as green-underlined and red-struck spans, for revision-marked documents. The tint is on the **HTML tags**, so plain markdown stays portable: `~~struck~~` is an ordinary strikethrough and `++underlined++` a plain underline (the underline markdown otherwise lacks), neither implying a tracked revision. `<u>` and `<s>` are likewise plain.
- **Spanning table cells** — `{colspan=2}` / `{rowspan=2}` on a cell (via markdown-it-attrs). The covered cells are simply *not written*, so a spanning row has fewer `|` cells than the header.
- **Definition lists** — a term on one line, `: definition` on the next.
- **Code line highlighting** — ` ```typescript:2,4-6 ` tints those lines. The colon suffix is deliberate: a `{2,4-6}` suffix would be swallowed by markdown-it-attrs, which already owns `{…}` on fence lines.
- **Captions** — a `Table: caption` or `Figure: caption` paragraph directly under a table, an image or a rendered diagram (Mermaid, Graphviz, infographic) becomes an auto-numbered caption (`Table 1.`, `Figure 1.`); the two counters are independent. Feeds the optional `List of Tables` / `List of Figures` indexes.
- **Columns** — `:::: columns` wrapping `::: column` blocks lays content out side by side. Nested containers must use fences of *differing* length (`::::` outside, `:::` inside) — equal-length fences are ambiguous to markdown-it-container.
- **Landscape / portrait sheets** — `::: landscape` gives its content its own rotated sheet, for wide tables; `::: portrait` is the mirror, forcing an upright sheet inside a landscape document. Each forces its own orientation regardless of the document's `Orientation`, so a container matching the default is simply a no-op.
- **Cross-references** — `[text](#anchor){.page-ref}` appends the target's resolved page number at export time.
- **Table fitting** — words are never broken inside a table: cells wrap at word boundaries only, with hyphenation off, because a value split mid-word reads as a typo. A table whose header has 10 or more columns is tagged dense automatically and buys its width back from padding and type size (13px → 5px horizontal padding, 0.8em text) rather than from the words. A table still too wide after that wants `::: landscape` or fewer columns.
- **Scheme classes** — every palette exposes two utility classes for inline colour blocks, `<theme>-<palette>-scheme` (heavy) and `<theme>-<palette>-light-scheme` (content-first), e.g. `<div class="default-navy-scheme">…</div>`. The text colour is picked automatically: white where it clears WCAG AA against the background, the palette's darkest stop where it doesn't, so a pale `main` can't produce unreadable white-on-light text.
- **Collapsible details** — `<details>`/`<summary>` renders as a styled block: always expanded in the PDF (there is no clicking on paper), genuinely collapsible in the HTML export.

## Environment variables

| Variable                                      | Purpose                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `EXPORT_THEME`                                | Brand package to use (same as `--theme`; default `default`)          |
| `EXPORT_PDF_DPI`                              | WeasyPrint DPI (default 300)                                         |
| `EXPORT_PDF_VARIANT`                          | Default `--pdf-variant` when the flag is not given (default: none — an ordinary PDF) |
| `EXPORT_INFOGRAPHIC_ICONS`                    | Default `--infographic-icons` when the flag is not given: `iconify` (default), `weavefox` or `none` |
| `EXPORT_PDF_TIMEOUT_MS`                       | Network fetch timeout (default 15000)                                |
| `EXPORT_PDF_IMAGE_QUALITY`                    | JPEG quality for resized body images, 1–100 (default 88)             |
| `EXPORT_PDF_LOGO`                             | Override the header/footer logo path                                 |
| `EXPORT_PDF_LOGO_WHITE`                       | Override the cover-page (white) logo path                            |
| `EXPORT_PDF_CONCURRENCY`                      | Max diagrams/images rendered at once, 1–64 (default 4)               |
| `EXPORT_PDF_MAX_RESPONSE_MB`                  | Ceiling on a single remote fetch, 1–2048 (default 50)                |
| `EXPORT_PDF_ALLOW_PRIVATE_HOSTS`              | Allow fetches to loopback/private/link-local addresses (default off) |

**`EXPORT_PDF_ALLOW_PRIVATE_HOSTS`.** A document decides which URLs get fetched —
an `<img src>`, a `<link href>`, a theme font — and the machine exporting it can
reach things the document's author cannot: a service on `localhost`, an intranet
host, a cloud metadata endpoint at `169.254.169.254`. Because the fetched bytes
are embedded in the output, that is exfiltration as well as probing, so those
address ranges are refused by default and the refusal names this variable. Set it
to `1` for a document that genuinely pulls assets off your own network.

A theme may also declare a font with an `env` key instead of `url` in its `theme.json` `fonts[]`, to load that font's URL from the environment rather than committing it — useful for a private theme with a licensed webfont kit URL that shouldn't be checked in.

## What a document can reach

Exporting a document runs code on its behalf, so it is worth being explicit about
what a `.md` file is able to make this tool do. The question matters most when
the document is not yours — the VS Code extension exports on save, so opening
someone else's repository and pressing <kbd>⌘S</kbd> is enough to start a run.

**Contained already:**

- **Remote fetches cannot reach your network.** Loopback, private, link-local
  (including the cloud metadata endpoint) and carrier-grade-NAT ranges are
  refused, and the check runs on the address actually dialled rather than on the
  hostname, so DNS rebinding does not get around it. Opt in per machine with
  `EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1`.
- **Mermaid diagrams cannot reach the network at all.** A diagram label may
  contain HTML, so `A["<img src='https://example.invalid/?x=1'>"]` is an ordinary
  node that a browser would dutifully fetch. Every request the render page makes
  is aborted.
- **Graphviz diagrams have no browser to abuse in the first place.** Layout runs
  in a pure WASM module inside the same Node process — there is no page, no
  DOM, and nothing capable of issuing a network request.
- **Infographic icons send only icon names — and only where you said.** The
  library looks every icon up through one endpoint, Ant Group's WeaveFox service
  at `www.weavefox.cn`, with the icon's name as the query — or a free-text term
  written `ref:search:…`, and in some fallback cases the item's label or
  description. Each request it makes passes through a policy this tool
  enforces, chosen with `--infographic-icons`:
  - `iconify` (default): a lookup for a well-formed icon name such as `mdi/home`
    becomes a fetch of that one icon from Iconify. Anything else — free text,
    labels, descriptions — is answered "not found" without a request, so an
    icon lookup never sends anything but an icon name.
  - `weavefox`: lookups go to WeaveFox unchanged. **Data may go to servers in
    China**, and every export that sent any says so, and how many.
  - `none`: nothing is sent — no icon lookup, and no remote image either; icons
    are left out.

  The choice is a flag, an environment variable (`EXPORT_INFOGRAPHIC_ICONS`) or a
  machine-scoped editor setting — deliberately not a frontmatter key, so a
  document you received cannot opt your machine in. A remote asset a diagram
  names explicitly goes through the same private-address guard as any other
  fetch. The library runs in a worker thread, so the browser globals it installs
  for itself never leak into the rest of the export.
- **No shell.** Every external command runs through `execFile` with an argument
  array, so nothing in a document or a path can become shell syntax.
- **Redirects cannot change scheme or carry headers cross-origin**, and a single
  response is capped (`EXPORT_PDF_MAX_RESPONSE_MB`).

**Not contained — by design:**

- **`[!include]` and local `<img>` paths are not restricted to the document's own
  directory.** `[!include](../shared/header.md)` is a normal, useful thing to
  write, and a book assembled from parts a level up is the feature working as
  intended — so there is no root to escape from. The consequence is that a
  document you did not write can pull any file the exporting user can read into
  the output: `[!include](~/.ssh/id_rsa "text")` embeds it in the PDF.

  There is no path from there to an attacker — every URL in a document is fixed
  at authoring time, and the guards above mean nothing can be sent anywhere — so
  this is a document that can *embed* your files, not one that can *exfiltrate*
  them. It still matters if you then share the PDF.

  **If you export documents you did not write**, treat the export as running with
  your file-read permissions: skim the frontmatter and the `[!include]` lines
  first, or turn off `platenMarkdownExport.exportOnSave` so nothing runs
  unattended. Per-document, `Export On Save: false` does the same.

## Development

```sh
npm run check        # every gate CI runs, in CI's order — run this before pushing
npm run build        # tsc → dist/ (incremental)
npm run watch        # rebuild on change
npm test             # builds, then runs node --test
npm run lint         # eslint
npm run verify:pdf      # export a real PDF through WeasyPrint and check it
npm run verify:pdf:all  # …through every shipped theme
npm run verify:samples  # …and every theme's own sample document (needs Chromium + draw.io)
```

The VS Code extension has two suites of its own, run from `vscode-extension/`:
`npm test` covers `core.ts` — everything decidable without an editor — and
`npm run test:integration` launches a real VS Code and drives the commands
inside it, so command registration, the new-document wizard and the release-note
prompt are checked rather than clicked through by hand. The launcher reuses an
installed VS Code when it finds one; CI downloads one and runs it under `xvfb`.

The unit suite is self-contained — no WeasyPrint, no Chromium, no network — which is why `verify:pdf` exists separately: it is the only check that exercises the actual PDF output. CI runs both.

`npm run check` bundles the five gates CI applies (`check:versions`, `check:changelog`, `lint`, `test`, `verify:pdf`) so a push is not the first thing that runs them. Two of those used to be reachable only on a runner: `check:changelog` failed *after* a tag was pushed, and `verify:pdf` was never prompted for locally, so a rendering regression reached CI before its author saw it. On a machine with no WeasyPrint `verify:pdf` reports a skip rather than a failure — CI passes `--require`, so it is never skipped there.

Releasing (the CLI and the VS Code extension ship together, on one version):

```sh
npm run version:set -- 1.1.0   # both manifests + both lockfiles
npm run check:versions         # asserts nothing drifted
# update CHANGELOG.md, commit, then:
git tag v1.1.0 && git push origin v1.1.0
```

The tag triggers `.github/workflows/release.yml`, which re-runs every gate, builds the tarball and one `.vsix` per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64` — VS Code picks the matching one), and attaches them to a GitHub Release. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

Pipeline overview: markdown → HTML ([markdown.ts](src/markdown.ts)) → Mermaid/Graphviz/infographic/draw.io rendering + image inlining ([mermaid.ts](src/mermaid.ts), [graphviz.ts](src/graphviz.ts), [infographic.ts](src/infographic.ts), [drawio.ts](src/drawio.ts), [images.ts](src/images.ts)) → cover page, fonts, CSS and TOC ([cover.ts](src/cover.ts), [css.ts](src/css.ts), [html.ts](src/html.ts)) → served to WeasyPrint over a localhost server ([weasyprint.ts](src/weasyprint.ts)). Orchestrated by [index.ts](src/index.ts).

## License

The code is [MIT-licensed](LICENSE).

The `modern` theme bundles third-party assets under their own terms, not MIT:

- **Hero photos** (`themes/modern/hero/*.webp`) are from Unsplash, used under the [Unsplash License](https://unsplash.com/license) (free for commercial and non-commercial use, no permission required). Each cover style's photographer credit is recorded in `themes/modern/theme.json`'s per-style `attribution` field.
- **Fruit-icon logos** (`themes/modern/logos/modern-logo-*.svg`) are original artwork made for this theme — simple flat-colour icons, no third-party source, covered by the same MIT license as the rest of the repo.
