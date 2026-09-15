# Platen Markdown Export — VS Code extension

Self-contained VS Code wrapper around the [`platen-markdown-export`](../README.md)
CLI. **Install the `.vsix` and it just works** — no workspace build, no global npm
install, no VS Code tasks to configure. Saving a `.md` file exports it automatically.

## Zero-config by design

The packaged `.vsix` bundles the compiled CLI, all its production npm
dependencies, and every theme asset (see [Package a .vsix](#package-a-vsix) for
how). There's nothing to build in your workspace and nothing to point
`cliPath` at — it's only there as an override for CLI development.

Four dependencies genuinely can't ship inside a `.vsix` because they aren't npm
packages: **Node.js** itself (the CLI runs as an external process so it can own
native deps without crashing the extension host), **WeasyPrint** (a Python
package + native libs), **Chromium** (Playwright's browser download, needed for
Mermaid diagrams) and **draw.io** (the desktop app, needed for `.drawio`
diagrams). When the extension starts it checks for all four and, if anything is
missing, asks **one** question naming everything missing. **Install** installs
all of it in one go — Node.js first (winget on Windows, Homebrew on macOS), then
the rest through the CLI's `--setup` — under a single progress notification,
followed by one message saying how it went. **Not now** asks again the next time
VS Code starts; **Don't ask again** stays quiet until something *else* goes
missing. On Linux, Node.js needs administrator rights an extension cannot ask
for, so the result message offers the install command to copy instead.

## Features

- **Export on save** — saving any `.md`/`.markdown` file exports it automatically,
  using your configured mode / the document's `Mode` frontmatter. Turn off with
  `platenMarkdownExport.exportOnSave: false` if you'd rather export manually.
- **Preview in your theme** — VS Code's built-in Markdown preview shows an export
  document (frontmatter with `Mode`, `Theme` or `Style`) in its theme and style,
  from the export's own CSS. Nothing to set up; other Markdown files are left
  alone. For Markdown Preview Enhanced, run
  `Markdown Export: Theme Markdown Preview Enhanced in This Workspace` once. See
  *Live preview in your theme* in the main README for what a preview can and
  cannot show.
- **Context menu** on `.md`/`.html` files (editor right-click and Explorer right-click).
- **Commands** (Command Palette → "Markdown Export"):
  - `Markdown Export: Export` — uses your configured mode / the document's `Mode` frontmatter.
  - `Markdown Export: Export as PDF`
  - `Markdown Export: Export as HTML`
  - `Markdown Export: Export as PDF + HTML`
  - `Markdown Export: Export and cut a release` — the only thing that bumps the
    revision and resets `Status`. Nothing automatic does.
  - `Markdown Export: Install runtime dependencies` — installs whatever is missing (Node.js, WeasyPrint,
    Chromium, draw.io) straight away, without asking first.
  - `Markdown Export: Refresh Preview Themes` — rebuilds the preview stylesheets
    after you edit a theme's CSS (theme-folder changes rebuild them on their own).
  - `Markdown Export: Theme Markdown Preview Enhanced in This Workspace` — writes
    `.crossnote/parser.js`; refuses to replace one that has hooks of your own.
- Streams CLI output to the **Platen Markdown Export** output channel. A manual
  export shows a cancellable progress notification; a save-triggered one reports
  in the status bar instead, so pressing save does not pop a toast.
- Maps the CLI's exit codes to friendly messages (e.g. a missing WeasyPrint or
  Chromium offers a one-click "Install Dependencies").

## How it finds the CLI

The conversion happens in a separate CLI process (it owns the WeasyPrint /
Playwright / sharp dependencies). The extension resolves it in this order:

1. `platenMarkdownExport.cliPath` setting, if set (a `dist/index.js` path or an
   installed `platen-markdown-export` binary) — for pointing at a CLI you're
   actively developing.
2. `dist/index.js` in the workspace folder that owns the file — same reason.
3. **`bundled/dist/index.js` inside the installed extension** — the normal path
   for an end user; this is what makes the extension work with nothing else
   installed.
4. `dist/index.js` next to the extension (dev fallback: running the extension
   straight from a repo checkout without having run `npm run bundle` yet).
5. `platen-markdown-export` on `PATH`.

Steps 2–4 are *discovered* rather than named, so each one has to prove itself:
the candidate's own `package.json` (the `dist/` directory's sibling) must
identify it as `platen-markdown-export`, or it is skipped. `dist/index.js` is an
ordinary path for any JavaScript project, and without that check, opening
someone else's repository and saving a Markdown file with a `Mode:` key ran
*their* `dist/index.js`. Step 1 is exempt — it is a path you typed yourself.

## Settings

| Setting | Default | CLI flag | Scope |
| --- | --- | --- | --- |
| `platenMarkdownExport.cliPath` | `""` (auto) | — | user only |
| `platenMarkdownExport.nodePath` | `"node"` | — | user only |
| `platenMarkdownExport.theme` | `""` | `--theme` | workspace |
| `platenMarkdownExport.mode` | `""` | `--mode` | workspace |
| `platenMarkdownExport.stylesheet` | `""` | `--stylesheet` | workspace |
| `platenMarkdownExport.dpi` | `0` (CLI default) | `--dpi` | workspace |
| `platenMarkdownExport.infographicIcons` | `"iconify"` | `--infographic-icons` | user only |
| `platenMarkdownExport.openAfterExport` | `false` | `--open` | workspace |
| `platenMarkdownExport.noBump` | `false` | `--no-bump` | workspace |
| `platenMarkdownExport.quiet` | `false` | `--quiet` | workspace |
| `platenMarkdownExport.extraArgs` | `[]` | raw args | user only |
| `platenMarkdownExport.env` | `{}` | process env (e.g. Typekit URLs) | user only |
| `platenMarkdownExport.exportOnSave` | `true` | — | workspace |
| `platenMarkdownExport.preview.enabled` | `true` | — | workspace |


