---
Title: Pipeline Fixture
Theme: default
Style: Navy
Lang: en
Numbered Headings: true
List of Tables: true
List of Figures: true
Code Line Numbers: true
TOC Depth: 3
Revisions Visible: 2
Document Info:
  Author: Fixture Author
  Status: Work In Progress
Variables:
  product: Widgetron
  release: "4.2"
Revisions:
  - Revision: 1
    Date: "2020-01-01"
    Author: Fixture Author
    Remarks: first
  - Revision: 2
    Date: "2020-02-02"
    Author: Fixture Author
    Remarks: second
---

# Pipeline Fixture

## Table of Contents

- [Placeholder](#placeholder)

## Prose And Inline Marks

{{product}} version {{release}} ships with H~2~O at x^2^ and ==highlighted== text.
Press <kbd>Ctrl</kbd> + <kbd>S</kbd> to save. A footnote lives here.[^one]

[^one]: The footnote body.

*[API]: Application Programming Interface
*[TOC]: Table of Contents

The API and the TOC both appear in the glossary.

### Definition List

Term
: The definition of the term.

Another Term
: Its definition.

## Admonitions

> [!NOTE]
> A GitHub-style note.

> [!WARNING]
> A GitHub-style warning.

!!! tip "A MkDocs tip"
    Indented tip body.

!!! danger
    A danger block with no title.

## Code

```typescript:2,4-5
const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
```

```
plain fence, no language
```

## Tables And Figures

| Column A | Column B |
|----------|----------|
| one      | two      |
| three    | four     |

Table: The first caption.

| Only | Column |
|------|--------|
| x    | y      |

Table: The second caption.

## Task List

- [ ] Not done
- [x] Done

## Math

Inline $E = mc^2$ and a block:

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Columns

:::: columns
::: column
Left column body.
:::
::: column
Right column body.
:::
::::

## Deep Nesting

### Level Three Heading

#### Level Four Is Below TOC Depth

Body text under a heading deeper than `TOC Depth: 3`.

[!include](included.md)
