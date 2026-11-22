# Frontmatter, templates and the source document

Which keys the exporter reads, where defaults come from, how a document is scaffolded, and the only code that writes back to it. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## Frontmatter keys (`frontmatter-keys.ts`)

`FRONTMATTER_KEYS` is the one list of every key the exporter reads, each with a description and a JSON Schema fragment. Two things are built from it: `unknownKeyWarnings`, called once from `extractFrontmatter`, and `--frontmatter-schema`, committed as `schema/frontmatter.schema.json`.

- **Adding a key to `extractFrontmatter` means adding it to the table.** `frontmatter-keys.test.ts` scans `extractFrontmatter`'s `at('…')` calls and fails on an undeclared one, because an undeclared key would be reported as a typo in every document that uses it.
- **Regenerate the schema after editing the table**: `node dist/index.js --frontmatter-schema > schema/frontmatter.schema.json`. `src/tests/frontmatter-keys.test.ts` compares the committed file with the generator.
- **The warning is a near-miss detector, not an allowlist.** Documents carry other tools' keys (`tags`, `marp`, `draft`), so only a key that folds to one of ours (case, spaces, `_`/`-`) or sits within a small transposition-aware edit distance is reported. Short keys get a tighter limit, because two edits turn `tag` into `Lang`.
- `Document Info` and `Variables` are never checked: their keys are the author's own.

## Frontmatter defaults (`projectconfig.ts`, `frontmatter.ts`)

`frontmatterDefaults` in config files (`discoveredFrontmatterDefaults`), nearest file winning per key, case-insensitively, with `Variables` merged per name. `withDefaults` applies them to the parsed attributes inside `extractFrontmatter` only.

- **A default never reaches the document.** The source write-back parses the document's own frontmatter and does not take `extractFrontmatter`'s result, so no stamp, release or TOC cleanup can write a default into the file.
- `unknownKeyWarnings` runs on the document's own keys; defaults are checked where they are read.
- `NOT_DEFAULTABLE` keeps out the revision machinery, `Title`, `Mode` and `Export On Save`. The extension decides export-on-save from the document's text, so a default `Mode` would export from the CLI and never on save.
- Known gap: the live preview (`preview-plugin.ts`) selects its stylesheet from the document text and does not see defaults.

## Question-answering surfaces

Tooling has to know things about a document before acting on it, and must not grow its own YAML reader or theme resolver to find out.

- `--inspect` (`describeDocument` in `index.ts`) prints the **resolved** frontmatter as JSON and stops. It reads the document, renders nothing, writes nothing and returns before the theme is loaded. Resolved means `Mode: pdf, html` is normalised, `resolveRevision`'s precedence is applied, and `isReleasedStatus` is used, so `Vrijgegeven` counts. The extension uses it to ask whether the revision it is about to release already carries a note, and prompts only when it does not.
- `--list-themes --json` and `--list-styles --json` do the same for the theme catalogue.
- `--check-setup --json` (`setup-status.ts`) reports the runtime dependencies; the extension builds its one install question from it. It is its own flag and not `--setup --dry-run`: the extension asks it of whatever CLI it resolves, which may be an older one. An older CLI ignores `--dry-run` next to `--setup` and would install everything, while an unknown flag is refused and reads as "cannot tell".

## Source write-back (`source-writeback.ts`)

The only code that writes to the source document. `openSourceDocument(file, { writes, release, note })` reads the file once and returns a handle:

- `content`: what the export renders, already stamped.
- `outputLanded()`: the first output earns the date stamp and TOC cleanup.
- `allOutputsLanded()`: the release, so every output carries the pre-release revision.
- `written`: what the handle wrote, for `--watch`.

Three rules live here and nowhere else:

- **Only what the document says.** The module re-parses the document's own frontmatter and takes no `FrontmatterData`, because that one has `frontmatterDefaults` applied. A default Author must never reach a new Revisions row.
- **Keys match the way the reader matches them**: case-insensitively, keeping the document's own spelling. `STATUS: Released` is released and reset like `Status: Released` (`src/tests/frontmatter-casing.test.ts`).
- **One baseline.** The handle remembers what it last read or wrote. Every write is a compare-and-swap against it, skipped with a warning when another process changed the file.

A release rewrites the `Revision` and `Status` scalars only at the top level and under `Document Info`. `Revision` and `Status` keys inside revision-history rows, and `Variables` entries, are left alone. The history itself changes only by the appended row and the release note on the last row. A release that cannot happen (Status not released, no Revisions rows) is reported when the handle opens, before the render.

Test it through the handle on temp files (`src/tests/source-writeback.test.ts`), never through its private helpers.

## Release notes

`--release-note <text>` sets the `Remarks` of the **outgoing** revision: the current last `Revisions` row, which describes the work being signed off and is the row the cover's revision table shows.

- `setLastRevisionRemarks` runs before `appendRevisionEntry`. In the other order the note would land on the fresh row `--release` appends for the next revision.
- It is a usage error without `--release`: a note with nothing to attach to would vanish while the export looked successful.
- Both frontmatter shapes are handled and the document's own key casing is kept.

## Scaffolding

`frontmatterTemplate(today, answers?)` is the one implementation of answers to frontmatter. The CLI reaches it through `--init [--answers <file.json>]`, and the extension's new-document wizard through that same flag.

- Answered values go through `yamlScalar`, which quotes only when YAML requires it. The default `--init` output stays byte-identical, since people read it as documentation, while a title with a colon, an author with a comma inside a flow mapping, or a status of `No` are protected.
- Answers arrive in a **file**, never on the command line: a title and an author are free text, and argv quoting differs on three platforms.
- **The extension keeps its own copy of the placeholder template** (`vscode-extension/src/core.ts`) on purpose: `insertFrontmatter` edits an unsaved editor buffer and must work when the CLI cannot be resolved. A key-comparison test in `frontmatter.test.ts` keeps the two in step. The wizard, which creates a real file, goes through the CLI.

## Templates (`templates.ts`, `templates/`)

A template is a folder with `template.md` and an optional `template.json` description.

- **Roots, in order**: `--template-path`, `EXPORT_TEMPLATE_PATH`, `templatePaths` in config files (walked up from the working directory, since no document exists yet), the `templates/` folder of every discoverable theme (`themeTemplateRoots`), then the built-in `templates/`. An external template shadows a built-in of the same name; a shadowed theme contributes none.
- **`applyThemeRoots` must run before any template lookup**, as it does in `parseArgs`.
- `scripts/run-tests.js` points `XDG_CONFIG_HOME` at an empty folder, because the developer's own user config adds roots and changes every listing.
- **`renderTemplate` never writes YAML of its own.** It starts from `frontmatterTemplate(today, answers)` and merges the template's top-level blocks in as text (`splitBlocks`), so quoting stays `yamlScalar`'s job and the template's comments survive.
- Merge rules: `Title` and `Revisions` are always the scaffold's; `Document Info` only gains the template's extra labels; an answered key beats the template's block; unknown keys are appended. `ANSWER_KEYS` maps answer fields to keys: extend it when `FrontmatterAnswers` grows.
- Only `{{Title}}`, `{{Author}}` and `{{Date}}` are filled in the body. Every other `{{Name}}` must survive for `Variables`.
- `templates/` ships in the npm package (`files`) and is copied by `vscode-extension/scripts/bundle.js`. `src/tests/templates.test.ts` exports each built-in template with `--strict`, so a template that warns fails the build.
- The extension renders by the template's file path (`--template <file>`), not its name.
