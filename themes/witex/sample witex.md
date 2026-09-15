---
Title: WiTeX — The Art of Academic Typesetting  # the part after " — ", " – " or ": " becomes the cover subtitle
Document Info:
    Author: Leslie Lamport
    Date: "2026-04-08"
    Revision: 1
    Status: Final                           # Work In Progress | Released — Released bumps the revision after export
Revisions Visible: 3                        # 0 hides the revision table on the cover
Revisions:
    - {Revision: 1, Date: "2026-04-08", Author: Leslie Lamport, Remarks: Initial showcase document}
# Brand package — see --list-themes:
#   bootstrap3 | default | gaia | github | jasonm23 | markedapp-byword
#   mixu | modern | platen | roryg-ghostwriter | solarized | uncover | witex
Theme: Witex
# Cover style: a named style from this theme, or the { Color, Image, Position } object below.
# Named styles:
#   none | Witex
# Color accepts a palette name from this theme (or any hex value):
#   Witex
Style:
    Color: Witex
    Image: https://images.unsplash.com/vector-1775304122137-f0762ab9590e?ixlib=rb-4.1.0&q=85&fm=png&crop=entropy&cs=srgb&dl=alghozy-KBMDNdZ_3_A-unsplash.png&w=4000
    # <a href="https://unsplash.com/illustrations/desk-with-laptop-notebook-phone-and-coffee-KBMDNdZ_3_A?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Illustration</a> by <a href="https://unsplash.com/@artgho/illustrations?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Alghozy</a> on <a href="https://unsplash.com/illustrations?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Unsplash</a>
Header: Witex Feature Showcase              # blank = use Title
Footer:                                     # blank = "<page> of <total>"
Cover Logo:
  - Path: themes/acme-logo-black.svg
  # - Background: rgba(255, 255, 255, 0.6)
TOC Depth: 3                                # 1–6, deepest heading level listed; omit for every level
Page Size: A4                               # A3 | A4 | A5 | Letter | Legal | Tabloid | "210mm 297mm"
Margins: 20mm                               # 1–4 CSS lengths: 20mm | "25mm 15mm" | "25mm 15mm 20mm 15mm"
Orientation: portrait                       # portrait | landscape — applies to every page, cover included
Variables:                                  # any name here becomes {{Name}} in the body
    Customer: Acme Manufacturing
    Contact: J. de Vries
Numbered Headings: true                     # true | false
Running Header: true                        # true | false
List of Tables: true                        # true | false
List of Figures: true                       # true | false
Code Line Numbers: true                     # true | false
Trademark Symbols: true                     # true | false — off keeps "(c)"/"(r)"/"(tm)" literal
Watermark: Sample                           # any text | true (reuse Status) | false — never shown once Status is Released/Vrijgegeven
Classification: Internal                    # Public | Internal | Confidential
Lang: en                                    # en | nl | de | fr | es — localises the generated glossary heading
Mode: pdf, html                             # pdf | html | debug — comma-separated for several
# PDF Variant: pdf/a-2b                     # tags the PDF as an archival/accessible/print-production conformance
                                             # level instead of an ordinary PDF — full list: --help
---

# WiTeX — The Art of Academic Typesetting

## Contents<!-- omit in toc -->

