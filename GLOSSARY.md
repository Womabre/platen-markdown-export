# Platen Markdown Export

Turns an author's Markdown document into a branded PDF or self-contained HTML file, and keeps the document's own revision history current as it does so.

## Language

### The document and its history

**Source document**:
The Markdown file an export reads. It belongs to its author; the exporter may only change it through a source write-back.
_Avoid_: input file, the .md

**Source write-back**:
The edits an export makes to the source document it exported: TOC link cleanup on any export, the date stamp when the Status earns one, and the release edits on a release. Never carries a value the document did not state itself.
_Avoid_: source mutation, bump (for the whole set)

**Revision**:
The document's current revision identifier, as the document states it about itself. Moves on only through a release.
_Avoid_: version, revision number (for a revision row's own number)

**Revision history**:
The document's ordered list of revision rows, oldest first. The last row describes the revision currently in work.
_Avoid_: changelog, revisions table (for the concept; the table is how the PDF shows it)

**Revision row**:
One entry in the revision history, recording a single revision: its own revision identifier, date, author and remarks. A row keeps its own identifier for good; a release never renumbers existing rows.
_Avoid_: revision (for the row), history entry, revision entry

**Status**:
Where the document says it stands, in the author's own words. Two values carry meaning: *work in progress* (the current revision is still being written) and *released* (also *vrijgegeven*: the author declares the current revision final). Any other value is the author's label and the exporter leaves the document's history alone.
_Avoid_: state, lifecycle

**Date stamp**:
Today's date written onto the last revision row of a document whose Status is work in progress or released, earned when an export's first output lands. A document with any other Status is not stamped.
_Avoid_: revision date update

**Release**:
The deliberate act of signing off the current revision of a document whose Status says it is released: the release note is recorded on the last revision row, a new revision row is appended, the document's revision moves on to it, and the Status returns to work in progress.
_Avoid_: bump, revision bump (for the whole act)
