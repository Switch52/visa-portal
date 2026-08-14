# Build Prompt — Agency Passport & Booking Portal

> Paste into a fresh Claude Code session started inside `~/Code/visa-portal`, or say:
> "Read BUILD_PROMPT.md and start milestone 1."
> Items marked **[CONFIRM]** are assumptions I made — ask me about them before building that part.

---

## Role and context

You are building a production web portal for a visa services business. I am the admin and sole
operator. My **clients are travel agencies**, not individual travelers. Each agency sends me
passports; I get appointments booked for those passports; the agencies owe me money for each one that
gets booked.

Right now all of this runs on Google Sheets: one sheet per agency where they type in passport details
and notes, plus a separate payments sheet tracking what each agency owes, what they've paid, and a
daily log of incoming payments. It works until it doesn't — duplicate passports get submitted, the
same passport gets booked twice, and reconciling payments is manual.

The portal replaces those sheets. There are exactly two kinds of user:

- **Admin (me)** — sees everything across every agency, runs the handoff and booking imports, records
  all payments, and controls who has access.
- **Agency** — sees only their own passports, their own booking statuses, and their own balance.

Judge every decision against: *does this stop a duplicate, a double-booking, or a payment dispute
before it happens?*

### What this system is, and is not

We already run a **main booking dashboard** — a separate company system where appointments are
actually booked. **It stays. This portal feeds it and never replaces it.** Data moves between them by
file: I export a batch of passports out of this portal into that one, and booking files come back the
other way.

So the boundary is:

- **This portal owns** — agency access, passport intake, validation, duplicate prevention, the handoff
  queue, booking *status* tracking, charges, payments, and balances.
- **The main dashboard owns** — the actual booking.

Do not build a booking engine, an appointment scheduler, or any integration that tries to talk to
that system directly. **Nothing in this portal may set a passport to `booked` except importing a real
booking file.** That single rule is what keeps the two systems from disagreeing, and it holds no
matter how convenient a manual override would look.

## Stack

- **Next.js** (App Router, TypeScript), Tailwind CSS, shadcn/ui.
- **MongoDB Atlas** free tier (M0). Data is text-only, so storage is not the constraint.
- **Auth:** email OTP, invite-only. Auth.js (NextAuth v5) with a custom OTP flow, or a hand-rolled
  equivalent if that's cleaner — justify the choice.
- **Email:** Resend (OTP codes and notifications).
- **Deploy:** Vercel.
- **No payment processing.** Payments happen outside this system; the portal only records them.

Get the data layer right before making anything look good. Screens should be clean, consistent and
usable, but I'll direct the visual design in a later pass — don't spend effort on polish while the
schema is still moving.

Two MongoDB specifics that must be handled from day one, not retrofitted:

1. **Connection pooling.** Serverless functions will exhaust M0's connection limit without a cached
   global client. Use the standard cached-promise pattern in a single `lib/mongodb.ts`.
2. **There is no row-level security.** Unlike Postgres, Mongo will happily return another agency's
   data if a query forgets its filter. So: **every read and write goes through one data-access layer
   that takes the acting user as an argument and applies the agency scope itself.** No route handler
   or server component may call the driver directly. Write tests that prove Agency A cannot read
   Agency B's passports, bookings, notes, or payments — I want to see those pass.

## Access control

- Login is **email OTP only**. No passwords.
- **Invite-only, and I am the only one who can invite.** I add a person by name + email from the
  admin side, assigned to an agency. Only then does that email exist in the system.
- If someone enters an email that isn't on my list, **no code is sent and no account is created.**
  On screen, always show the same neutral message ("If that email is registered, we've sent a code")
  so the login page can't be used to discover who my clients are.
- OTP rules: 6 digits, 10-minute expiry, single-use, max 5 attempts before invalidation, rate-limited
  per email and per IP, stored hashed, compared in constant time.
- I can deactivate a user instantly; their active sessions die with them.
- **I can view the portal exactly as any agency sees it** ("view as"), with a persistent banner
  showing whose view I'm in and a one-click exit. **View-as is read-only** — it's for seeing what
  they see, not for acting as them. Entering and leaving a view-as session is written to the audit
  log.

### Agencies never learn about each other

A hard rule that applies everywhere in the product, not just to duplicate errors: **no agency ever
sees another agency's name, identity, or any detail that could identify them.** No names in error
messages, no counts that imply who else is in the system, no shared lists, no leaked IDs in URLs or
API responses. Agency-side responses carry only that agency's own data. When reviewing any screen or
endpoint you build, check it against this rule explicitly.

## Data model

Design the collections yourself, but cover at least:

**agencies** — name, contact info, active status, **default currency** (pre-fills the payments form),
internal notes. No price field: pricing lives on routes. No balance field: balances are derived from
charges and payments, never stored.