- [WiTeX — The Art of Academic Typesetting](#witex--the-art-of-academic-typesetting)
  - [Frontmatter \& Cover Page](#frontmatter--cover-page)
  - [Typography](#typography)
- [Heading 1](#heading-1)
  - [Heading 2](#heading-2)
    - [Heading 3](#heading-3)
      - [Heading 4](#heading-4)
        - [Heading 5](#heading-5)
          - [Heading 6](#heading-6)
  - [Lists](#lists)
  - [Tables](#tables)
  - [Code Blocks](#code-blocks)
  - [Mermaid Diagrams](#mermaid-diagrams)
  - [Infographics](#infographics)
  - [Math — KaTeX](#math--katex)
  - [Admonitions \& Alerts](#admonitions--alerts)
    - [GitHub Alerts](#github-alerts)
    - [MkDocs Admonitions](#mkdocs-admonitions)
  - [Blockquotes, Footnotes \& Abbreviations](#blockquotes-footnotes--abbreviations)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Markdown Extras](#markdown-extras)
    - [Highlight, Subscript \& Superscript](#highlight-subscript--superscript)
    - [Definition Lists](#definition-lists)
    - [Code Line Highlighting](#code-line-highlighting)
    - [Captions](#captions)
    - [Columns](#columns)
    - [Collapsible Details](#collapsible-details)
    - [Spanning Table Cells](#spanning-table-cells)
    - [Including Source Files](#including-source-files)
  - [Document Controls](#document-controls)
    - [Numbered Headings](#numbered-headings)
    - [Running Header](#running-header)
    - [List of Tables \& Figures](#list-of-tables--figures)
    - [Watermark](#watermark)
    - [Code Line Numbers](#code-line-numbers)
    - [Trademark Symbols](#trademark-symbols)
    - [Classification](#classification)
    - [Frontmatter Variables](#frontmatter-variables)
    - [TOC Depth](#toc-depth)
    - [Paper Size \& Margins](#paper-size--margins)
    - [Page Orientation](#page-orientation)
    - [Cover \& Footer Overrides](#cover--footer-overrides)
    - [Cross-References with Page Numbers](#cross-references-with-page-numbers)
    - [Landscape Pages](#landscape-pages)
  - [Icons](#icons)
    - [Font Awesome](#font-awesome)
    - [Phosphor Icons](#phosphor-icons)
  - [Page Breaks \& Layout](#page-breaks--layout)
  - [Theme \& Branding](#theme--branding)
    - [Named Styles](#named-styles)
    - [Colour Palette](#colour-palette)
    - [Brand Logo](#brand-logo)
    - [Scheme Classes](#scheme-classes)
    - [Custom Style](#custom-style)
    - [Fonts](#fonts)

---

## Frontmatter & Cover Page {.page-break-before}

**WiTeX**, built on Donald Knuth's TeX and shaped by Leslie Lamport, is the standard for typesetting mathematics and academic papers. The **`witex`** theme evokes that look — Latin Modern serif type and a classic, framed title page.

```yaml
---
# ── Document identity ─────────────────────────────────────────────
Title: WiTeX — The Art of Academic Typesetting
Document Info:                 # the cover's info block
    Author: Leslie Lamport
    Date: "2026-04-08"
    Revision: 1
    Status: Final              # Work In Progress | Released — Released bumps the revision after export
Revisions Visible: 3           # rows shown on the cover; 0 hides the table
Revisions:
    - {Revision: 1, Date: "2026-04-08", Author: Leslie Lamport, Remarks: Initial release}
Lang: en                       # <html lang>; default en

# ── Branding ──────────────────────────────────────────────────────
Theme: Witex                   # brand package — see --list-themes
Style: Witex                   # a named style
# Style:                       # …or an inline style instead of a named one:
#     Color: "#336699"         #   any hex, or a palette name
#     Image: path/or/url.jpg   #   hero photo behind a translucent gradient
#     Position: 30%            #   vertical crop offset
Logo: assets/brand-logo.svg    # path to an image (this theme defines no named logos)
Cover Logo:                    # a third-party logo overlaid on the cover
    - Path: assets/customer-logo.png
    - Background: rgba(255,255,255,0.5)

# ── Page setup ────────────────────────────────────────────────────
Header:                        # blank = use Title
Footer:                        # blank = "<page> of <total>"
Page Size: A4                  # A3 | A4 | A5 | Letter | Legal | Tabloid | "210mm 297mm"
Margins: 20mm                  # 1–4 CSS lengths, like the margin shorthand
TOC Depth: 3                   # deepest heading level listed; omit for all

# ── Document controls (all default to off) ────────────────────────
Numbered Headings: true        # 1, 1.1, 1.1.1 on h2–h6
Running Header: true           # header tracks the current section
List of Tables: true
List of Figures: true
Code Line Numbers: true
Trademark Symbols: true        # (c)/(r)/(tm) -> ©/®/™; off (default) keeps them literal
Watermark: Draft               # any text, or true to reuse Status
Classification: Internal       # Public | Internal | Confidential

# ── Content & output ──────────────────────────────────────────────
Variables:                     # {{Customer}} anywhere in the body
    Customer: Acme Manufacturing
Mode: pdf, html                # pdf | html | debug — comma-separated
---
```

**Title & subtitle.** On the cover the `Title` is split at the first *spaced* em-dash (`A — B`), en-dash, or colon (`A: B`) — much like a `\title{}` with a `\\` break. Here **WiTeX** is the headline and *The Art of Academic Typesetting* the subtitle. A title without a separator renders as a single headline.

**Every key is optional** and all of them are case-insensitive (`Page Size` and `page size` both work). Omit one and the export falls back to a sensible default.

**Document identity**

| Key | Description |
| --- | ----------- |
| `Title` | Split into headline + subtitle on the cover, as above |
| `Document Info` | Cover info block — `Author`, `Date`, `Revision`, `Status` |
| `Revisions` | List of `{Revision, Date, Author, Remarks}` entries for the revision table |
| `Revisions Visible` | How many revision rows the cover shows; `0` hides the table |
| `Lang` | Document language for the `<html lang>` attribute (default `en`) |

`Revision` in the footer resolves in order: `Document Info.Revision`, then the last `Revisions` entry, then a top-level `Version` or `Revision`.

**Branding**

| Key | Description |
| --- | ----------- |
| `Theme` | Brand package — `Witex` here; see `--list-themes` |
| `Style` | Cover variant: a named style (`Witex`), or `{Color, Image, Position}` |
| `Logo` | Brand mark, chosen independently of `Style` |
| `Cover Logo` | Third-party logo overlaid on the cover — `Path` plus optional `Background` |

**Page setup**

| Key | Description |
| --- | ----------- |
| `Header` | Top-left running header; blank uses the `Title` |
| `Footer` | Footer text; blank uses `<page> of <total>` |
| `Page Size` | `A3`, `A4`, `A5`, `Letter`, `Legal`, `Tabloid`, or a literal `210mm 297mm` |
| `Margins` | 1–4 CSS lengths, like the CSS `margin` shorthand |
| `TOC Depth` | Deepest heading level listed in the TOC; omit for every level |

**Document controls** — each covered in its own section further down

| Key | Description |
| --- | ----------- |
| `Numbered Headings` | Auto-number `##`–`######` as 1, 1.1, 1.1.1 |
| `Running Header` | Header tracks the current section instead of a fixed string |
| `List of Tables` | Index of captioned tables after the TOC |
| `List of Figures` | Index of captioned figures after the TOC |
| `Code Line Numbers` | Number every line of every fenced code block |
| `Trademark Symbols` | Converts `(c)`/`(r)`/`(tm)` to ©/®/™ — off by default |
| `Watermark` | Diagonal stamp; `true` reuses `Status` |
| `Classification` | `Public`, `Internal` or `Confidential` in the top-right margin |

**Content & output**

| Key | Description |
| --- | ----------- |
| `Variables` | Named values substituted into the body as `{{Name}}` |
| `Mode` | `pdf`, `html`, `debug` — comma-separated for several |

> [!TIP]
> The frontmatter at the top of this document sets every one of these, so it doubles as a working reference — read it alongside the rendered result.

---

## Typography

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Normal paragraph text set in a serif face. **Bold text** stands out, while *italic text* adds emphasis — the workhorse of scholarly prose. Combine them: ***bold and italic***.

Inline `code` suits control sequences like `\documentclass` or `\begin{equation}`.

**Plain emphasis.** The markdown syntaxes stay plain, so a document reads the same here as it does anywhere else: ~~strikethrough~~ is an ordinary struck line, and ++underline++ gives you the underline markdown otherwise lacks. Neither is tinted.

**Revision marks.** The redline tint lives on the HTML tags, which you write deliberately: `<ins>inserted</ins>` and `<del>deleted</del>`, plus `==highlighted==`. Reaching for a tag is the opt-in — plain `~~tilde~~` never implies a tracked revision.

We <ins>added this clause</ins>, <del>removed that one</del>, and ==flagged this for review==. Compare plain ~~struck text~~ and ++underlined text++, which carry no revision colour.

Links look like this: [The WiTeX Project](https://www.WiTeX-project.org). They are clickable in the PDF.

Emoji are supported too 📐 — from classics like ✅ 📖 ⚠️ to recent additions: pink heart 🩷, harp 🪉 and paint splatter 🫟.

Horizontal rules separate sections:

---

## Lists

**The document classes** (unordered):

- `article` — papers and short reports
- `report` — longer works with chapters
  - `book` — two-sided, parts and chapters
  - `beamer` — presentation slides
    - `letter` — correspondence
- `standalone` — a single figure or equation

**Compiling** (ordered):

1. Write `.tex` source
2. Run the engine
   1. `pdfWiTeX` for classic output
   2. `xeWiTeX` / `luaWiTeX` for system fonts
3. Resolve references (run again)

**Mixed:**

- Maths mode
  1. inline `$…$`
  2. display `\[…\]`
- Environments
  1. `equation`
  2. `align`

---

## Tables

Tables are the Markdown equivalent of the `tabular` environment. Columns can be left-, center-, or right-aligned.

**Common packages:**

| Package    | Purpose                      | Author         |
| ---------- | ---------------------------- | -------------- |
| `amsmath`  | Advanced maths environments  | AMS            |
| `graphicx` | Include images               | WiTeX Team     |
| `booktabs` | Publication-quality rules    | Simon Fear     |
| `bibWiTeX` | Bibliographies and citations | Philipp Lehman |

**Column alignment:**

| Left-aligned   | Center-aligned | Right-aligned |
| :------------- | :------------: | ------------: |
| `\raggedright` |  `\centering`  | `\raggedleft` |
| text           |    centred     |         1,234 |
| longer         |      mid       |        99,999 |

---

## Code Blocks {.page-break-before}

Fenced code blocks use `highlight.js` for syntax highlighting.

**A minimal WiTeX document:**

```WiTeX
\documentclass[11pt]{article}
\usepackage{amsmath}
\title{On the Distribution of Primes}
\author{L.~Euler}
\begin{document}
\maketitle
\begin{abstract}
  We revisit the prime counting function \(\pi(x)\).
\end{abstract}
\end{document}
```

**A theorem environment:**

```WiTeX
\begin{theorem}[Euclid]
  There are infinitely many prime numbers.
\end{theorem}
\begin{proof}
  Suppose not; multiply all primes and add one. \qed
\end{proof}
```

**BibTeX entry:**

```bibtex
@article{lamport1994,
  author  = {Leslie Lamport},
  title   = {WiTeX: A Document Preparation System},
  year    = {1994},
  edition = {2}
}
```

---

## Mermaid Diagrams {.page-break-before}

Mermaid diagrams are rendered to SVG and embedded directly in the PDF.

**The compilation toolchain:**

```mermaid
flowchart TD
    Tex([.tex source]) --> Engine[pdfWiTeX / xeWiTeX]
    Engine --> Aux[.aux references]
    Aux --> Bib[biber / bibtex]
    Bib --> Engine
    Engine --> Pdf([.pdf output])

    style Tex fill:#e8e8e8
    style Pdf fill:#c8e6c9
    style Engine fill:#fff9c4
```

**Reference resolution:**

```mermaid
sequenceDiagram
    participant A as Author
    participant E as Engine
    participant X as .aux file
    A->>E: first pass
    E->>X: write labels & citations
    A->>E: second pass
    X-->>E: resolve \ref and \cite
    E-->>A: final PDF
```

---

## Infographics {.page-break-before}

` ```infographic ` fences render [AntV Infographic](https://github.com/antvis/infographic)'s declarative syntax — lists, sequences, hierarchies, comparisons and charts — with no browser. Icons are [Iconify](https://icon-sets.iconify.design/) names, and only those names are sent. Many templates give text a fixed slot, so keep labels short.

**Resolving references:**

```infographic
infographic sequence-stairs-front-simple
data
  lists
    - label First pass
      desc Labels go to .aux
    - label biber
      desc Resolves citations
    - label Second pass
      desc Fills every reference
    - label Final PDF
      desc Nothing left undefined
```

---

## Math — KaTeX {.page-break-before}

Mathematics is WiTeX's *raison d'être*. Expressions are rendered by KaTeX using the same syntax.

The Euler product connects a sum over integers to a product over primes (inline): $\zeta(s) = \sum_{n\ge 1} n^{-s}$.

**Display block — the Euler product:**

$$
\zeta(s) = \sum_{n=1}^{\infty} \frac{1}{n^{s}} = \prod_{p\ \text{prime}} \frac{1}{1 - p^{-s}}
$$

**An aligned derivation:**

$$
\begin{aligned}
  e^{i\pi} + 1 &= 0 \\
  \int_{-\infty}^{\infty} e^{-x^2}\,dx &= \sqrt{\pi}
\end{aligned}
$$

---

## Admonitions & Alerts {.page-break-before}

Two syntaxes are supported: **GitHub Alerts** and **MkDocs-style admonitions** — the Markdown analogue of `\begin{tcolorbox}`.

### GitHub Alerts

> [!NOTE]
> WiTeX separates content from presentation, just like themes separate Markdown from styling.

> [!TIP]
> Use `\label{}` and `\ref{}` for automatic cross-references — never hard-code equation numbers.

> [!IMPORTANT]
> Always run the engine twice so labels and the table of contents resolve.

> [!WARNING]
> Underfull and overfull `\hbox` warnings mean a line couldn't be broken cleanly.

> [!CAUTION]
> Editing the `.aux` file by hand will be overwritten on the next compile.

### MkDocs Admonitions

!!! note
    Default note admonition — no custom title.

!!! tip Fonts
    `xeWiTeX` and `luaWiTeX` can use any system OpenType font, unlike classic `pdfWiTeX`.

!!! abstract Structure
    Preamble, then `\begin{document}` … `\end{document}`.

!!! success
    The document compiled with no unresolved references.

---

## Blockquotes, Footnotes & Abbreviations

**Blockquote:**

> A pleasing appearance is not the goal of typesetting; a document that is easy to read is.
>
> — after Leslie Lamport

**Footnotes:**

TeX was created by Donald Knuth in 1978.[^tex] WiTeX added a document-preparation layer on top.[^WiTeX]

[^tex]: Donald E. Knuth, *The TeXbook*, 1984.
[^WiTeX]: Leslie Lamport, *WiTeX: A Document Preparation System*, 1986.

**Abbreviations:**

*[TeX]: Tau Epsilon Chi, Knuth's typesetting system
*[DVI]: Device Independent file format
*[AMS]: American Mathematical Society
*[PDF]: Portable Document Format

For example: classic TeX produces DVI, while modern engines emit PDF directly; AMS packages supply the maths environments.

---

## Keyboard Shortcuts

Use the `<kbd>` tag to render a keyboard key or chorded shortcut:

```markdown
<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd>
```

Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd> to open the launcher. Single keys work the same way: <kbd>Esc</kbd>, <kbd>Enter</kbd>, <kbd>⌘</kbd>, <kbd>⇧</kbd>.

---

## Markdown Extras {.page-break-before}

### Highlight, Subscript & Superscript

Mark important text with `==highlight==`: this phrase is ==highlighted== for emphasis.

Chemical formulas use subscript (`H~2~O`): water is H~2~O and carbon dioxide is CO~2~.

Exponents use superscript (`x^2^`): the area of a circle is πr^2^, and 2^10^ = 1024.

### Definition Lists

```markdown
Term
: Definition of the term, indented below it.
```

Markdown
: A lightweight markup language for formatting plain text.

WeasyPrint
: The HTML-to-PDF rendering engine used for the PDF output mode.

### Code Line Highlighting

Add a `:2,4-6`-style line range after the language to highlight specific lines — no space, no braces (braces there would collide with `markdown-it-attrs`' own `{.class}` syntax on fences):

````markdown
```typescript:2,4-5
function greet(name: string): string {
    const greeting = `Hello, ${name}!`;
    console.log(greeting);
    return greeting;
    // highlighted through here
}
```
````

```typescript:2,4-5
function greet(name: string): string {
    const greeting = `Hello, ${name}!`;
    console.log(greeting);
    return greeting;
    // highlighted through here
}
```

### Captions

Add a `Table: caption` or `Figure: caption` paragraph directly under a table or image for an auto-numbered caption. Tables and figures are numbered independently:

| A   | B   |
| --- | --- |
| 1   | 2   |

Table: Two-column example with an auto-numbered caption.

Figures work the same way — the counters are independent, so this is Figure 1 even though Table 1 came first:

![GitHub logo](../acme-logo-black.svg)

Figure: A standalone image with an auto-numbered caption.

### Columns

Lay content out side by side with nested containers. The outer wrapper needs **more** colons than the inner blocks (`::::` outside, `:::` inside) — with equal-length fences the parser can't tell which `:::` closes which block:

```markdown
:::: columns
::: column
Left column content.
:::
::: column
Right column content.
:::
::::
```

:::: columns
::: column
**Left column.** Good for a summary, a quote, or a short list.
:::
::: column
**Right column.** Good for the counterpart — a comparison, a caveat, or supporting detail.
:::
::::

### Collapsible Details

`<details>` / `<summary>` renders as a styled block. In the **PDF** it always shows its content — there's no click to expand on paper. In the **HTML export**, opened in a real browser, it's genuinely collapsible.

<details>
<summary>Click to expand (in HTML — always open in PDF)</summary>

Hidden detail content goes here. Useful for optional context that shouldn't compete with the main flow.

</details>

---

### Spanning Table Cells

Merge cells with `{colspan=N}` / `{rowspan=N}` on the cell. The rule is the same in both directions: **the covered cells are simply not written**, so a spanning row has fewer `|` cells than the header.

```markdown
| Region         | Site      | Role    |
| -------------- | --------- | ------- |
| EU {rowspan=2} | Venlo     | Primary |
| Genk           | Secondary |
```

| Region         | Site      | Role    |
| -------------- | --------- | ------- |
| EU {rowspan=2} | Venlo     | Primary |
| Genk           | Secondary |
| APAC           | Osaka     | Primary |

Table: `{rowspan=2}` — the covered row writes one fewer cell.

| Phase                               | Task         | Owner |
| ----------------------------------- | ------------ | ----- |
| Design                              | Draft schema | WB    |
| Spans first two columns {colspan=2} | PS           |

Table: `{colspan=2}` — that row writes one fewer cell too.

### Including Source Files

`[!include](file.md)` splices another markdown document. Two extensions to it:

- **Any non-markdown file** is quoted as a fenced code block, with the language inferred from its extension — so documentation can quote live source instead of a copy that silently rots.
- **A `#L` fragment** takes only those lines: `#L10` for one line, `#L10-L25` for a range. Works on markdown includes too, where it splices the excerpt inline (no page break, no revision heading) rather than as a whole document.

```markdown
[!include](../src/types.ts)           <!-- whole file, as TypeScript -->
[!include](../src/types.ts#L3-L9)     <!-- just those lines -->
[!include](chapter.md#L1-L20)         <!-- a markdown excerpt, spliced inline -->
[!include](Main.config "xml")         <!-- override the language -->
```

A **link title overrides the language**, for extensions that say nothing about their content — a `.config` file is usually XML, not a language called "config". It combines with a range (`Main.config#L5-L40 "xml"`), and because a language only means anything for a code block, giving one also *forces* code-block treatment: `[!include](chapter.md "markdown")` quotes the markdown source instead of splicing it in.

Lines 3–9 of this project's `src/types.ts`, pulled in live at export time:

[!include](../../src/types.ts#L3-L9)

---

## Document Controls {.page-break-before}

These are switched on per document from the YAML frontmatter — **this sample enables all of them**, so every effect described below is visible in this very PDF:

```yaml
Numbered Headings: true      # 1, 1.1, 1.1.1 on every heading
Running Header: true         # top-left header tracks the current section
List of Tables: true         # index of captioned tables, after the TOC
List of Figures: true        # index of captioned figures, after the TOC
Code Line Numbers: true      # number every line of every code block
Trademark Symbols: true      # (c)/(r)/(tm) -> ©/®/™
Watermark: Sample            # diagonal stamp; `true` reuses Document Info → Status
Classification: Internal     # Public | Internal | Confidential
```

### Numbered Headings

`Numbered Headings: true` prefixes every `##`–`######` with a hierarchical number: `##` is section 1, `###` is 1.1, `####` is 1.1.1. `#` is never numbered — it is the document title, not a section.

The numbering is applied before the table of contents is rebuilt, so **the TOC always shows the same numbers as the body** — they cannot drift apart.

### Running Header

`Running Header: true` replaces the static `Header:` string in the top-left margin with the title of the section currently being read. Flip back to this page's header and you will see it reads *Document Controls*, not the document title.

### List of Tables & Figures

`List of Tables: true` and `List of Figures: true` each emit an index directly after the table of contents, built from the auto-numbered captions described under [Captions](#captions){.page-ref} — with live page numbers, like the TOC. An enabled list with no captions of that kind emits nothing rather than an empty heading.

### Watermark

`Watermark: Sample` stamps a faint diagonal label across every page — the word you are reading behind this text. Setting `Watermark: true` instead reuses the document's `Status` field, which is the usual way to mark a *Work in Progress* draft.

### Code Line Numbers

`Code Line Numbers: true` numbers every line of every fenced code block, which pairs naturally with the line highlighting from [Code Line Highlighting](#code-line-highlighting){.page-ref} — you can then write "see line 4" and have it mean something:

```typescript:3
interface ExportOptions {
    theme: string;
    mode: ("pdf" | "html")[];   // line 3 — highlighted and numbered
}
```

### Trademark Symbols

`Trademark Symbols: true` converts `(c)`, `(r)`, `(tm)` to ©, ®, ™. It defaults to **off**, because those sequences show up far more often as literal parentheticals — a revision marker written `(R)`, an option labelled `(c)` — than as an actual trademark reference, and silently swapping one for a symbol would corrupt real text. This document opts in, so here they convert: (c) (r) (tm).

### Classification

`Classification:` prints a sensitivity label in the **top-right** margin of every page:

| Value          | Result                                      |
| -------------- | ------------------------------------------- |
| `Public`       | a green shield followed by *Public*         |
| `Internal`     | an amber shield followed by *Internal*      |
| `Confidential` | an orange shield followed by *Confidential* |

Table: The three Classification values and what each prints.

This document is set to `Internal`, so an amber shield sits in the top-right corner of every page. The shield is Phosphor's duotone weight: the fill takes the classification colour, the outline is black.

### Frontmatter Variables

Define a `Variables:` mapping and reference it as `{{Name}}` anywhere in the body — the substitution happens before parsing, so a value can be a word, a URL, or a whole sentence. One template, many customers:

```yaml
Variables:
    Customer: Acme Manufacturing
    Contact: J. de Vries
```

> This document was prepared for **{{Customer}}**, contact {{Contact}}.

An undefined placeholder is left exactly as written and logged as a warning — blanking it silently would let a typo ship as an invisible hole in a customer deliverable.

### TOC Depth

`TOC Depth: 3` limits the table of contents to `###` and shallower. Deeper headings still render — and still get numbered — they just stop cluttering the contents page. This document uses depth 3, which is why the `####` heading under [Typography](#typography){.page-ref} is absent from the TOC but present in the body.

### Paper Size & Margins

```yaml
Page Size: A4        # A3 | A4 | A5 | Letter | Legal | Tabloid, or "210mm 297mm"
Margins: 20mm        # 1–4 CSS lengths, like the CSS margin shorthand
```

`Margins` accepts the same 1–4 value shorthand as CSS (`20mm`, `25mm 15mm`, `25mm 15mm 20mm 15mm`). Both also drive the height cap applied to diagrams, so a tall Mermaid chart is scaled to fit the sheet it lands on instead of running off the bottom — which matters most on a `::: landscape` page, where a rotated A4 is only 210mm tall.

### Page Orientation

`Orientation: landscape` turns the **whole** document landscape — body pages and cover alike. It defaults to `portrait`, which is what this sample uses.

```yaml
Orientation: landscape
```

Either way, two containers force a single sheet of the opposite orientation, so the document default is only ever a default:

```markdown
::: landscape        <!-- one landscape sheet, in a portrait document -->
| a wide table … |
:::

::: portrait         <!-- one portrait sheet, in a landscape document -->
Ordinary prose that reads better upright.
:::
```

They are symmetric — `::: portrait` is simply the mirror of the `::: landscape` shown under [Landscape Pages](#landscape-pages){.page-ref}, and each is a harmless no-op when it matches the document default.

### Cover & Footer Overrides

The generated cover and the page-margin logo can be tuned per document, without editing the theme. Every one of these keys also accepts `false` to remove that element outright:

```yaml
Cover Page: false                    # no cover at all — but Style's colours stay
Cover Slogan: Engineering, delivered.
Cover Address:                       # a list becomes one line per entry
    - Acme Manufacturing B.V.
    - Industrieweg 12
Cover Footer Logo: Cherry            # a name from the theme's logos map, or a path
Footer Logo: Cherry                  # the same mark, bottom-centre of every page
```

| Key | Controls | `false` |
| --- | -------- | ------- |
| `Cover Page` | whether a cover is generated at all | no cover page |
| `Cover Slogan` | the slogan line, bottom-left of the cover | line removed |
| `Cover Address` | the address block, right of the cover's info table | block removed |
| `Cover Footer Logo` | the brand mark, bottom-right of the cover | mark removed |
| `Footer Logo` | the brand mark in the bottom-centre page margin | mark removed |

Table: The cover and footer override keys.

`Cover Page: false` is worth calling out: omitting `Style` also removes the cover, but takes the brand colours with it — headings and table headers fall back to the theme default. This key removes only the page.

Logo values resolve the same way as [Brand Logo](#brand-logo){.page-ref} — a name from the theme's `logos` map, or a path — so a typo exits with code 3 instead of quietly reverting to the house mark.

### Cross-References with Page Numbers

Add `{.page-ref}` to any internal link and the resolved page number is appended when the PDF is laid out:

```markdown
See [the Captions section](#captions){.page-ref} for details.
```

See [the Captions section](#captions){.page-ref} for details — the page number in that sentence was computed at export time, not typed.

### Landscape Pages

Wrap wide content in a `::: landscape` container to give it its own rotated sheet, instead of squeezing it into the portrait text column:

```markdown
::: landscape
| a wide table … |
:::
```

The table below sits on its own landscape page:

::: landscape

| WBS     | Task                        | Form | Hours | Role            | Location | Milestone |
| ------- | --------------------------- | ---- | ----- | --------------- | -------- | :-------: |
| 1.1.1.1 | Review requirements         | TM   | 2     | Consultant      |          |           |
| 1.1.2.1 | Project brief               | NA   | 0     | Account Manager | Customer |     Y     |
| 1.2.1.1 | Project management          | TM   | 4     | Project Manager |          |           |
| 1.2.3.1 | Scoping workshop @ customer | FP   | 8     | PM, Consultant  | Customer |     Y     |

Table: A seven-column table given its own landscape sheet.

:::

---

## Icons {.page-break-before}

Two icon libraries are bundled automatically when their tags appear.

### Font Awesome

| Style    | HTML                                                       | Result                                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Solid    | `<i class="fa-solid fa-square-root-variable">`             | <i class="fa-solid fa-square-root-variable"></i>             |
| Solid    | `<i class="fa-solid fa-book">`                             | <i class="fa-solid fa-book"></i>                             |
| Coloured | `<i class="fa-solid fa-circle-check" style="color:#333;">` | <i class="fa-solid fa-circle-check" style="color:#333;"></i> |

### Phosphor Icons

<i class="ph ph-function"></i> regular &nbsp; <i class="ph-bold ph-book-open"></i> bold &nbsp; <i class="ph-fill ph-check-circle" style="color:#333;"></i> fill

---

## Page Breaks & Layout

Add `{.page-break-before}` after a heading to start it on a new page — the analogue of `\clearpage`:

```markdown
## My Section {.page-break-before}
```

The attribute is stripped from the TOC link and anchor. Use `<!-- omit in toc -->` after a heading to keep it out of the Table of Contents.

---

## Theme & Branding {.page-break-before}

A **theme** is a swappable brand package under `themes/`. The **`witex`** theme mimics the WiTeX article look: Latin Modern serif type on a light page, with a classic double-ruled title page.

```yaml
Theme: Witex
Style: Witex
```

### Named Styles

The `witex` theme ships a single style whose **main** colour drives the cover accents and tints headings and table headers:

| Style name | Primary colour |
| ---------- | -------------- |
| `Witex`    | `#1a1a1a`      |

### Colour Palette

The **Witex** ramp — `extraLight` → `light` → `main` → `dark` → `extraDark`:

**Witex** — `#e8e8e8` · `#767676` · `#1a1a1a` · `#121212` · `#0a0a0a`

Each palette is also emitted into the document as CSS variables named `--<palette>-<stop>` (lowercase), so custom CSS can reference the theme's colours instead of restating hex values:

```css
var(--witex-main)
var(--witex-extra-light)
var(--witex-dark)
```

Every palette additionally gets a gradient token, `--gradient-<palette>` (135°, `light` → `dark`):

```css
background: var(--gradient-witex);
```

These are generated from `theme.json`, which is the single source of truth for the theme's colour — a theme's CSS never redeclares a palette value.

### Brand Logo

`Logo:` overrides the brand mark shown on the cover and in the page header, **independently of `Style:`**:

```yaml
Style: Witex
Logo: assets/customer-logo.svg
```

The value is a path to an image, or — for themes that define a `logos` map in `theme.json` (the `modern` theme does, one per fruit palette) — one of those names. Paths resolve against the theme directory first, then the working directory. An unrecognised value is a hard error rather than a silent fallback to the house logo. Omit the key to keep the theme's own logo.

> [!NOTE]
> `Logo` and `Cover Logo` are different: `Logo` is the *theme's* brand mark, while `Cover Logo` overlays a *third-party* logo (a customer or partner) on the cover.

### Scheme Classes

Every palette gets a pair of utility classes for inline colour blocks — `<theme>-<palette>-scheme` (heavy) and `<theme>-<palette>-light-scheme` (content-first):

```html
<div class="witex-witex-scheme">Witex — heavy scheme</div>
<div class="witex-witex-light-scheme">Witex — light scheme</div>
```

<div class="witex-witex-scheme">Witex — heavy scheme</div>
<div class="witex-witex-light-scheme">Witex — light scheme</div>

Available in this theme: `witex-witex-scheme` (each with a `-light-scheme` variant).

The text colour is chosen automatically: white where it clears the WCAG AA contrast threshold against the background, and the palette's darkest stop where it doesn't — so a pale `main` can't produce unreadable white-on-light text.

### Custom Style

Instead of the named style, provide a `Color` and an optional hero `Image`:

```yaml
Style:
    Color: "#1a1a1a"
    Image: https://example.com/hero.jpg
```

### Fonts

The **Witex** theme sets its typography to a Latin Modern / Computer Modern serif stack — the faces TeX made famous:

`"Latin Modern Roman", "Computer Modern", Georgia, serif`