**"User only"** is VS Code's `machine` scope: the setting can be changed in your
own User Settings, and a repository cannot set it from `.vscode/settings.json`.
Those four decide *which program runs, with what arguments, in what
environment* — `env` alone reaches `NODE_OPTIONS` — so they are not something a
project you cloned gets to choose. The per-project knobs that only steer the
export (theme, mode, stylesheet, DPI) stay workspace-settable, which is what
committing them to a repository is for.

`infographicIcons` is user-only for a different reason: it decides where your
documents' text may be sent. `iconify` sends only icon names such as
`mdi/home`; `weavefox` sends the icon names and search terms your documents use
to Ant Group's WeaveFox service at `www.weavefox.cn`, and **data may go to
servers in China**; `none` sends nothing. Switching to `weavefox`
shows that warning, with a one-click way back. The default passes no flag at
all, so `EXPORT_INFOGRAPHIC_ICONS` still applies.

The extension also declares that it does not run in
[restricted-mode](https://code.visualstudio.com/docs/editor/workspace-trust)
workspaces: exporting spawns a process against files the repository controls, so
it stays off until you trust the folder.

## Exporting vs releasing

Cutting a release — appending a `Revisions` row, bumping every `Revision` field,
resetting `Status` — is its own command: **Markdown Export: Export and cut a
release**. No other path does it, so nothing that happens on save, or in CI, or
when a colleague re-exports your document to read it, can rewrite its revision
history. The revision *date* is still stamped by every export, so the output
stays current either way.

## Where an export reports itself

A manual export shows a progress notification you can cancel, and a toast when it
finishes. A **save-triggered** one reports in the status bar instead — visible if
you look, silent if you don't — because with `exportOnSave` on by default, a
toast per ⌘S is how a useful feature turns into one people switch off. Failures
interrupt either way.

Cancelling really cancels: the CLI is spawned as its own process group, so
stopping it also stops the WeasyPrint run and any headless Chromium it started.
Those are killed too if you close the window mid-export.

## Develop

```sh
cd vscode-extension
npm install
npm run compile      # or: npm run watch
```

Press **F5** ("Run Extension") to launch an Extension Development Host. Build the
CLI first (`npm run build` in the repo root) so `dist/index.js` exists — while
developing, `resolveCli()` finds that sibling `dist/` before ever looking at
`bundled/`, so you don't need to re-bundle on every change.

## Package a .vsix

```sh
npm run package      # build CLI's dist/ first (see below), then: compile, bundle, vsce package
```

`npm run package` runs `scripts/bundle.js`, which stages everything the CLI
needs into `vscode-extension/bundled/` (gitignored, regenerated every run):

- `bundled/dist/` + `bundled/package.json` — the compiled CLI (from the repo
  root's `dist/`; run `npm run build` there first if it's missing or stale).
- `bundled/themes/` — theme assets, with the generated `sample*.{md,html,pdf}`
  fixtures stripped (dev-only, and the sample `.html` files alone run ~20MB each
  with fonts/images inlined).
- `bundled/node_modules/` — a fresh **production-only** install (`npm ci
  --omit=dev`) for whatever the build machine is, PLUS `sharp`'s native binary
  for macOS (x64 + arm64), Linux (x64 + arm64), and Windows (x64) force-fetched
  via `npm install --os= --cpu= --force` into isolated throwaway directories.
  `sharp` picks the matching folder for the real runtime at require-time; the
  others just sit there unused (see `node_modules/sharp/lib/sharp.js`). Widen
  `ALL_SHARP_TARGETS` in the script if you need architectures beyond that
  (e.g. Windows arm64, musl/Alpine Linux).

Two passes then remove what cannot be loaded. `KEEP_ONLY` cuts packages the CLI
reads as *files* down to the files it reads — `mermaid` is 84MB of sources for
one 3.4MB browser bundle. That orphans their dependency trees, so a second pass
deletes every package unreachable from the CLI's own production dependencies:
110 packages, ~42MB of `@mermaid-js/parser`, `cytoscape`, `es-toolkit` and
friends that nothing could ever `require()`. The bundle then proves itself by
exporting `test-fixtures/pipeline/document.md` with the bundled CLI before it is
packaged, so a prune that went too far fails the build rather than someone's
install.

### Platform-specific builds

`npm run package` produces one universal `.vsix` carrying every platform, which
is convenient locally and wasteful to ship: `sharp`'s binary is ~18MB per
platform, so four fifths of an 80MB download is unusable on any given machine.
Pass a target to build just one:

```sh
npm run bundle -- --target win32-x64     # darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | win32-x64
npx vsce package --no-dependencies --target win32-x64 --out platen-markdown-export-win32-x64.vsix
```

That is what `release.yml` does, once per platform — 80.5MB → 35.3MB per user.
VS Code resolves the matching target itself, so nobody has to choose. The
narrowing runs *after* the smoke test on purpose: the bundled CLI is exercised on
the build machine, which needs its own platform's binary still present.

Install the built package with **Extensions → … → Install from VSIX**, or:

```sh
code --install-extension platen-markdown-export-darwin-arm64.vsix
```