**users** — name, email, role (`admin` | `agency`), agency reference, active flag, last login.

**routes** — the service path a passport is being processed for, and the unit that carries pricing.
A route is defined by three things together:

- **origin country** — the country the applicant is applying from,
- **destination country** — the country they're applying to visit,
- **appointment center** — the specific center where the appointment is booked.

Plus a **fee** and an active flag. The same origin→destination pair handled at two different centers
is two distinct routes and may be priced differently, so the uniqueness key is all three fields
together. Give each route a readable display label derived from those parts (e.g.
*"Lebanon → France · VFS Beirut"*) so I never have to read three columns to know what I'm looking at.

Today there is one route with one set fee, but I will add more and each will carry its own fee.
Build this as a real collection from the start — never a hardcoded constant.

**Each fee carries its own currency, which I choose.** When I create or edit a route I pick both the
amount and the currency from a configurable list — different routes may well be priced in different
currencies. An amount never exists in the system without a currency attached to it.

**Only I can create or edit routes and fees.** This is admin-only at every level: the screens, the
API endpoints, and the data-access layer. An agency must not be able to reach a route-editing
endpoint even by crafting the request directly — enforce it server-side, not by hiding a button.
Agencies see a route's name and never its price.

**passports** — the core record. The field list is **dictated by what the main dashboard's importer
requires** (see `samples/main-dashboard-import-template.csv`), because every passport eventually has
to leave this system in that exact shape:

| Field | Notes |
|---|---|
| `firstName` | Stored **separately** from the surname — never as one combined name field |
| `lastName` | |
| `passportNumber` | Plus a normalized form stored alongside for matching |
| `passportExpiryDate` | Date-only |
| `dateOfBirth` | Date-only |
| `nationality` | **ISO 3166-1 alpha-3** code (`USA`, `GBR`) — validate against a real country list, don't accept free text |
| `gender` | Enum. The main dashboard expects the literal strings `Male` / `Female` |
| `contactNumber` | Optional |
| `contactNumberDialCode` | Optional. Digits only, no `+` — the template shows `1` and `44` |
| `contactEmail` | Optional |

**No address fields.** Karam's sheet carries address columns; they are not needed, not wanted, and
must not be modelled, stored, or imported. Ignore those columns entirely.

Plus our own fields, which never go in the export:

- the submitting **agency** and the **route**
- **submission date**
- **`applicationType`** (`single` today; my sheets record this as the misspelled `SINGEL`)
- **`priority`** — urgency, currently smuggled into notes as *"مهم جدا يتحجز"*. Sorts the handoff queue.
- **`holdUntil`** — a date. The "don't start before X" case, currently written into notes as
  "AFTER 27/8". When set, the passport stays `on_hold` and should surface automatically once the date
  passes, instead of me remembering.
- **`notes`** — free text, Arabic or English, for things that are genuinely notes
- **`status`**

**Store names split from the start.** It is impossible to reliably split "Mohammed Al Sayed Ahmed"
into first and last at export time, and guessing wrong puts the wrong name on a visa application. The
agency types them into two fields, exactly as printed in the passport's machine-readable zone.

Status flow (confirmed — build exactly this):

| Status | Meaning |
|---|---|
| `submitted` | The agency has entered it. Sitting in my intake queue. |
| `on_hold` | The agency asked me to wait before starting on this one. |
| `ready` | Cleared to be taken in — details check out, nothing blocking it. |
| `added` | It has been put into our main booking dashboard, the company system where booking actually happens. |
| `booked` | An appointment is confirmed for it. Set by importing a booking file. |
| `completed` | Finished and closed. |

Plus `cancelled` and `rejected`, reachable from any active state.

**`added` is the important one and it is not the same as `booked`.** Today I track this by hand: my
agencies fill their sheet, I move each passport into our main dashboard, and I write "yes" in a
column beside it so I know it's been transferred. Booking happens afterwards, over in that system.
The new portal must carry that distinction — a passport that has been handed off but not yet
confirmed is a real, meaningful state, and it's where things currently get lost.

Every status change is recorded with timestamp and actor — a passport carries its full history, not
just a current value. Define the flow and its allowed transitions in one configuration module so
states can be added later without touching every screen.

**bookings** — the appointment secured for a passport: appointment date/time, location/center,
reference or confirmation number, which import batch it came from, who recorded it.

**import_batches** — one row per bulk booking file I upload, so any import can be traced and undone.

**payments** — agency, amount, currency, date received, method, reference, note, recorded by.

**charges** — what an agency owes and why. One charge per booked passport, priced from that
passport's route. The charge **stores the fee amount it was created with**, copied from the route at
the moment of booking — it must not change retroactively when I later edit a route's price. This is
the difference between a ledger you can trust and one that quietly rewrites history. Balance is
*derived* from charges minus payments; never store a balance that can drift out of sync.

