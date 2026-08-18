# Agency Passport & Booking Portal

Passport intake, duplicate prevention, handoff to the main booking dashboard, and a
per-currency ledger — replacing the per-agency Google Sheets.

The full specification is in [`BUILD_PROMPT.md`](./BUILD_PROMPT.md). **This portal feeds the
main booking dashboard and never replaces it.** Nothing here may set a passport to `booked`
except importing a real booking file.

## Getting started

```bash
npm install
cp .env.example .env.local     # MONGODB_URI, the two Clerk keys, AUTH_SECRET
npm run migrate                # create collections, validators and indexes
npm run create-admin -- --email you@example.com --name "Your Name"
```

**Nothing is hosted on a laptop.** The app runs as a Docker container on our own server;
the database is Atlas. Scripts
here (`migrate`, `preflight`, `seed-route`, `migrate-sheets`) connect out to that cluster
and start no server of their own. Tests use a MongoDB that exists only inside the test
process and is destroyed when it exits.

Sign in at the deployment's `/sign-in`, which is Clerk. Signing in proves who you are and
nothing more: access needs an invited record in `users`, so an uninvited account lands on
`/no-access`. `RESEND_API_KEY` affects only the portal's own notifications — Clerk sends
its own sign-in codes.

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | The Next.js app |
| `npm test` | Every invariant — 259 tests, all passing |
| `npm run smoke` | Checks a **deployment's** HTTP surface — `SMOKE_BASE_URL=… npm run smoke`. Never starts a local server |
| `npm run typecheck` / `lint` | TypeScript, ESLint |
| `npm run migrate` | Apply migrations (`-- --status`, `-- --down <id>`) |
| `npm run create-admin` | Bootstrap the first administrator |
| `npm run seed-route` | Create a route from the command line (idempotent) |
| `npm run profile` | Re-run the migration data profiler over `private/` |
| `npm run preflight` | Check a real environment is ready — read-only, safe against production |
| `npm run migrate-sheets` | Dry-run the sheet migration into a throwaway database (`-- --commit` for real) |

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
src/lib/auth/    Resolving the Clerk session into an actor, and the view-as cookie.
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

### Clerk authenticates; this app authorizes

Clerk owns sign-in — codes, rate limiting, device management, session revocation. That
replaced about 490 lines of our own OTP and session code, which had been written because
Auth.js could not do those three things well. Clerk can.

What did **not** move is the half that decides what anyone may see. `users` remains the
source of truth for role, agency and `active`, and is re-read on **every request** — never
trusted from a token claim. Two properties depend on that:

- **Invite-only.** Anyone may create a Clerk account. Only an account whose email matches
  an invited record resolves to an actor; everyone else is signed in and lands on
  `/no-access` with nothing.
- **Deactivation is immediate.** `active: false` ends access on the next click, not
  whenever a token expires.

The link is made once, on first sign-in: match by email, store `clerkUserId`, and every
later request is a single indexed lookup. A unique partial index means one Clerk identity
maps to at most one record, and an already-linked record refuses a second claimant.

**View-as is still ours**, because Clerk has no concept of it — an admin reading one
agency's data, unable to write. It moved from the session row to an HMAC-signed cookie,
deliberately separate from Clerk's, so a token refresh or sign-out cannot strand someone
inside another agency's data.

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
| 1 | Foundation: schema, DAL, auth, invite-only users, isolation tests | ✅ |
| 2 | Passports: grid entry, paste, duplicate rule, status flow | ✅ |
| 3 | Routes & the handoff queue, CSV export | ✅ |
| 4 | Bulk booking import | ✅ parser needs real files to validate against |
| 5 | Payments & ledgers | ✅ |
| 6 | Dashboards, audit log, view-as, notifications | ✅ |
| 7 | Migration + deploy | — |

## Working on it

One branch: `main`. Work goes straight onto it.

Which puts all the weight on this, before every commit:

```bash
npm run typecheck && npm run lint && npm test
```

With no review step between a change and `main`, that command is the only thing standing
between a mistake and the branch everything deploys from. Run it — not the parts of it
that seem relevant.

Running it on GitHub as well would mean a green tick recorded next to each commit rather
than a claim in a chat message. That needs a workflow file in `.github/workflows/`, which
a token has to carry the `workflow` scope to push. It matters more now than it did under
review, not less.

## Deploying

The Atlas cluster is live — schema, indexes, validators, an administrator and both routes.
The app is deployed as a container but not yet signed into. [`DEPLOY.md`](./DEPLOY.md) is
the runbook.

It ships as a container: `output: 'standalone'` in `next.config.ts`, a three-stage
[`Dockerfile`](./Dockerfile), and [`docker-compose.yml`](./docker-compose.yml) for the
server. No secret is a build argument — `MONGODB_URI` and `AUTH_SECRET` are read at
runtime, so the image holds nothing worth stealing and the same image can be promoted
between environments unchanged.

`/api/health` is the liveness probe. It answers without touching MongoDB, deliberately:
a probe that pings the database fails every container at once when the database is merely
slow, and restarts the one part that was still working.

## Handling real data

`private/` is gitignored and holds the real sheet exports — passport numbers, names and
dates of birth for real people. It must never enter git history. `samples/` is for scrubbed
examples only, and is committed.

Passport numbers, names and dates of birth are never written to logs or to the audit log;
`redact()` strips them before an audit entry is stored, and there is a test that proves it.
