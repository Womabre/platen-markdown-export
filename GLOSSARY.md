# Platen Markdown Export

Turns an author's Markdown document into a branded PDF or self-contained HTML file, and keeps the document's own revision history current as it does so.

## Language

### The document and its history

**Source document**:
The Markdown file an export reads. It belongs to its author; the exporter may only change it through a source write-back.
_Avoid_: input file, the .md

**Source write-back**:
The edits an export makes to the source document it exported: the date stamp and TOC link cleanup on any export, and the release edits on a release. Never carries a value the document did not state itself.
_Avoid_: source mutation, bump (for the whole set)

**Date stamp**:
Today's date written onto the last entry of the document's revision history, earned when an export's first output lands.
_Avoid_: revision date update

**Release**:
The deliberate act of signing off the current revision of a document whose Status says it is released: the release note is recorded on that revision, a new revision opens, and the Status returns to work in progress.
_Avoid_: bump, revision bump (for the whole act)
