# Document templates

A template is a starting point for one kind of document: the frontmatter it
needs and the outline of its sections. Starting a meeting-notes document from a
template gives you the attendee table, the decisions and the action items, with
the cover turned off, instead of a blank page.

```sh
platen-markdown-export --list-templates
platen-markdown-export --init --template meeting-notes > weekly.md
```

In VS Code, **New Document** and **Frontmatter Wizard** ask for the document type
first. The fill-in wizard only adds the template's frontmatter, because the
document already has content of its own.

## Built-in templates

| Template           | For                                                                   |
|--------------------|-----------------------------------------------------------------------|
| `report`           | A formal report: cover, contents, numbered sections, list of tables   |
| `technical-design` | Context, requirements, design, alternatives, risks, rollout           |
| `meeting-notes`    | Attendees, agenda, decisions and action items, with no cover page     |
| `how-to`           | Prerequisites, numbered steps, a check, and troubleshooting           |

Table: Built-in templates

All four use the brand-neutral `default` theme. Put your own templates on the
search path to replace them (see below).

## Writing a template

A template is a folder containing `template.md` and, optionally,
`template.json`:

```text
my-templates/
  offer/
    template.md
    template.json      { "description": "Quotation for a customer" }
```

`template.md` is an ordinary document:

```markdown
---
Theme: acme
Style: Navy
Classification: Confidential
Numbered Headings: true
Document Info:
    Customer:
    Project:
---

# {{Title}}

## Scope

## Price
```

When a document is created from a template:

- **The template's frontmatter is applied on top of the standard scaffold.** Any
  key it sets replaces the scaffold's value, and keys the scaffold does not have
  are added. Comments stay with the key they are written above.
- **Your answers win.** A theme picked in the wizard, or given in an `--answers`
  file, replaces the template's own. The wizard does not ask about a theme, style
  or mode the template already sets.
- **The document's identity always comes from the scaffold:** `Title`, today's
  date, the author, revision 1 and its `Revisions` row. A template can add labels
  to `Document Info` (such as `Customer:` above), but its `Author`, `Date`,
  `Revision` and `Status` are always the new document's own.
- **`{{Title}}`, `{{Author}}` and `{{Date}}` in the body are filled in.** Any
  other `{{Name}}` is left alone, so the document's `Variables` can fill it in at
  export.

> [!TIP]
> Build the outline out of the exporter's own features (admonitions, captioned
> tables, task lists, definition lists), so every document of that type starts
> with them.

## Where templates are found

In order, so the first one with a given name wins:

1. `--template-path <dir>` (repeatable)
2. `EXPORT_TEMPLATE_PATH`, a `PATH`-style list
3. `templatePaths` in `platen-markdown-export.json`, walked up from the working
   directory, then the user config
4. the built-in `templates/`

```json
{ "templatePaths": ["./templates"] }
```

A template called `report` in your own folder replaces the built-in `report`.
`--template` also takes a path: a template folder, or a single `.md` file.

## Frontmatter defaults

Templates set up a document once. **Frontmatter defaults** keep applying: the same
`platen-markdown-export.json` can give every document under its folder keys it
does not set itself.

```json
{
  "frontmatterDefaults": {
    "Theme": "acme",
    "Style": "Navy",
    "Classification": "Internal",
    "Variables": { "Customer": "Acme Manufacturing" }
  }
}
```

- **The document wins.** A key the document sets itself, in any casing, ignores
  the default.
- **The nearest config wins.** A project config overrides one further up, and
  every project config overrides the user config at
  `~/.config/platen-markdown-export/config.json` (`%APPDATA%` on Windows).
- **`Variables` merge per name.** The user config can hold your company's name
  while a project config adds the customer, and a document can override a single
  variable.
- **Nothing is written into the document.** The export log names the file each
  default came from.

A few keys cannot be defaults, and are ignored with a warning: `Title`,
`Document Info`, `Revisions`, `Revision`, `Version`, `Status` and `Date` belong to
one document, and `--release` rewrites them in the document itself. `Mode` and
`Export On Save` must also be in the document, because the VS Code extension
reads them from the document's text to decide whether saving exports it. A
default `Mode` would export from the terminal and never on save.

> [!NOTE]
> The live preview does not apply defaults yet: a document whose `Theme` comes
> from a default previews in the theme its own frontmatter names. The export
> itself is unaffected.
