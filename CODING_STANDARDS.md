# Coding standards

Read at review, against the diff, and before editing the modules named in [`CLAUDE.md`](CLAUDE.md)'s table. Each rule states what to do, why, and what guards it. Most reasons are a bug that shipped.

## Platform

- Strict TypeScript, Node >= 20.9 (`engines.node`, which follows sharp's floor; CI exercises 20 and 22).
- Output is CommonJS: `tsconfig` uses `nodenext`, which emits CJS because `package.json` has no `"type": "module"`.
- Source is `src/`, compiled to `dist/`. Never edit `dist/` by hand.
- The README is the user-facing spec for frontmatter keys, markdown features, options and the revision workflow. Change it together with the CLI surface or frontmatter handling.

## Writing files

**Every write that can land on a file the user owns goes through `writeFileAtomic` (`fsutil.ts`), never `fs.writeFileSync`.**

- Covers the source write-back (`source-writeback.ts`: date stamp, TOC cleanup, release) and the HTML export output. Only the transient WeasyPrint temp file writes directly.
- Why: `writeFileSync` truncates before it writes, so an interrupted export would leave the user's own document empty, and the VS Code extension runs the export on every save.

**A write follows a symlink, never replaces it.**

- `writeFileAtomic` and `exportPdf` resolve the destination with `resolveWriteTarget` first.
- Why: `rename` onto a link swaps the link for a regular file and leaves the real document untouched. Test: `src/tests/concurrency.test.ts`.

**Nothing transient is written into the user's document directory.**

- The processed HTML goes to `startServer`'s `files` option and is served from memory. Only `--mode debug` writes a copy, on purpose.
- Result: an export that dies mid-run leaves no litter, and there is no cleanup path to skip.

## Strings and HTML

**Never write an HTML attribute pattern by hand; use `attributes.ts`.** `attrOf`, `setAttr`, `attrValues`, `findTags` and `tagWithAttrValue` are the only sanctioned way to read or rewrite an attribute. They carry two rules:

- **All three quoting spellings.** `html: true` is on, so a document may hand-write `src='x'` or `src=x`. A pattern that knows only the double-quoted form markdown emits silently does nothing to the others.
- **A leading `\s`, so an attribute name is matched whole.** Without it `src=` also matches the tail of `data-src=`. `<img data-src="lazy.png">` was read as an image reference (a spurious "Image not found", exit 6 under `--strict`), and on a tag carrying both, the inlined data URI was written into `data-src` while the real `src` kept pointing at a local file the exported HTML could not reach.

`src/tests/attributes.test.ts` guards both rules.

**A computed replacement always goes through `literal()` (`strings.ts`).**

- Why: `String.replace` / `replaceAll` treat a string replacement as a template, so `$&`, `` $` ``, `$'` and `$1` expand against the match. A cover title of `Q1 $& Q2`, an `<img alt="a$&b">`, a third-party stylesheet or a Mermaid diagram echoed into an error block would silently corrupt the output.
- `literal(value)` returns a function replacement, whose return value is inserted verbatim.
- `src/tests/strings.test.ts` locks this down for both template loaders.

## Fetching and caching

**A degraded fetch never reaches the disk cache.**

- `inlineCssRecursive` and `inlineFontsInCss` return `{ css, complete }`. `buildIconStylesheet` writes a cache entry only when `complete`.
- Why: every failure path in those functions removes what it could not fetch and returns normally, which reads as success to a caller that looks only at the string. The cache is permanent, has no expiry and is trusted on the next read. A degraded entry would turn one network blip into a wrong export forever: later runs log `(disk cache)`, make no request and raise no warning, so `--strict` cannot see it.
- Test: `src/tests/stylesheets.test.ts`.
- Entries are stamped with `CACHE_SCHEMA` (`cache.ts`). Bump it when the **shape** of a cached value changes; stale-schema entries are swept on the next write.

## The CLI

**`parseArgs` never calls `process.exit` and never writes to the console.**

- Every exit path throws `ExitError`, including `--help`, `--version` and `--list-*`, which use exit code 0. `main().catch` is the single place that terminates the process; it sends code 0 to stdout and everything else to stderr.
- Flags that print and stop are resolved in a pre-pass over the whole argv (`handleImmediateFlags`), so `--theme x --list-styles` and `--list-styles --theme x` agree.
- **The pre-pass and the main loop both split argv through the one `tokenize`.** It pairs each value-taking flag with the token after it and folds `--flag=value` into the same shape, so `VALUE_FLAGS` is the single list of which options take a value. Separate parsing in the two places once disagreed: `--output -h doc.md` printed the help text. Tests: `src/tests/cli.test.ts`.
- A value on a boolean flag (`--quiet=true`) is a usage error, never a silent accept.
- Mode strings are parsed once by the exported `parseModes`. The CLI rejects unknown values; `main()` warns, since there they came from frontmatter.

**`index.ts` only runs `main()` under `require.main === module`.**

- So `main`, `renderDiagramsAndImages`, `buildHtmlPipeline` and `buildHtmlExportPipeline` can be imported by a test.
- `main({ argv })` takes its arguments and does not read `process.argv`. The watch loop uses the same path to re-run with the flags it started with.
- What the tests built on this cover, and the fixture rules: [`docs/architecture/testing.md`](docs/architecture/testing.md).

## WeasyPrint and the local server

**The WeasyPrint server is gated on a per-run capability token.**

- `startServer` serves the user's own document directory, so knowing the port must not be enough to read it. Every request must be `/<token>/<path>` or it gets a 403 before any filesystem access.
- The token is a path prefix and not a header, so relative asset references inherit it with no rewriting. Use the returned `urlFor()`; never build the URL by hand. Tests for the token and the proxy env: `src/tests/weasyprint.test.ts`.

**WeasyPrint only reaches the network through `startServer`.** WeasyPrint is a second fetcher: anything the pipeline left un-inlined (a refused `<img>`, a `url()` in a `<style>` block, an `@import`) it requests itself. It has no fetch hook, but it honours the proxy variables and then sends every request, loopback included, to the proxy.

- `exportPdf` is given `proxyUrl`, and `buildWeasyprintEnv` strips every `*_proxy` / `NO_PROXY` spelling before setting ours. A surviving `NO_PROXY` is a list of hosts that skip the guard. Never launch WeasyPrint against a document without that env.
- The server answers absolute-form requests for its own exact origin from the token-gated directory, relays other `http://` through `fetchRemote`, and tunnels `CONNECT` only after `assertPublicHostname` and `guardedLookup`.
- **The proxy guards the network only.** WeasyPrint reads `file://` straight off the disk and embeds it: `<link rel="attachment" href="file:///…">` would put any readable file into the PDF. So `runExport` passes `--allowed-protocols http,https,data` (`WEASYPRINT_ALLOWED_PROTOCOLS`) whenever `allowedProtocolsSupported` finds the flag in the binary's `--help`, and `disallowedProtocolUrls` turns each refusal into a WARNING for `--strict`.
- **Request handlers in `startServer` run inside `answer()`.** A path a document chose (`%00`) can make `fs` throw synchronously.
- **`isPrivateAddress` judges IPv6 on parsed groups, not text.** `new URL()` rewrites `[::ffff:127.0.0.1]` to hex, which a dotted-only pattern lets through.

## Concurrency

**Renderers that fan out over document matches must be bounded**, via `mapPool` / `createLimiter` (`concurrency.ts`) at `CONFIG.concurrency` (default 4, `EXPORT_PDF_CONCURRENCY`). Tests: `src/tests/concurrency.test.ts`.

- Why: an unbounded `Promise.all` over matches opens one Chromium page, spawns one draw.io Electron process, or decodes one full-resolution image per match, all at once.
- draw.io gates at the CLI spawn and not at the caller, capped at 2: each invocation is a whole Electron instance, and one SVG-mode diagram already needs two (light and dark).

## The VS Code extension

**The extension's editor-free logic lives in `vscode-extension/src/core.ts`.**

- Why: `extension.ts` imports `vscode` at its top, so nothing in it can be loaded by a `node --test` process. Frontmatter reading (what makes a save trigger an export), the CLI identity check, `quoteArg` and `EXIT_MESSAGES` are plain string and filesystem work and belong in `core.ts`. `extension.ts` keeps only what touches the editor. Add pure logic to `core.ts`.
- **Wizards** (new document, fill in frontmatter) live in `wizard.ts`. It reaches the rest of the extension through a `WizardHost` built in `extension.ts` and does not import back into it. `preview.ts` does the same with `PreviewHost`.
- **Completion and hover** follow the same split. `frontmatter-schema.ts` has no `vscode` import, decides what to offer, and is tested in `vscode-extension/src/tests/frontmatter-schema.test.ts` against the committed `schema/frontmatter.schema.json`. `completion.ts` adapts it to the provider API behind a `CompletionHost`.
- **The key list is never copied into the extension.** It is fetched from the resolved CLI's `--frontmatter-schema` and cached per CLI. The cache is cleared when `cliPath`, `nodePath`, `env` or `themePaths` change.
- Aliases carry `x-aliasOf` in the schema, so they are hidden from suggestions but still described on hover.
- **Verify provider changes in a real extension host**: `@vscode/test-electron` against the installed VS Code, with an isolated `--user-data-dir` and `--extensions-dir`. Keep the user-data-dir path short: macOS rejects an IPC socket path over 103 characters.
- **Tests** are listed by explicit path in `vscode-extension/package.json` (no glob, since `cmd.exe` does not expand one). A new unit test file must be added to that list. CI runs them beside the compile and lint, plus the extension-host suite (`npm run test:integration`).