(If I later need a different price for a specific agency on a specific route, that slots in as an
override consulted at charge time. Don't build it now — just don't design it out.)

**audit_log** — append-only. Every status change, booking, import, payment, invite, deactivation, and
deletion, with actor, timestamp, and before/after values.

## The duplicate passport rule — the single most important feature

A passport number may exist **once in the entire system, across all agencies.**

- When anyone submits a passport number that already exists, the submission is **blocked, not
  warned.** It does not save.
- The error must state the reason plainly, and say when it was first registered and its current
  status.
- **Disclosure policy (decided):** I see the full detail, including which agency submitted it first.
  The agency sees *"This passport is already registered in the system (submitted 12 Mar 2026,
  status: booked). Contact us if you believe this is an error."* — **never the other agency's name,
  and nothing that hints at their identity.** The blocked-duplicate response sent to an agency must
  contain no reference to any other agency whatsoever, including in the underlying API payload.
- Enforce this with a **unique index in MongoDB**, not just an application check. Two simultaneous
  submissions must not both succeed.
- Match on a **normalized** passport number: uppercase, whitespace and dashes stripped. Store the
  normalized form for matching and the original as typed for display.
- **[CONFIRM]:** passport numbers are only guaranteed unique *within* an issuing country, so the
  strictly correct key is `nationality + normalized number`. My default is to key on the number alone
  and flag any cross-nationality collision for me to review manually, since a real collision is rarer
  than a genuine double-submission.

Apply the same rule to bulk entry: validate the whole batch, reject the offending rows individually,
and let the clean rows through.

## Data entry — must be as fast as a spreadsheet

My agencies are leaving Google Sheets. If entry is slower than a sheet, they won't use it.

- A **grid entry view**: multiple rows on screen, keyboard-navigable (Tab/Enter/arrows), add-row on
  Enter at the last field.
- **Paste directly from Excel or Google Sheets** — a multi-row, multi-column paste fills the grid.
  This is a hard requirement, not a nice-to-have.
- **Route is chosen once for the batch**, not retyped per row — an agency submitting 30 passports is
  almost always sending them all for the same route. Allow a per-row override for the exception.
- Validate live per row: passport number format, expiry date in the future, DOB plausible, required
  fields present, duplicate check. Show errors inline, per cell, without losing what was typed.
- On save, report exactly what happened: *"14 saved, 2 blocked — passport X already registered,
  passport Y has an expired date."*
- Nothing saves silently and nothing is lost on a failed submit.

## The handoff queue — getting passports into the main dashboard

This is the most repetitive thing I do all week, and it's where records currently go missing. Today
it's manual: I read an agency's sheet, retype or copy the details into our main booking dashboard,
then write "yes" in the column beside that row so I know it's been transferred. If I'm interrupted
halfway, rows get transferred twice or not at all.

Build the portal side of this properly:

- A **queue of everything `ready` but not yet `added`**, across all agencies, grouped by route —
  because I work through them a route at a time.
- **CSV export is the primary way data leaves this portal.** I select a batch, download a CSV, and
  enter it into the main dashboard from that file. Copy-to-clipboard as a secondary option for small
  batches.
- After transferring a batch, **one action marks all of them `added`** — selected rows, one click,
  not one at a time. Offer this directly after an export ("mark these 40 as added?"), but keep it a
  separate deliberate step, because exporting is not the same as having actually entered them.
  Re-exporting the same batch is always safe and changes no statuses.
- A passport already `added` can't be added again, and shows when it happened and who did it.
- The queue must make it obvious what's been sitting there too long.

**The main dashboard stays permanently.** This portal feeds it and never replaces it. The handoff
queue is therefore a core feature I'll use every week for years, not a temporary bridge — build it
with that in mind and make it genuinely fast.

### CSV export — get the details right

The export file is the bridge between the two systems, so it has to survive the trip through Excel
intact. These are not fussy details; each one is a real way the file arrives corrupted:

- **The exact format is in `samples/main-dashboard-import-template.csv`.** The header line is:

  ```
  firstName,lastName,passportNumber,passportExpiryDate,dateOfBirth,nationality,gender,contactNumber (optional),contactNumberDialCode (optional),contactEmail (optional)
  ```

  **Reproduce that header byte for byte, including the literal `" (optional)"` suffixes** — spaces
  and parentheses included. They look like documentation and they are not: they are the column names
  that importer matches on. Do not tidy them, do not camel-case them, do not strip them.
- Values follow the template exactly: dates as `YYYY-MM-DD`, nationality as ISO alpha-3, gender as the
  literal `Male` / `Female`, dial codes as bare digits with no `+`.
- Even so, keep the mapping in an **editable export template** rather than hardcoded in the export
  function, so when that system changes its format I fix it in a settings screen instead of waiting
  on a code change. Ship it pre-filled with the format above.
