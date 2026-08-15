/**
 * Is this environment actually ready?
 *
 * Read-only. It connects to whatever `MONGODB_URI` points at and checks the things that
 * are invisible until they bite: a migration that was never applied, an index that
 * silently failed to build, a cluster that cannot do transactions, an admin account that
 * does not exist so nobody can log in.
 *
 *   npm run preflight
 *
 * Run it after deploying, after migrating, and before letting anyone in. It writes
 * nothing, so it is always safe to run against production.
 */

import { getMongoClient, getDbName } from '@/lib/mongodb';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A warning is worth knowing about but does not make the environment unusable. */
  warning?: boolean;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string, warning = false): void {
  checks.push({ name, ok, detail, warning });
  const mark = ok ? '✔' : warning ? '!' : '✖';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Every index that carries a rule rather than just making a query fast. */
const REQUIRED_INDEXES: Record<string, string[]> = {
  passports: ['uniq_passport_number_normalized', 'uniq_passport_active_booking'],
  routes: ['uniq_route_triple'],
  users: ['uniq_user_email'],
  agencies: ['uniq_agency_name'],
  bookings: ['uniq_live_booking_per_passport'],
  charges: ['uniq_live_charge_per_passport'],
  import_batches: ['uniq_committed_import_file'],
  payments: ['uniq_payment_idempotency'],
  sessions: ['uniq_session_token', 'ttl_sessions'],
  otps: ['ttl_otps'],
};

const MIGRATIONS = [
  '001_initial_collections',
  '002_bookings_and_charges',
  '003_payments_and_ledger',
  '004_family_applications',
];

async function main(): Promise<void> {
  console.log('Environment\n');

  check('MONGODB_URI is set', Boolean(process.env.MONGODB_URI), process.env.MONGODB_URI ? getDbName() : 'missing');
  check(
    'AUTH_SECRET is set',
    Boolean(process.env.AUTH_SECRET),
    process.env.AUTH_SECRET ? 'present' : 'OTPs and sessions will hash without a pepper',
    true,
  );
  check(
    'RESEND_API_KEY is set',
    Boolean(process.env.RESEND_API_KEY),
    process.env.RESEND_API_KEY ? 'emails will send' : 'sign-in codes will only print to the server log',
    true,
  );
  check(
    'APP_URL is set',
    Boolean(process.env.APP_URL),
    process.env.APP_URL ?? 'notification links will point at localhost',
    true,
  );

  if (!process.env.MONGODB_URI) {
    console.log('\nNothing else can be checked without a database. Set MONGODB_URI and run again.');
    process.exitCode = 1;
    return;
  }

  console.log('\nDatabase\n');

  const client = await getMongoClient();
  const db = client.db(getDbName());

  const ping = await db.command({ ping: 1 }).catch(() => null);
  check('The cluster answers', Boolean(ping), ping ? getDbName() : 'could not reach it');

  // Transactions need a replica set. Atlas is one; a plain local mongod is not, and a
  // booking would then be written without its charge.
  let transactionsWork = false;
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection('preflight_probe').findOne({}, { session });
    });
    transactionsWork = true;
  } catch {
    transactionsWork = false;
  } finally {
    await session.endSession();
  }
  check(
    'Transactions are supported',
    transactionsWork,
    transactionsWork ? 'booking, status, charge and audit will commit together' : 'this cluster is not a replica set',
  );

  const applied = new Set(
    (await db.collection('migrations').find({}).toArray()).map((row) => String(row._id)),
  );
  const missing = MIGRATIONS.filter((id) => !applied.has(id));
  check(
    'Migrations are applied',
    missing.length === 0,
    missing.length === 0 ? `${MIGRATIONS.length} applied` : `missing: ${missing.join(', ')} — run npm run migrate`,
  );

  console.log('\nRules that live in the database\n');

  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [collection, required] of Object.entries(REQUIRED_INDEXES)) {
    if (!collections.has(collection)) {
      check(`${collection} indexes`, false, 'the collection does not exist');
      continue;
    }
    const names = new Set((await db.collection(collection).indexes()).map((index) => index.name));
    const absent = required.filter((name) => !names.has(name));
    check(
      `${collection}: ${required.join(', ')}`,
      absent.length === 0,
      absent.length === 0 ? 'present' : `missing ${absent.join(', ')}`,
    );
  }

  const validated: string[] = [];
  const unvalidated: string[] = [];
  for (const name of ['agencies', 'users', 'routes', 'passports', 'bookings', 'charges', 'payments']) {
    if (!collections.has(name)) continue;
    const [info] = await db.listCollections({ name }).toArray();
    const options = (info as { options?: { validator?: unknown } } | undefined)?.options;
    const hasValidator = Boolean(options?.validator);
    (hasValidator ? validated : unvalidated).push(name);
  }
  check(
    'Collections validate their own documents',
    unvalidated.length === 0,
    unvalidated.length === 0 ? `${validated.length} collections` : `no validator on ${unvalidated.join(', ')}`,
  );

  console.log('\nCan anyone use it\n');

  const admins = await db.collection('users').countDocuments({ role: 'admin', active: true });
  check(
    'An administrator exists',
    admins > 0,
    admins > 0 ? `${admins} active` : 'run npm run create-admin -- --email … --name …',
  );

  const activeRoutes = await db.collection('routes').countDocuments({ active: true });
  check(
    'At least one route is open',
    activeRoutes > 0,
    activeRoutes > 0 ? `${activeRoutes} active` : 'agencies cannot file anything — run npm run seed-route',
  );

  const agencies = await db.collection('agencies').countDocuments({ active: true });
  const agencyUsers = await db.collection('users').countDocuments({ role: 'agency', active: true });
  check('Agencies exist', agencies > 0, `${agencies} agencies, ${agencyUsers} agency user(s)`, true);

  const passports = await db.collection('passports').countDocuments({});
  check('Passports are present', true, `${passports} on record`, true);

  // ---------------------------------------------------------------------------

  const failures = checks.filter((entry) => !entry.ok && !entry.warning);
  const warnings = checks.filter((entry) => !entry.ok && entry.warning);

  console.log(
    `\n${checks.length - failures.length - warnings.length}/${checks.length} checks passed` +
      (warnings.length > 0 ? `, ${warnings.length} worth a look` : '') +
      (failures.length > 0 ? `, ${failures.length} failed` : ''),
  );

  if (failures.length > 0) {
    console.log('\nNot ready:');
    for (const failure of failures) console.log(`  ${failure.name} — ${failure.detail}`);
    process.exitCode = 1;
  }

  await client.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
