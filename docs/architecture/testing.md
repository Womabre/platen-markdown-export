# Testing

What the test commands do and do not exercise, and why they are spelled the way they are. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

## What `npm test` covers

Tests are plain `node --test` with no framework. They compile from `src/tests/*.test.ts` to `dist/tests/`, so rebuild before running or the run tests stale output.

`npm test` never runs WeasyPrint, Chromium or the network. `npm run verify:pdf` is the separate check that exports a real PDF from `test-fixtures/pipeline/document.md`, the same network-free fixture the HTML golden test uses. Locally it renders the default theme and skips when WeasyPrint is missing. CI runs the same script as its own job with `--all-themes --require`: every theme, and never skipped.

## Why `scripts/run-tests.js` exists

It hands `node --test` an explicit list of files, built from every `*.test.js` in `dist/tests`. That is the one spelling every supported Node version and shell accepts:

- `node --test dist/tests/*.test.js` relies on the shell expanding the glob, which `cmd.exe` does not.
- `node --test dist/tests` works on Node 20 and 26 but fails on 22 with MODULE_NOT_FOUND.

It also keeps the coverage flags out of shell quoting, and points `XDG_CONFIG_HOME` at an empty folder so the developer's own user config cannot change template and theme listings on Linux and macOS. On Windows the user config is found through `APPDATA`, which the script leaves alone because WeasyPrint discovery reads it too.

Running a single file by path (`node --test dist/tests/markdown.test.js`) is unaffected.

## The pipeline fixture and the golden file

`src/tests/pipeline.test.ts` is the end-to-end suite. It runs the real three-stage sequence over `test-fixtures/pipeline/document.md`, asserts structural invariants, and diffs a normalised golden file, `expected-html-export.html`, in which `<style>` bodies and `data:` URIs are collapsed to byte counts so the diff stays reviewable.

- Regenerate with `UPDATE_GOLDEN=1 npm test` and read the diff. Never regenerate to make a failure go away.
- **The fixture has no Mermaid, draw.io, images or icon fonts, on purpose.** Adding any of them would make the suite need Chromium, the draw.io app or the network, and make CI fetch a font on a cold runner. `verify:pdf` uses the same fixture.

## Whole exports in-process

`main({ argv })` takes its arguments and does not read `process.argv`, and `index.ts` runs `main()` only under `require.main === module`. `src/tests/main.test.ts` therefore drives whole exports in-process, all in `--mode html`: output naming, the deferred source stamp, the release bump and the `ExitError` exit codes.

## The extension's tests

`vscode-extension/package.json` lists its test files by explicit path, with no glob, for the same `cmd.exe` reason. A new unit test file runs only once it is added to that list. CI runs them beside the compile and lint, and also runs the extension-host suite (`npm run test:integration`, `vscode-extension/src/tests/integration/`).
