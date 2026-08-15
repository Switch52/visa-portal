# Sheet mappings

One file per agency sheet, describing what its columns mean.

**Config, not code.** The two sheets we have already differ from each other, and every new
agency brings another shape — so onboarding one is a file here, not an edit to the importer.
These are committed: they describe structure, never content. The sheets themselves live in
`private/`, which is gitignored.

Not to be confused with `migrations/`, which is schema changes to the database.

| File | Sheet | Rows |
|---|---|---|
| `mando.json` | `mando-client-details.csv` | 210 (201 usable, 9 junk) |
| `karam.json` | `karam-client-details.csv` | 153 |

## What a mapping says

- **`columns`** — the sheet's heading for each field the portal stores. A field with no
  heading here is simply absent from that sheet.
- **`ignoredColumns`** — headings that exist and are deliberately read past. Karam's address
  columns are the reason this exists: they are not needed, not wanted, and not modelled.
- **`appendToNotesColumns`** — headings whose contents are appended to the notes rather than
  dropped. Karam's unnamed trailing column holds `OK GO NOW` on three rows, and those are
  the admin's own working markers.
- **`dateFormat`** — `DD/MM/YYYY` for both sheets, applied strictly. Never a permissive
  parser: `05/06/2028` is 5 June, and a parser that guesses puts someone at the embassy on
  the wrong day.
- **`defaultApplicationType`** — what a row with no note is taken to be.

## What the importer does with the notes column

The notes column in these sheets is doing four jobs at once, because the sheet had nowhere
else to put things. The importer extracts what it understands into real fields and keeps
everything else verbatim:

| In the sheet | Becomes |
|---|---|
| `SINGEL`, `SENGEL`, `SNGEL` | `applicationType: single` |
| `CANCEL` | status `cancelled` |
| `SINGEL AFTER 27/8`, `SINGEL AFETER 15\9` | status `on_hold` with `holdUntil` set |
| `مهم جدا يتحجز` | `priority: urgent` |
| anything else | stays in `notes`, exactly as written |

Every transformed row appears in the dry-run report so the interpretation can be checked
before anything is committed.
