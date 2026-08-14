# Agency Passport & Booking Portal

Passport intake, duplicate prevention, handoff to the main booking dashboard, and a
per-currency ledger — replacing the per-agency Google Sheets.

The full specification is in [`BUILD_PROMPT.md`](./BUILD_PROMPT.md). **This portal feeds the
main booking dashboard and never replaces it.** Nothing here may set a passport to `booked`
except importing a real booking file.

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in MONGODB_URI and AUTH_SECRET
npm run migrate                # create collections, validators and indexes
npm run create-admin -- --email you@example.com --name "Your Name"
npm run dev
```

Sign in at `/login`. With `RESEND_API_KEY` unset, the sign-in code is printed to the server
console instead of being emailed, so a local run needs no third-party service.

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | The Next.js app |
| `npm test` | Every invariant, across nine suites (220) |
| `npm run smoke` | Boots the built app against a throwaway database and checks the real HTTP surface |
| `npm run typecheck` / `lint` | TypeScript, ESLint |
| `npm run migrate` | Apply migrations (`-- --status`, `-- --down <id>`) |
| `npm run create-admin` | Bootstrap the first administrator |
| `npm run profile` | Re-run the migration data profiler over `private/` |

## How it is put together

```
src/config/      Editable configuration: status flow and transitions, currencies,
                 countries, validation rules. Screens read the flow from here.
src/lib/grid/    Columns, the spreadsheet paste parser, and row validation shared by
                 the browser and the server.
src/lib/export/  The handoff CSV: the column template, RFC-4180 rendering, filenames.
src/lib/import/  Reading booking files: the editable column mapping, and a parser that
                 refuses a file it cannot read rather than importing part of it.
src/lib/notifications/  Emails, each switchable, sent only after the work commits.
src/lib/mongodb  The only module that opens a connection (cached for serverless).
src/lib/db/      Typed collection handles. Unscoped, and off limits to the app.
src/lib/dal/     The data-access layer. Every function takes the acting user.
src/lib/auth/    OTP, sessions, rate limiting. Owns its own collections.
src/app/         Screens and server actions. Reaches data only through the DAL.
migrations/      Numbered, committed, runnable forward.
scripts/         Profiler, admin bootstrap, smoke test.
tests/           The invariants, proven against a real MongoDB.
```

### One way in

MongoDB has no row-level security: a query that forgets its filter returns another
agency's data. So the scope is not left to call sites — `scopedFilter(actor, filter)`
adds the agency condition itself, and every agency-scoped read and write goes through it.
A caller passing someone else's `agencyId` gets an impossible filter, not a wider one.

The boundary is enforced by ESLint, not by convention: nothing outside `src/lib/db`,
`src/lib/dal` and `src/lib/auth` may import the Mongo client or a collection handle.

### Why auth is hand-rolled rather than Auth.js

Auth.js v5 was the starting assumption; three requirements pushed against it, and each one
is load-bearing here:

1. **Deactivation must kill live sessions instantly.** Auth.js defaults to a
   self-contained JWT, which keeps working until it expires because nothing checks it. Its
   database-session mode fixes that, but at that point the session table is ours anyway.
2. **Its email provider is built for magic links, not 6-digit codes** with a 10-minute
   expiry, five attempts, per-email and per-IP rate limiting, hashed storage and
   constant-time comparison. Every one of those rules would have been custom code inside a
   custom provider.
3. **View-as needs a server-side session** to record which agency the admin is looking at,
   and to mark that session read-only.

What is here instead is ~250 lines: an opaque 256-bit token in an httpOnly cookie, its
SHA-256 stored server-side, the user re-read on every request. Fewer moving parts than a
custom provider plus a custom adapter, and it makes the requirements true rather than
approximately true.

### Rules that live in the database

Application checks lose races, so the invariants are indexes and validators:

- one passport number in the whole system (unique on the normalized form);
- a route is its origin + destination + center together;
- one account per email;
- a passport cannot hold two active bookings;
- `$jsonSchema` on every collection, so a migration, an import or the Atlas console cannot
  write a malformed record either.

Money is an integer in minor units with an explicit currency, never a float and never
summed across currencies. Date-only values are stored at midnight UTC and read back in
UTC. Passport numbers, emails and country codes are normalized once at write time and the
normalized form is stored alongside the original.

## Milestones

| | | |
|---|---|---|
| 0 | Profile the real sheets | ✅ `npm run profile`, report in `private/reports/` |
| 1 | Foundation: schema, DAL, OTP auth, invite-only users, isolation tests | ✅ |
| 2 | Passports: grid entry, paste, duplicate rule, status flow | ✅ |
| 3 | Routes & the handoff queue, CSV export | ✅ |
| 4 | Bulk booking import | ✅ parser needs real files to validate against |
| 5 | Payments & ledgers | ✅ |
| 6 | Dashboards, audit log, view-as, notifications | ✅ |
| 7 | Migration + deploy | — |

## Handling real data

`private/` is gitignored and holds the real sheet exports — passport numbers, names and
dates of birth for real people. It must never enter git history. `samples/` is for scrubbed
examples only, and is committed.

Passport numbers, names and dates of birth are never written to logs or to the audit log;
`redact()` strips them before an audit entry is stored, and there is a test that proves it.