- Optional columns are still **always present** in the file, just empty when we have no value. A
  missing column shifts everything after it.
- **Passport numbers must survive Excel.** Excel eats leading zeros and turns long digit strings into
  scientific notation, which would silently corrupt passport numbers — the one field that must never
  change. Quote them and format them so they stay text.
- **UTF-8 with a BOM**, so names with Arabic or accented characters open correctly rather than as
  mojibake.
- **Dates as `YYYY-MM-DD`**, per the template — unambiguous, and never locale-formatted. The
  difference between `03/04` and `04/03` is a booking on the wrong day, so nothing locale-dependent
  goes anywhere near this file.
- Proper RFC-4180 quoting and escaping, so a comma or quote in a name can't shift every column after
  it by one.
- **Filenames that mean something**: date, route, and record count, e.g.
  `handoff_2026-08-14_LB-FR-VFS-Beirut_40.csv`. I will have a folder of these and I need to tell them
  apart six months from now.
- Every export writes to the audit log: who, when, which passports, how many.

Offer the same export from any admin list view, honouring whatever filters are currently applied —
what I see on screen is what lands in the file.

## Bulk booking import — the reconciliation feature

This is the part that currently goes wrong most, so build it defensively.

1. I upload a booking file. **I will point you at real examples of these files before you build this
   milestone — ask me for them and write the parser against the actual format, not a guess.** Expect
   the real thing to be messier than a clean CSV: merged cells, header junk, inconsistent column
   names between files, passport numbers with stray spaces. Parse defensively and tell me clearly
   when a file doesn't look like what you expect, rather than silently importing garbage.
2. The system matches each row to an existing passport by normalized passport number.
3. **Before anything is written**, show a preview: how many matched, which passports will be marked
   booked, which rows matched nothing, and — critically — **which passports are already booked**,
   because those are the accidental double-bookings I'm trying to prevent.
4. Already-booked passports are excluded from the import by default and listed separately with their
   existing booking details.
5. I confirm; only then does it commit, as one batch.
6. The batch is **reversible** — one click undoes an entire import if I loaded the wrong file.
7. Re-uploading the same file must be safe and change nothing (idempotent).

Once a passport is `booked`, the system must actively prevent it being booked again by any path —
a second import, a manual edit, or a direct API call.

## Payments and balances

**This is a tracking ledger, not a payment system.** Money changes hands outside the portal entirely.
No payment processor, no card details, no bank details, no "pay now" button anywhere — not on the
admin side and not on the agency side. The portal's only job is to record what was charged, record
what came in, and show the difference. If you find yourself reaching for Stripe or any payment SDK,
you have misread this section.

Mirror what my payments sheet does today, but reconciled automatically:

### Currency

Amounts are always a pair: an integer in minor units **and** a currency code. There is no such thing
as a bare number in this system.

- I pick the currency when I set a route's fee and when I record a payment, from a list I can manage.
- Each agency has a default currency so the daily payments form pre-fills correctly, but I can
  override it on any individual payment.
- **Balances are tracked per currency and never summed across them.** If an agency owes 400 USD and
  250 EUR, that is two balances shown side by side — not one invented total. The system must never
  apply an exchange rate it wasn't given.
- **A payment settles charges in its own currency only. Confirmed — no exceptions.** I never take a
  payment in a currency other than the one that was charged. Reject any attempt to apply a payment
  against a charge in a different currency, with a clear error. Every payment on record today is USD.

