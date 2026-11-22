# Runtime requirements (not npm-managed)

The external programs an export needs and how `bootstrap.ts` finds or installs them. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## WeasyPrint

The PDF engine, an external binary. `findWeasyprint` (`bootstrap.ts`) looks at known install paths, not on PATH. PDF modes fail with exit code 4 when it is missing.

- **Windows install is pinned and checksummed.** `installWeasyprintWindows` downloads WeasyPrint's standalone `weasyprint-windows.zip` release asset (a PyInstaller build with Pango, Cairo, GDK-Pixbuf and GObject bundled, so no Python or GTK runtime is needed) from a pinned version, and `verifyChecksum` checks its SHA-256 before extraction (`WEASYPRINT_WINDOWS_ASSET`). Never fetch the `/releases/latest/download/` alias: its bytes cannot be verified before they are extracted and run.
- It falls back to `installWeasyprintWindowsViaPip` (Python, pip and a separately installed GTK runtime) only when that download fails.
- `runBootstrap` smoke-tests the resolved binary with `weasyprint --version` (`verifyWeasyprintRuns`), so a broken native-library load surfaces at `--setup` and not in the middle of an export.

## Playwright Chromium

Only for rendering Mermaid diagrams, headless.

- `playwright` is an **optionalDependency**, and `mermaid.ts` loads it lazily with `await import`. An install without it is a supported state.
- `isModuleNotFound` tells a missing **package** from a missing **browser**, because the two need different commands to fix.
- `--omit=optional` is not a way to opt out. It is not package-scoped, and sharp ships its platform binaries as optional dependencies, so it breaks image handling.

## draw.io desktop app

Only for rendering `.drawio` diagram references. `findDrawioCli` (`drawio.ts`) looks at known install paths and PATH. `ensureDrawio` (`bootstrap.ts`) installs it through winget, Homebrew cask or snap, alongside WeasyPrint and Chromium.

## Web fonts

Optional and currently unused: every shipped theme has an empty `fonts[]` and relies on system font stacks or a style-level `fontImport`.

The capability is `resolveFonts` in `theme.ts`. A `fonts[]` entry carries either a literal `url`, fetched and base64-embedded into the PDF, or an `env` naming an environment variable that holds the URL, for a font behind a licensed link that must not be committed. Adding a font to a theme therefore needs a manifest entry and an `@font-face` in the theme's CSS for the HTML export, and no code change.
