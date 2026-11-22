# Testing

What the test commands do and do not exercise, and why they are spelled the way they are. Reached from [`CLAUDE.md`](../../CLAUDE.md). Domain terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

`npm test` never runs WeasyPrint, Chromium or the network — that is deliberate, and it is why `verify:pdf` exists as a separate check (CI runs it as its own job, on `test-fixtures/pipeline/document.md`, the same network-free fixture the HTML golden test uses).

Tests compile from `src/tests/*.test.ts` to `dist/tests/`; always rebuild before running or you'll test stale output.

`npm test` goes through `scripts/run-tests.js`, which hands `node --test` an
explicit list of files. That is not ceremony: `node --test dist/tests/*.test.js`
relies on the shell expanding the glob, which `cmd.exe` does not, and
`node --test dist/tests` works on Node 20 and 26 but fails on 22 with
MODULE_NOT_FOUND. An explicit file list is the one spelling every supported
version accepts, and it keeps the coverage flags out of shell quoting. Running a
single file by path (above) is unaffected.
