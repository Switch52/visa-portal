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
3. **Network access → IP allowlist.** Two entries: your own address, for running scripts
   from the laptop, and **the server's static IP**, for the container.

   This is one real advantage of hosting it yourself. A serverless host has no fixed
   outbound address, which forces `0.0.0.0/0` — the whole internet, with the password as
   the only thing in the way. A server you own has one address, so the database can be
   reachable from exactly that machine and nowhere else. Take it: a leaked connection
   string is then not enough on its own.
4. **Database access → add a user.** Two users, because the scripts and the app need
   different powers and there is no reason to give a web request the stronger one:

   | User | Privileges on `visa_portal` | Used by |
   |---|---|---|
   | `visa_portal_admin` | `readWrite` **and** `dbAdmin` | your laptop — `.env.local` |
   | `visa_portal_app` | `readWrite` only | Vercel |

   `dbAdmin` is what applies the `$jsonSchema` validators: `readWrite` alone cannot run
   `collMod`, and the migrations stop partway through with a permissions error. Scoped to
   one database it is a narrow role — schema and indexes on `visa_portal`, no documents,
   no other database, and nothing like `atlasAdmin`.

   Keep them separate. Nothing a web request does should be able to drop an index or
   rewrite a validator, and the credential that sits in a hosting dashboard is the one
   most likely to leak. Neither password should match anything else you own.
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

## 2. The app — Docker, on your own server

On the server, once it has Docker and a checkout of the repository:

```bash
cp .env.example .env              # next to docker-compose.yml, on the server
                                  # fill in MONGODB_URI, AUTH_SECRET, APP_URL
docker compose up -d --build
docker compose logs -f app        # sign-in codes appear here until Resend is set up
```

| Variable | Value |
|---|---|
| `MONGODB_URI` | the Atlas string, built with the `readWrite`-only `visa_portal_app` user — **not** the one in your `.env.local` |
| `MONGODB_DB` | `visa_portal` |
| `AUTH_SECRET` | the random string from above |
| `RESEND_API_KEY` | from Resend, once the domain is verified |
| `EMAIL_FROM` | e.g. `Passport Portal <portal@yourdomain.com>` |
| `APP_URL` | the public URL — this is what notification links point at |

**Nothing above is a build argument.** `docker build --build-arg` writes the value into
the image's layer history, where `docker history` will read it back out months later even
if a subsequent line deletes the file. These are read at runtime, per request, so the
image holds no secret and the same image can move from staging to production untouched.

**Put a reverse proxy in front of it.** Compose binds to `127.0.0.1:3000`, not to every
interface, because what should face the internet is nginx or Caddy terminating TLS.
Sessions ride an httpOnly cookie; over plain HTTP that cookie crosses the network in
cleartext on every request. If nginx is the proxy, disable buffering — the app streams,
and buffering makes every page feel like it arrives all at once, late.

**Updating** is a rebuild and a replace; the database is untouched:

```bash
git pull && docker compose up -d --build
```

If a release adds a migration, run `npm run migrate` from your laptop **before** rolling
out the new image, so the schema is ready for the code that expects it.

**Two things to know if you ever run more than one container.** Server Actions are
encrypted with a key generated at build time, so every replica must come from the *same
image* or you get "Failed to find Server Action" errors — build once, deploy that. And the
page cache lives in each container's memory, so replicas can briefly disagree about cached
pages. Neither matters for a single container, which is what the pilot needs.

Then open `/login`. Nothing else is reachable without a session.

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
