# Sample files

**Scrubbed examples only — this folder is committed to git.** Real exports containing actual passport
numbers, names, or dates of birth go in `private/` instead, which is gitignored. Anything committed
here is permanent and travels to every clone of the repo.

Drop structural examples here. The build session reads this folder before designing the passport fields or
writing any parser, so what lands here decides the schema — it is not decoration.

**Scrub the personal details before saving**: change passport numbers, names, and dates of birth to
made-up values. Keep everything else exactly as it really is — column names, column order, header
rows, blank rows, merged cells, stray spaces, date formats, sheet names, and any junk at the top of
the file. **The mess is the useful part.** A cleaned-up file produces a parser that breaks on the
first real one.

## Already here

| File | What it is |
|---|---|
| `main-dashboard-import-template.csv` | The import format our **main booking dashboard** accepts. The handoff CSV export must match this exactly — including the literal `" (optional)"` in three of the headers. |

## Still to add

| File | What it is | Why it's needed |
|---|---|---|
| `booking-file-*.xlsx` / `.csv` | A real booking file, as it arrives | The bulk-import parser is written against these |
| `booking-file-*-variant.xlsx` | A second one from a different day or source, if the format varies at all | Reveals which columns are stable and which aren't |
| `passport-sheet-*.xlsx` | An export of one agency's current passport Google Sheet | Defines the real passport fields, and drives the migration importer |
| `payments-sheet.xlsx` | An export of the payments sheet, incl. the daily incoming-payments tab | Drives the ledger model and its migration |

Two of anything beats one. A single file can't show which parts of the format are guaranteed and
which just happened to be true that day.

## Notes on the format

Write anything here that the files themselves don't make obvious — which column means what, which
ones are ignored, which are filled in by hand later, what a blank cell means, or how you'd *prefer*
the data to look if you were designing it fresh.
