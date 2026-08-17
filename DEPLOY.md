# Deploying

Nothing below has been done yet: there is no cluster and no hosted app. Every test and
every migration dry run so far has run against a throwaway MongoDB that is created for the
run and destroyed at the end.

Both steps need accounts that only you can create. Once the connection string exists, the
rest is scripted.

---

## 1. The database — MongoDB Atlas

1. Create a free **M0** cluster. Region: **AWS Frankfurt (`eu-central-1`)** — the closest M0
   region to Cairo at ~2,900km, roughly 60-80ms. The free tier offers only a handful of
   regions, and Milan and Bahrain are not among them however close they look on a map. The
   next best are Belgium and Amsterdam (~3,200km), then Ireland and Mumbai (~4,400km).
   Do not accept the default of N. Virginia: at ~9,300km it is triple the latency on every
   screen that touches the database.
2. **Encryption at rest** is on by default on Atlas; leave it on.
3. **Network access → IP allowlist.** Add your own address for running scripts. Vercel's
   functions do not have fixed addresses, so for them either allow `0.0.0.0/0` and rely on
   the password, or use Atlas's Vercel integration, which is the better option if it is
   available on the free tier when you get there.
4. **Database access → add a user** with `readWrite` on `visa_portal` only. Not an admin
   user, and not the same password as anything else.
5. Copy the connection string. It looks like:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

Two traps at this step, both of which look like the cluster is broken when it is not:

- **A password containing `@`, `:`, `/` or `#` must be percent-encoded** in the string, or
  the connection fails without saying why. Atlas's *Autogenerate Secure Password* avoids it.
- **The allowlist is tied to the network you were on when you added it.** Move to a café or
  a phone hotspot and every script hangs until that address is added too. When something
  worked yesterday and times out today, look here first.

Then, locally:

```bash
cp .env.example .env.local        # then paste the string into MONGODB_URI
openssl rand -base64 32           # paste into AUTH_SECRET
npm run migrate                   # collections, validators, every index
npm run preflight                 # proves the above actually happened
```

`preflight` is read-only and safe against production. It checks the things that are
invisible until they bite: a migration that was never applied, an index that silently
failed to build, a cluster that cannot do transactions, no admin account so nobody can
log in.

## 2. The app — Vercel

1. **New project → import `Switch52/visa-portal`.** Framework detection handles the rest;
   there is no build configuration to write.
2. Environment variables, for Production and Preview both:

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | the Atlas string |
   | `MONGODB_DB` | `visa_portal` |
   | `AUTH_SECRET` | the random string from above |
   | `RESEND_API_KEY` | from Resend, once the domain is verified |
   | `EMAIL_FROM` | e.g. `Passport Portal <portal@yourdomain.com>` |
   | `APP_URL` | the production URL — this is what notification links point at |

3. Deploy, then open `/login`. Nothing else is reachable without a session.

**Email:** until `RESEND_API_KEY` is set, sign-in codes print to the server log instead of
being sent — which means nobody but you can log in. Resend needs a verified domain before
it will send to arbitrary addresses.

## 3. Bringing it to life

In this order, because each step depends on the one before:

```bash
npm run create-admin -- --email you@example.com --name "Your Name"
npm run seed-route -- --center "Greece Cairo" --fee 60 --currency USD
npm run seed-route -- --center "Greece Alexandria" --fee 60 --currency USD --inactive
npm run preflight                 # should now be all green
```

Then the migration, which is the only step that writes the real data:

```bash
npm run migrate-sheets            # dry run, into a throwaway database, one last time
npm run migrate-sheets -- --commit
```

The commit produces a reconciliation report in `private/reports/`. **Read it against your
own numbers before inviting anyone.**

## 4. The pilot

Invite one agency you trust. A week on real data: they enter passports, you run a real
handoff export and a real booking import. Their sheet stays open as a safety net and is not
set to read-only until after cutover.

What to watch for, since it is what no test can tell you:

- does the grid actually beat their spreadsheet, or do they go back to it?
- does a paste from *their* file land in the right columns?
- does the handoff export import cleanly into the main dashboard, first time?

## Afterwards

- Set every sheet to read-only on cutover day, and keep them readable for at least a year.
- `private/` never enters git. It holds real passport numbers, and git history is forever.
- Rotate `AUTH_SECRET` only when you intend to sign everyone out — it peppers session
  hashes, so changing it invalidates every live session.
