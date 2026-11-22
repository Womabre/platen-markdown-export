# CLAUDE.md

A TypeScript CLI (`platen-markdown-export`, entry `dist/index.js` built from `src/index.ts`) that converts Markdown or HTML to a print-quality PDF via WeasyPrint, and optionally a self-contained HTML file. Branding lives in themes under `themes/`. `vscode-extension/` is the VS Code extension that drives the same CLI. Domain terms: `GLOSSARY.md`.

## Commands

```sh
npm run check              # every gate CI runs, in CI's order; run before pushing
npm test                   # builds first, then node scripts/run-tests.js
npm run verify:pdf         # real PDF export through WeasyPrint
node dist/index.js --mode pdf,html --no-bump "themes/default/sample default.md"
npm run build && node --test --test-name-pattern="includes" dist/tests/markdown.test.js
```

- The CLI and the tests run from `dist/`. Rebuild before either, and never edit `dist/` by hand. `npm test` runs every `*.test.js` it finds in `dist/tests`, so a stale or orphaned `dist/` file is cured by deleting `dist/` (or `dist/.tsbuildinfo`) and rebuilding.
- `npm test` never runs WeasyPrint, Chromium or the network; `verify:pdf` is the separate check that does.
- Without `--no-bump` an export writes to its source document (date stamp, release).
- A new version: `npm run version:set -- X.Y.Z`, a `## [X.Y.Z]` heading in `CHANGELOG.md`, `npm run build`, then `cd vscode-extension && npm run bundle`.
- The git remote is named `platen-markdown-export`, not `origin`. Pushing a `vX.Y.Z` tag publishes the release.
- Golden file: `UPDATE_GOLDEN=1 npm test`, then read the diff. Never regenerate to make a failure pass.
- After editing `FRONTMATTER_KEYS` (every key `extractFrontmatter` reads is declared there): `node dist/index.js --frontmatter-schema > schema/frontmatter.schema.json`.
- The extension's `npm test` lists its test files by path in `vscode-extension/package.json`. A new test file there runs only once it is added to that list.

## Where to read before you edit

Each doc holds the rules and the bugs behind them for its area. Read every doc in the matching row before the first edit there.

| Editing | Read |
|---|---|
| `weasyprint.ts`, `fetch.ts`, `stylesheets.ts`, `cache.ts`, `fsutil.ts`; anything that fetches, caches, serves files, launches WeasyPrint or writes a user's file | `CODING_STANDARDS.md` |
| `cli.ts`, `parseArgs`, a new flag | `CODING_STANDARDS.md` (the `parseArgs` rule), `docs/architecture/themes.md` § Theme search path |
| `index.ts`, `plan.ts`, `commands.ts`, `watch.ts`, `pdfinfo.ts`, `config.ts`, `errors.ts`; exit codes, the order of work in `main()`, `--watch` | `docs/architecture/pipeline.md`, `docs/architecture/themes.md` § Themes (style overrides must precede the CSS builders) |
| `frontmatter.ts`, `frontmatter-keys.ts`, `projectconfig.ts`, `source-writeback.ts`, `templates.ts`; a new frontmatter key, `frontmatterDefaults`, `--release`, `--release-note`, `--init`, `--inspect`, `--list-* --json`, `--check-setup` | `docs/architecture/frontmatter-and-source.md` |
| `theme.ts`, `css.ts`, `cover.ts`, anything under `themes/`; palettes, styles, cover slots, `--theme-path` | `docs/architecture/themes.md` (authoring a theme: `docs/THEMES.md`) |
| `preview-kit.ts`, `preview-css.ts`, `preview-plugin.ts`, `vscode-extension/src/preview.ts`; a preview rendering bug | `docs/architecture/preview-kit.md` |
| Anything else under `vscode-extension/src/` | `CODING_STANDARDS.md` (the `core.ts` rule) |
| `infographic*.ts`, `assets/fonts/`; checking rendered PDF output | `docs/architecture/infographics.md` |
| `bootstrap.ts`, `mermaid.ts`, `drawio.ts`; WeasyPrint, Chromium, draw.io or font installs | `docs/architecture/runtime-requirements.md` |
| `scripts/run-tests.js`, `test-fixtures/`, the golden test, `main.test.ts`, CI test jobs | `docs/architecture/testing.md` (the fixture stays free of diagrams, images and icon fonts) |
| Reviewing a diff | `CODING_STANDARDS.md` |

## Rules

- **Every write that can land on a file the user owns goes through `writeFileAtomic` (`fsutil.ts`), never `fs.writeFileSync`.**
- **A write follows a symlink, never replaces it**: resolve the destination with `resolveWriteTarget` first.
- **Never write an HTML attribute pattern by hand — use `attributes.ts`.**
- **A computed replacement always goes through `literal()` (`strings.ts`).**
- **A degraded fetch never reaches the disk cache.** Bump `CACHE_SCHEMA` (`cache.ts`) when a cached value changes shape.
- **`parseArgs` never calls `process.exit` and never writes to the console.** Throw `ExitError(message, code)`; the codes are listed in `--help` (`cli.ts`), 0 to 6. `VALUE_FLAGS` is the one list of value-taking options.
- Pipeline progress goes through `log()` / `logResult()` (`logger.ts`), never a bare `console.log`.
- **Nothing transient is written into the user's document directory.**
- **The WeasyPrint server is gated on a per-run capability token.** Build URLs with the returned `urlFor()`.
- **WeasyPrint only reaches the network through `startServer`.** It always launches with the env from `buildWeasyprintEnv`, and with `--allowed-protocols http,https,data` whenever the binary supports it: `file://` would embed any readable file in the PDF.
- **Renderers that fan out over document matches must be bounded**, via `mapPool`/`createLimiter` (`concurrency.ts`).
- **`index.ts` only runs `main()` under `require.main === module`**; tests drive `main({ argv })` in `--mode html`.
- **The VS Code extension's editor-free logic lives in `vscode-extension/src/core.ts`.** Add pure logic there, not to `extension.ts`.
- Source write-back writes only what the document itself says, matches keys case-insensitively, and compares against one baseline before each write.
- Theme CSS never restates a hex value from `theme.json`; cover colours are `var(--cover-title-color, <own value>)`.
- `--infographic-icons` is machine-level and must never become a frontmatter key.
- The README is the user-facing spec for frontmatter keys, markdown features, options and the revision workflow. Change it with the CLI surface.