**One exception, and it is display only — confirmed.** My payments sheet shows every amount twice: in
USD, and
converted to EGP at a rate I maintain by hand (currently 51.08 EGP per USD, marked "rate last
updated 2026-07-27"). Keep that:

- A single **admin-editable exchange rate** with a visible "last updated" date, shown next to any
  converted figure.
- EGP figures are **indicative and clearly labelled as such** — computed for reading, never stored on
  a charge or payment, never used to settle anything, and never the basis of a balance.
- The stored truth is always the original currency and amount. If the rate changes, only the display
  changes; no ledger entry moves.

### Ledgers

- **Per-agency ledger**: total charged, total paid, outstanding balance, with the full line-by-line
  history behind it.
- **Daily payments entry**: a fast form for logging payments as they come in — agency, amount, date,
  method, reference, note. This is a page I use every single day, so it should open to a cursor in
  the first field.
- **Agency side**: their balance, what it's made of, their payment history. Read-only — agencies
  never record their own payments.
- **Admin overview**: every agency's balance on one screen, sorted by who owes most, with a total.
- Support partial payments and credits. Never let a payment be recorded twice by a double-click.
- Charges are generated when a passport is booked, priced from that passport's route, so what an
  agency owes always ties back to a specific passport, a specific booking, and a specific fee. No
  unexplained numbers.
- If an import is undone, its charges are reversed with it. A rolled-back booking must not leave
  money owed.

## Dashboards

**Admin home** — how many passports are waiting in the handoff queue, how many are `added` but not yet
confirmed booked, new submissions today/this week, blocked duplicates needing my review, passports on
hold, outstanding balances per currency, recent activity feed.

**Admin — passports** — every passport across every agency, with fast filters by agency, status,
nationality, submission date, and a search that finds a passport number instantly. Bulk status
changes.

**Admin — agencies** — one row per agency: passports submitted, booked, on hold, balance owed. Click
through to that agency's full detail.

**Admin — routes** — add and edit routes and their fees. Editing a fee affects future charges only;
show me that explicitly in the UI so I'm never surprised by what a price change does.

**Agency home** — my passports by status, how many are booked, what I still owe, and anything the
admin needs from me.

**Agency — passports** — their own list with status and notes, plus the grid entry view to add more.
They can edit a passport's details and notes **only while it is not yet booked** — after booking, it's
locked and they must contact me.

## Data integrity — this must not get tangled

I've watched spreadsheets drift out of sync for years. The whole point of moving off them is that the
data stays trustworthy without me policing it. Treat the following as requirements, not advice.

**One way in.** Every read and write goes through the scoped data-access layer described above. No
route handler, server component, or script touches the driver directly. One place to audit, one place
to fix.

**Validate at two levels.** Zod schemas at every API boundary, *and* MongoDB `$jsonSchema` validators
on the collections themselves. The second one matters because it's the only thing standing between a
malformed record and the database when the write comes from a migration script, a bulk import, or me
poking at the Atlas console at midnight.

**Enforce invariants with indexes, not intentions.** Unique indexes on: normalized passport number;
the route triple (origin + destination + center); user email. A passport must not be able to hold two
active bookings. If a rule matters, it belongs in the database — application checks lose races.

**Multi-document writes are transactions.** Booking a passport writes a booking, changes a status,
creates a charge, and appends to the audit log. Those four either all happen or none do. Atlas
replica sets support transactions on the free tier, so use them. A half-committed booking — charged
but not booked, or booked with no charge — is exactly the tangle I'm trying to escape.

**Store facts, derive the rest.** Balances are computed from charges and payments, never stored.
Counts and totals are computed, never cached. If a number can be derived, deriving it is not a
performance problem at my scale — but a stale cached total that disagrees with its own ledger is a
support nightmare.

**Money as integers.** Store amounts in minor units (cents/piastres) as integers with an explicit
currency. Never floats — `0.1 + 0.2` problems in a payments ledger destroy trust in the whole system.
Format for display only at the edge.

**Dates stored as dates.** Real `Date` objects in UTC, never strings, never locale-formatted text.
Passport expiry and date of birth are *date-only* values — store them so a timezone shift can never
move someone's birthday by a day. Booking appointment times are real timestamps and need the center's
timezone recorded alongside.

**Normalize on write.** Passport numbers, emails, and country codes get normalized once at write time
and the normalized form is stored explicitly beside the original. Never normalize on read — that's
how two records that should have collided quietly coexist.

**No orphans.** Every reference points at something that exists. Deletion is soft by default. Nothing
that has a charge, booking, or audit entry against it can be hard-deleted without an explicit,
irreversible admin confirmation that explains what else will go with it.

**Idempotency everywhere it counts.** Bulk imports, payment recording, and OTP verification must all
survive a double-click, a retry, or a re-uploaded file without duplicating anything.

**Schema changes are numbered migration scripts**, committed to the repo and runnable forward. Never
ad-hoc edits in the Atlas console. When the shape of the data changes, that change has a name, a
date, and a file.

**Test the invariants specifically.** Not just "does the app work" — prove that cross-agency reads
fail, that a duplicate passport cannot be inserted concurrently, that a failed booking rolls back its
charge, and that an undone import leaves no money owed. These tests are the reason I'll trust the
system.

## Security

This system holds passport numbers, names, and dates of birth for real people. Treat it as sensitive
personal data:

- Never log passport numbers, names, or DOBs — not in server logs, not in error reports.
- No third-party analytics on authenticated pages.
- Enable encryption at rest on the Atlas cluster; restrict network access by IP allowlist.
- Secrets in `.env.local`, `.env.example` committed, real keys never committed.
- Export of passport data is admin-only and written to the audit log every time.
- Deletion is soft by default and recorded; hard deletion is admin-only and irreversible with an
  explicit confirmation.

## Migrating my existing data

Everything I have today lives in Google Sheets and **none of it may be lost**. This is not a
nice-to-have at the end — it's a deliverable with its own acceptance test.

Two sources to bring across:

1. **The per-agency passport sheets** — one sheet per agency, containing the passport details their
   staff typed in plus the notes beside them.
2. **The payments sheet** — what each agency owes, what they've paid, what's left, and the tab where
   I log new payments as they come in each day.

### The "added" column

In my current sheets, every person has a **yes/no marker beside them that I maintain by hand**. It
records whether that passport has been moved into our main booking dashboard — the company system
where booking actually happens. The client sheets are intake only. I have marked every row, and that
column is real state built up over time, so it must be **imported, not discarded**.

The mapping is therefore:

- **`Yes`** → status `added`
- **`No`** → status `submitted`
- **blank** → status `submitted`. Confirmed: blank means not added yet. 51 of Mando's 201 rows are
  blank — a real backlog, not missing data. Treat `No` and blank identically on import, but keep the
  original cell value in the imported record's source data so the distinction survives.

Note what the sheets **cannot** tell you: whether a passport was subsequently booked. That column only
records the handoff. So the migration must never set anything to `booked` — booked status arrives
later, from importing the real booking files.

### Two decisions that shape the whole migration

**1. Live work comes first; history is a separate, lower-risk job.**

Split the data in two:

- **Live** — passports still in play: not yet booked, or booked but not yet completed. This data has
  to be perfect, because I'll be working from it the next morning.
- **History** — passports already finished and closed. Useful to keep, but nothing breaks if it lands
  a week later or arrives slightly messy.

Migrate live data first and cut over on it. Import history afterwards as a separate archive pass. Do
not let a thousand old completed rows delay or endanger the cutover.

**2. Balances migrate as an opening balance, not as reconstructed history.**

In the new system a charge is created when a passport is booked. My old sheets can't reliably tell
you which historical passport produced which charge, at what fee, so **do not try to reconstruct the
past ledger** — you'd be inventing data and every invented number is a future argument with a client.

Instead: for each agency, for each currency, create **one dated `opening_balance` ledger entry** on
the cutover date, carrying the balance my payments sheet says is outstanding. It's a first-class
ledger entry type, visible and labelled as such, with the source sheet archived as its evidence.
Everything after cutover is generated normally from real bookings. The ledger then reads honestly:
*"this is where we stood on 14 Aug 2026, and here is every movement since."*

### The migration runbook

Follow these phases in order. Each ends with something I look at and approve.

**Phase 0 — Freeze and archive.** Pick a cutover date. Export every sheet as-is and keep the raw files
in `private/` — a **gitignored** folder that is never committed. These exports contain real passport
numbers, names, and dates of birth for real people; they must not enter git history, where they would
be permanent and would spread to every clone of the repo. `samples/` is for scrubbed examples only.
Before touching anything, write down the numbers I believe are true today: row counts per agency, and
outstanding balance per agency per currency. Everything later gets checked against this list.

**Phase 1 — Profile before building.** Write a read-only profiling script that reports, per sheet:
columns present, row count, blank rate per column, every distinct value found for gender and
nationality, every date format encountered, whether names are in one field or two, and duplicate
passport numbers both within and across sheets. **Do not write the importer until I've read this
report.** It tells us what cleaning is actually needed instead of what we assume.

**Phase 2 — Map fields per sheet.** Agencies' sheets will differ from each other. Write the column
mapping as an editable config file per sheet, not as code. Define transformations explicitly: how
names split, nationality → ISO alpha-3, gender → `Male`/`Female`, and date parsing with the exact
formats found in Phase 1 — never a permissive "parse anything" date library, which is how a
day/month swap gets in silently.

**Phase 3 — Dry run into a scratch database.** Never into the real one. Output per-agency counts,
every rejected row with its reason, the cross-agency duplicate list, and any value that didn't map.
Repeat until the only things left are genuine data problems needing my judgement.

**Phase 4 — I resolve the exceptions.** Hand me the duplicate list and the rejected rows. My
corrections go in a **separate corrections file, never by editing the original sheets** — the
originals stay untouched so provenance survives. Then re-run Phase 3.

**Phase 5 — Commit, then reconcile.** Run the real import as one reversible batch. Produce the
reconciliation report: counts per agency and balances per currency, side by side with my Phase 0
numbers, differences highlighted. **I sign off on this report before anyone logs in.**

**Phase 6 — Pilot with one agency.** Invite a single agency I trust, on real data, for about a week.
They enter new passports, I run a real handoff export and a real booking import. Their sheet stays
open as a safety net. Fix what that week exposes.

**Phase 7 — Cutover.** Invite the rest, set every sheet to read-only on the same day, and keep the
sheets archived and readable for at least a year.

**On historical duplicates:** my old sheets almost certainly contain passport numbers that appear
under more than one agency — that's part of why I'm building this. If Phase 1 shows only a handful, I
resolve them by hand and the unique index stays absolute. If it shows hundreds, tell me before
choosing a workaround, and don't quietly relax the rule to make the import pass.

### What my real data actually looks like

Profiled on 14 Aug 2026 from `private/` — Mando's client sheet (210 rows) and the payments workbook.
Build against these facts, not against a tidy imagined version.

**The two agency sheets have different columns from each other.** This is not a detail — it means the
importer needs a **per-sheet column mapping**, and every new agency I onboard may bring another shape.

| | Mando (210 rows) | Karam (153 rows) |
|---|---|---|
| Index column | `A` | `#` |
| Core fields | identical | identical |
| Address fields | none | `Address Line 1`, `Address Line 2`, `City`, `State / Province`, `Postal Code` |
| Trailing column | none | one unnamed column holding `OK GO NOW` on 3 rows |
| Junk rows | 9 | 0 |

**The address columns are dropped.** They aren't needed for anything, they don't appear in the main
dashboard template, and carrying identity data we have no use for is only a liability. The importer
reads past them without storing them.

**Common columns** (`First Name, Last Name, Nationality, Passport Number, Passport Expiry Date,
Date of Birth, Gender, Added?, Notes`):

- **Names are already split** into first and last. Good — no name-splitting problem.
- **Dates are `DD/MM/YYYY`**, not ISO. Confirmed unambiguously: 129 expiry dates and 107 birth dates
  have a day greater than 12. Parse strictly as `DD/MM/YYYY` and convert to `YYYY-MM-DD` on export.
  **Never** hand these to a permissive date parser, which would read `05/06/2028` as 5 June or 6 May
  depending on its mood and put someone at the embassy on the wrong day.
- **Nationality is a full English country name** — `Egypt` (201), `Philippines`, `Libya`, `Russia`,
  `Turkey`, `Uzbekistan`. The main dashboard needs ISO alpha-3, so a name → code mapping table is
  required, and any unmapped value must stop the import rather than guess.
- **Gender is already `Male`/`Female`**, matching the export format exactly.
- **Passport numbers vary in shape**: mostly `A` + 8 digits (Egyptian), but also `A9999999A`,
  `AA999999`, `AA9999999`, and one all-numeric. **Do not enforce a rigid format** — validate loosely
  (length and character set), because a real passport that doesn't match a made-up pattern must never
  be rejected.
- **9 junk rows** carry no passport number but do hold stray values in `Gender`, `Nationality` or
  `Added?` — leftovers from editing. Skip any row without a passport number, and report them rather
  than silently dropping them.
- **No duplicates within either sheet, and no expired passports** in either.
- **Two passport numbers appear in BOTH sheets** — same person, same passport, submitted by two
  different agencies, and **both marked `Added? = Yes`**, meaning each was pushed into the main
  dashboard twice. This is the exact failure the duplicate rule exists to stop, already sitting in my
  live data. Only two, so I'll resolve them by hand at migration: I decide which agency owns each, and
  the loser is recorded as a rejected duplicate rather than deleted. The unique index stays absolute.
- **Notes are Arabic free text.** UTF-8 throughout, and the UI must display Arabic correctly with
  proper RTL handling in note fields.

**The `Notes` column is doing four different jobs, and this is the most important finding here.**
Because the sheet has nowhere else to put things, notes have become a dumping ground for structured
data. Across both sheets, the values are:

| What's written | What it actually means | Where it belongs |
|---|---|---|
| `SINGEL` ×140, plus `SENGEL`, `SNGEL` | Single-entry application type — misspelled, three ways | An `applicationType` field |
| `CANCEL` ×4 | The application was cancelled | Status `cancelled` |
| `SINGEL AFTER 27/8`, `SINGEL AFETER 15\9`, `SINGEL AFTER 22/8` | Don't start this one until a given date — the "needs time" case | Status `on_hold` + a **`holdUntil` date** |
| `مهم جدا يتحجز` ×5 | *Very important, must be booked* — urgency | A `priority` field |
| `SINGEL GO NEW YES`, `OK GO NOW` | My own working markers. Meaningful to me, not to the system | Kept verbatim in `notes` |

So the schema needs **`applicationType`, `holdUntil`, and `priority` as real fields**, and `notes`
goes back to being free text for things that genuinely are notes.

During migration, parse these out rather than importing them as opaque strings — but **report every
row you transformed** so I can check the interpretation. Match the misspellings case-insensitively
(`SINGEL`/`SENGEL`/`SNGEL` → `single`) and handle both `27/8` and `15\9` date separators, since both
appear.

**Never discard note text you don't recognise.** Anything that isn't one of the patterns above is one
of my own working markers — `OK GO NOW` and the like — and it stays in `notes` **exactly as written**,
including the unnamed trailing column in Karam's sheet, whose contents get appended to that row's
notes. The rule is: extract what we understand into real fields, keep everything else verbatim, lose
nothing. When in doubt, preserve.

**This also refines the `Added?` mapping.** All 5 of Karam's `No` rows have a reason sitting in the
notes: one `CANCEL` and four "after <date>" holds. So `No` does not simply mean "not added yet" — read
the note before assigning a status:

- note says `CANCEL` → status `cancelled`
- note says "after <date>" → status `on_hold`, with `holdUntil` set to that date
- otherwise → status `submitted`

**The payments workbook** has two tabs, both messy in ways that will break a naive parser:

- **`Client Tracker`** — a title block, an explanatory paragraph, a **header spanning three lines with
  embedded newlines inside header cells**, five agency rows (`tamer`, `karam`, `omar`, `mando`,
  `wael`), ~25 blank spacer rows, then a `TOTALS` row at the bottom. Locate the header row and the
  data block by content, never by fixed row number, and **never import the `TOTALS` row as an agency**.
- **`Payments Log`** — one row per payment, and **the `Date` column is sparse**: a date appears only
  when it changes, and blank means *same date as the row above* — **confirmed**. This is the single
  most dangerous thing in the file. **Forward-fill dates on import**; a naive parser gives 19 of 25
  payments a null date and the ledger becomes untraceable.
- **Amounts carry formatting**: thousands separators, `$` prefixes, ` EGP` suffixes, values quoted
  because of the commas. Strip all of it and parse to integer minor units.
- Status values seen: `PARTIAL`, `PAID`.

**Five agencies exist today**: tamer, karam, omar, mando, wael. Every payment on record is in **USD**.

### Importer requirements

- **Dry run first, always.** It reports what *would* happen — how many records per agency, totals per
  currency, which rows are unparseable, which are duplicates — and writes nothing. I run this, read
  it, and only then commit.
- **The sheets stay the source of truth until I've verified the import.** Don't delete or edit
  anything in Google Sheets. Archive copies of the exported files in the repo.
- **Expect my existing data to violate the new rules.** There are almost certainly duplicate passport
  numbers already sitting across different agencies' sheets — that's one of the problems I'm building
  this to solve. The importer must **collect and report every one of them for my decision**, not
  block the whole import and not silently pick a winner. Same for missing fields, impossible dates,
  and rows I half-filled.
- **Traceability.** Every imported record stores where it came from: source file, sheet name, and
  original row number, plus the raw original row. If a number looks wrong in six months, I can trace
  it back to the exact cell it came from.
- **Reversible and idempotent.** An import can be undone completely, and re-running the same file
  changes nothing.
- **A reconciliation report at the end**: record counts per agency and payment totals per currency,
  set against the totals in my sheets, so I can confirm with my own eyes that nothing went missing.
  This report is how I sign off on the migration.

## Milestones

Stop at the end of each and show me a running app before continuing.

0. **Profile my real data first.** Migration phases 0 and 1 need no application code and should run
   *before* the schema is designed. What my sheets actually contain — how names are stored, which
   date formats appear, how many duplicates already exist — should inform the schema rather than
   collide with it later. Ask me for the sheet exports and run the profiler.
1. **Foundation** — schema, Mongo connection layer, the scoped data-access layer, email OTP auth,
   invite-only user management, and the isolation tests passing.
2. **Passports** — grid entry with paste-from-spreadsheet, validation, the duplicate rule enforced by
   unique index, status flow, notes, admin and agency list views.
3. **Routes & the handoff queue** — route management with per-route fees and currencies (admin-only),
   the `ready`-but-not-`added` queue, the CSV export with its editable column template, and bulk
   mark-as-added.
4. **Bulk booking import** — parse, preview, already-booked detection, commit, undo. Charges are
   generated here, at the passport's route fee, inside the same transaction as the booking.
5. **Payments & ledgers** — daily payments entry, per-agency ledgers, per-currency balances, admin
   overview.
6. **Dashboards, audit log, view-as, notifications.**
7. **Migration + deploy** — run phases 2 through 7 of the migration runbook above: field mapping, dry
   run into a scratch database, exception resolution, committed import with a reconciliation report I
   sign off on, a one-agency pilot week, then full cutover. Deploy before the pilot, not after.

## How to work

- Repo at `~/Code/visa-portal`, git, private GitHub repo via `gh`.
- Real sample files live in `samples/` — read everything in there and its `README.md` before
  designing the passport fields or writing any parser. If `samples/` is still empty, ask me for the
  files rather than inventing a format.
- Ask me any remaining **[CONFIRM]** question in one batch before milestone 1. Don't drip-feed them.
- Build the status flow and validation rules as editable configuration, not hardcoded in components.
- I have more features in mind for later, so keep the data-access layer and status logic in one place
  where they can be extended without touching every screen.

## Definition of done

An agency logs in with an emailed code, pastes 30 rows of passport details straight from their
spreadsheet, and two are blocked on the spot as already registered elsewhere with a clear reason. I
upload the day's booking file, see that three of them are already booked before I commit anything,
import the rest, and their charges appear on that agency's balance automatically. The agency logs in
and sees exactly which of their passports are booked and what they owe — without messaging me once.
