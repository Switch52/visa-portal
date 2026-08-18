/**
 * Smoke test: check a deployment's real HTTP surface.
 *
 * **Nothing is hosted on this machine.** Point it at a deployment:
 *
 *   SMOKE_BASE_URL=https://portal.example.com npm run smoke
 *
 * Passing no URL is refused rather than quietly falling back to starting a local server.
 *
 * ---
 *
 * This used to run ~45 checks, most of them signed in. It could, because sessions were
 * ours: the script minted a session row, set the cookie, and drove the app as an admin
 * and as an agency user. Clerk owns sessions now, and one cannot be forged from outside —
 * deliberately, and it is the same property that makes Clerk worth having.
 *
 * Rather than pretend, the authenticated half is gone and what remains is the half that
 * can still be proven from outside: that the deployment is up, and that it hands nothing
 * to an anonymous caller. The second is worth checking on every deploy — a proxy
 * misconfigured to let requests past authentication is exactly the failure that looks
 * fine right up until it is catastrophic.
 *
 * Restoring the rest needs Clerk testing tokens (`@clerk/testing`), which need a Clerk
 * instance and its secret key. Until then the invariants themselves stay covered by
 * `npm test`, which runs against a real MongoDB.
 */

const BASE = (process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/** The deployment should already be up; this only tolerates a cold start. */
async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('The server did not come up in time.');
}

/** Every screen that holds passport data. None may answer an anonymous request. */
const PROTECTED_PATHS = [
  '/',
  '/passports',
  '/passports/new',
  '/balance',
  '/admin/passports',
  '/admin/agencies',
  '/admin/users',
  '/admin/routes',
  '/admin/handoff',
  '/admin/imports',
  '/admin/payments',
  '/admin/balances',
  '/admin/audit',
  '/admin/settings',
];

async function main(): Promise<void> {
  if (!BASE) {
    throw new Error(
      'SMOKE_BASE_URL is not set.\n' +
        'This check runs against a deployment, not against this machine — nothing is hosted here.\n' +
        'Example: SMOKE_BASE_URL=https://portal.example.com npm run smoke',
    );
  }

  console.log(`Checking ${BASE} …`);
  await waitForServer();
  console.log('\nChecks:');

  // --- it is up ----------------------------------------------------------------------

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.text();
  check('the health endpoint answers', health.status === 200, `status ${health.status}`);
  check(
    'it answers without touching the database',
    healthBody.includes('"status":"ok"'),
    healthBody.slice(0, 80),
  );

  const signIn = await fetch(`${BASE}/sign-in`);
  check('the sign-in page renders', signIn.status === 200, `status ${signIn.status}`);

  const signInHtml = await signIn.text();
  check(
    'Clerk is wired up on it',
    /clerk/i.test(signInHtml),
    'no Clerk markup — check NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY was set at build time',
  );

  // --- it gives nothing away ---------------------------------------------------------

  let leaked = 0;
  for (const path of PROTECTED_PATHS) {
    const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    const turnedAway = [301, 302, 303, 307, 308, 401, 404].includes(response.status);
    if (!turnedAway) leaked += 1;
    check(`${path} turns away an anonymous request`, turnedAway, `status ${response.status}`);
  }
  check('no protected screen answered anonymously', leaked === 0, `${leaked} did`);

  // A redirect that still carried the page body would defeat the point of redirecting.
  const rootAnonymous = await fetch(`${BASE}/`, { redirect: 'manual' });
  const rootBody = await rootAnonymous.text();
  check(
    'the redirect carries no page content with it',
    rootBody.length < 2_000,
    `${rootBody.length} bytes`,
  );

  const exportAnonymous = await fetch(`${BASE}/api/exports/handoff`, { redirect: 'manual' });
  check(
    'the handoff export refuses an anonymous request',
    exportAnonymous.status !== 200,
    `status ${exportAnonymous.status}`,
  );

  // --- it is not advertising itself --------------------------------------------------

  check(
    'the app asks not to be indexed',
    signInHtml.includes('noindex'),
    'this app holds passport numbers and must stay out of search results',
  );

  // --- report ------------------------------------------------------------------------

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    '\nNote: signed-in behaviour is not covered here — Clerk owns sessions and one cannot\n' +
      'be minted from outside. The rules themselves are covered by `npm test`.',
  );

  if (failed.length > 0) {
    console.error('\nFailed:');
    for (const f of failed) console.error(`  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
