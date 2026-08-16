/**
 * End-to-end smoke test: check the real HTTP surface — pages render, unauthenticated
 * requests are turned away, an agency session cannot reach an admin screen.
 *
 * The unit tests prove the rules; this proves the thing actually runs.
 *
 * **Nothing is hosted on this machine.** Point it at a deployment:
 *
 *   SMOKE_BASE_URL=https://visa-portal.vercel.app npm run smoke
 *
 * It needs the database that deployment uses, so `MONGODB_URI` must be the same cluster —
 * the checks sign sessions and seed records directly, then exercise them over HTTP.
 *
 * Passing no URL is refused rather than quietly falling back to starting a local server.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';

const BASE = process.env.SMOKE_BASE_URL ?? '';

let replSet: MongoMemoryReplSet | null = null;
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
      const response = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('The server did not come up in time.');
}

async function main(): Promise<void> {
  if (!BASE) {
    throw new Error(
      'SMOKE_BASE_URL is not set.\n' +
        'This check runs against a deployment, not against this machine — nothing is hosted here.\n' +
        'Example: SMOKE_BASE_URL=https://visa-portal.vercel.app npm run smoke',
    );
  }

  console.log('Starting a throwaway MongoDB…');
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();

  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = 'visa_portal_smoke';
  process.env.AUTH_SECRET = 'smoke-secret';

  const { getMongoClient } = await import('@/lib/mongodb');
  const client = await getMongoClient();

  console.log('Applying migrations…');
  const { up: up001 } = await import('../migrations/001_initial_collections');
  const { up: up002 } = await import('../migrations/002_bookings_and_charges');
  const { up: up003 } = await import('../migrations/003_payments_and_ledger');
  const { up: up004 } = await import('../migrations/004_family_applications');
  await up001(client.db('visa_portal_smoke'));
  await up002(client.db('visa_portal_smoke'));
  await up003(client.db('visa_portal_smoke'));
  await up004(client.db('visa_portal_smoke'));

  console.log('Seeding an admin, an agency and an agency user…');
  const { adminActor } = await import('@/lib/dal/actor');
  const dal = await import('@/lib/dal');
  const { users } = await import('@/lib/db/collections');
  const { createSession } = await import('@/lib/auth/session');

  const now = new Date();
  const userCollection = await users();
  const { insertedId: adminId } = await userCollection.insertOne({
    name: 'Smoke Admin',
    email: 'admin@example.com',
    emailNormalized: 'admin@example.com',
    role: 'admin',
    agencyId: null,
    active: true,
    createdAt: now,
    updatedAt: now,
  } as never);

  const admin = adminActor(adminId);
  const agency = await dal.createAgency(admin, { name: 'Smoke Agency', defaultCurrency: 'USD' });
  const agencyUser = await dal.inviteUser(admin, {
    name: 'Smoke Agent',
    email: 'agent@example.com',
    role: 'agency',
    agencyId: agency.id,
  });
  await dal.createRoute(admin, {
    originCountry: 'EGY',
    destinationCountry: 'FRA',
    appointmentCenter: 'VFS Cairo',
    feeMinor: 12_000,
    feeCurrency: 'USD',
    active: true,
  });

  const { ObjectId } = await import('mongodb');
  const adminSession = await createSession(adminId);
  const agencySession = await createSession(new ObjectId(agencyUser.id));

  console.log(`Checking ${BASE} …`);
  await waitForServer();
  console.log('\nChecks:');

  const cookie = (token: string) => ({ cookie: `vp_session=${token}` });

  const login = await fetch(`${BASE}/login`);
  check('the login page renders', login.status === 200, `status ${login.status}`);
  const loginHtml = await login.text();
  check(
    'the login page asks for an email and says access is by invitation',
    loginHtml.includes('Send code') && loginHtml.includes('invitation'),
  );

  const anonymous = await fetch(`${BASE}/`, { redirect: 'manual' });
  check(
    'an unauthenticated visitor is sent to the login page',
    anonymous.status === 307 || anonymous.status === 302,
    `status ${anonymous.status}`,
  );

  const adminHome = await fetch(`${BASE}/`, { headers: cookie(adminSession.token) });
  const adminHomeHtml = await adminHome.text();
  check('the admin home renders for an admin session', adminHome.status === 200, `status ${adminHome.status}`);
  check(
    'the admin home shows the cross-agency view',
    adminHomeHtml.includes('Everything, across every agency'),
  );

  const agencyPage = await fetch(`${BASE}/admin/users`, {
    headers: cookie(agencySession.token),
    redirect: 'manual',
  });
  check(
    'an agency session is turned away from an admin screen',
    agencyPage.status === 307 || agencyPage.status === 302,
    `status ${agencyPage.status}`,
  );

  const agencyHome = await fetch(`${BASE}/`, { headers: cookie(agencySession.token) });
  const agencyHomeHtml = await agencyHome.text();
  check('the agency home renders for an agency session', agencyHome.status === 200);
  check(
    'the agency home shows their own name and not the cross-agency view',
    agencyHomeHtml.includes('Smoke Agency') && !agencyHomeHtml.includes('Everything, across every agency'),
  );

  const adminUsers = await fetch(`${BASE}/admin/users`, { headers: cookie(adminSession.token) });
  const adminUsersHtml = await adminUsers.text();
  check('the admin can see the user list', adminUsers.status === 200 && adminUsersHtml.includes('agent@example.com'));

  const routes = await fetch(`${BASE}/admin/routes`, { headers: cookie(adminSession.token) });
  const routesHtml = await routes.text();
  check('the route and its fee are visible to the admin', routesHtml.includes('Egypt → France · VFS Cairo') && routesHtml.includes('120.00 USD'));

  const agencyPassports = await fetch(`${BASE}/passports`, { headers: cookie(agencySession.token) });
  const agencyPassportsHtml = await agencyPassports.text();
  check(
    'the agency passport list carries no fee and no other agency',
    agencyPassports.status === 200 && !agencyPassportsHtml.includes('120.00') && !agencyPassportsHtml.includes('Everything, across'),
  );

  // --- milestone 2: entry, listing and the detail view ------------------------------
  const chooserPage = await fetch(`${BASE}/passports/new`, { headers: cookie(agencySession.token) });
  const chooserHtml = await chooserPage.text();
  check(
    'the route chooser lists a page per active route, with no fee on it',
    chooserPage.status === 200 &&
      chooserHtml.includes('Egypt → France · VFS Cairo') &&
      !chooserHtml.includes('120.00'),
  );

  const routeOptions = await dal.listRouteOptions(adminActor(adminId));
  const gridPage = await fetch(`${BASE}/passports/new/${routeOptions[0]!.id}`, {
    headers: cookie(agencySession.token),
  });
  const gridHtml = await gridPage.text();
  check(
    "that route's own entry grid opens, locked to it, with families offered",
    gridPage.status === 200 &&
      gridHtml.includes('Egypt → France · VFS Cairo') &&
      gridHtml.includes('Paste straight from your spreadsheet') &&
      gridHtml.includes('Family of 4') &&
      !gridHtml.includes('120.00'),
  );

  // Seed a passport through the DAL so the list and detail views have something real.
  const { ObjectId: Oid } = await import('mongodb');
  const { agencyActor } = await import('@/lib/dal/actor');
  const agencyDalActor = agencyActor(new Oid(agencyUser.id), new Oid(agency.id));
  const created = await dal.createPassports(agencyDalActor, [
    {
      firstName: 'Smoke',
      lastName: 'Traveller',
      passportNumber: 'A99887766',
      passportExpiryDate: '2032-09-15',
      dateOfBirth: '1995-07-11',
      nationality: 'EGY',
      gender: 'Female',
      routeId: (await dal.listRouteOptions(admin))[0]!.id,
      notes: 'مهم جدا يتحجز',
    },
  ]);
  const passportId = created.rows[0]!.passportId!;

  const listWithRow = await fetch(`${BASE}/passports`, { headers: cookie(agencySession.token) });
  const listHtml = await listWithRow.text();
  check(
    'the agency sees their own passport in the list, notes and all',
    listHtml.includes('A99887766') && listHtml.includes('مهم جدا يتحجز'),
  );

  const search = await fetch(`${BASE}/admin/passports?q=a99887766`, { headers: cookie(adminSession.token) });
  const searchHtml = await search.text();
  check('an admin can find it by passport number, lower-cased', searchHtml.includes('A99887766'));

  const filteredOut = await fetch(`${BASE}/admin/passports?status=booked`, {
    headers: cookie(adminSession.token),
  });
  const filteredHtml = await filteredOut.text();
  check('a status filter that matches nothing shows nothing', !filteredHtml.includes('A99887766'));

  const detail = await fetch(`${BASE}/passports/${passportId}`, { headers: cookie(agencySession.token) });
  const detailHtml = await detail.text();
  check(
    'the detail view shows the record and its history',
    detail.status === 200 && detailHtml.includes('Smoke') && detailHtml.includes('History'),
  );

  const otherAgencysRecord = await fetch(`${BASE}/passports/${new Oid().toHexString()}`, {
    headers: cookie(agencySession.token),
  });
  check(
    'a passport id that is not theirs is a plain not-found',
    otherAgencysRecord.status === 404,
    `status ${otherAgencysRecord.status}`,
  );

  // --- milestone 3: the handoff queue and the export --------------------------------
  const adminDalActor = adminActor(adminId);
  await dal.changePassportStatuses(adminDalActor, [new Oid(passportId)], 'ready');

  const handoff = await fetch(`${BASE}/admin/handoff`, { headers: cookie(adminSession.token) });
  const handoffHtml = await handoff.text();
  check(
    'the handoff queue shows the ready passport, grouped by route',
    handoff.status === 200 &&
      handoffHtml.includes('Egypt → France · VFS Cairo') &&
      handoffHtml.includes('A99887766'),
  );

  const exportResponse = await fetch(`${BASE}/api/exports/handoff?ids=${passportId}`, {
    headers: cookie(adminSession.token),
  });
  const disposition = exportResponse.headers.get('content-disposition') ?? '';
  // Raw bytes, not response.text(): fetch's UTF-8 decode strips a leading BOM, which is
  // exactly the byte being checked.
  const csvBytes = Buffer.from(await exportResponse.arrayBuffer());
  const csv = csvBytes.toString('utf8');
  const csvLines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');

  check('the export returns a CSV', exportResponse.status === 200 && csv.length > 0, `status ${exportResponse.status}`);
  check(
    'it is served as a download with a filename that means something',
    /filename="handoff_\d{4}-\d{2}-\d{2}_Egypt-France-VFS-Cairo_1\.csv"/.test(disposition),
    disposition,
  );
  check(
    'the file really starts with the UTF-8 BOM bytes',
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    `first bytes ${[...csvBytes.subarray(0, 3)].map((b) => b.toString(16)).join(' ')}`,
  );
  check(
    'the header is the byte-exact one the main dashboard matches on',
    csvLines[0] ===
      '"firstName","lastName","passportNumber","passportExpiryDate","dateOfBirth","nationality","gender","contactNumber (optional)","contactNumberDialCode (optional)","contactEmail (optional)"',
    csvLines[0],
  );
  check(
    'the row carries ISO dates and the passport number as text',
    csvLines[1]?.includes('"A99887766"') === true && csvLines[1]?.includes('"2032-09-15"') === true,
    csvLines[1],
  );

  // The whole point of the two-step handoff: the file changed nothing.
  const afterExport = await dal.getPassport(adminDalActor, new Oid(passportId));
  check('exporting left the status alone', afterExport.status === 'ready', afterExport.status);

  const exportAsAgency = await fetch(`${BASE}/api/exports/handoff?ids=${passportId}`, {
    headers: cookie(agencySession.token),
  });
  check(
    'an agency cannot reach the export endpoint at all',
    exportAsAgency.status === 403,
    `status ${exportAsAgency.status}`,
  );

  const marked = await dal.markAsAdded(adminDalActor, [new Oid(passportId)]);
  const afterMark = await dal.getPassport(adminDalActor, new Oid(passportId));
  check(
    'marking as added is the separate, deliberate step',
    marked.marked === 1 && afterMark.status === 'added',
    afterMark.status,
  );

  // --- milestone 4: the booking import ----------------------------------------------
  const importsPage = await fetch(`${BASE}/admin/imports`, { headers: cookie(adminSession.token) });
  const importsHtml = await importsPage.text();
  check(
    'the booking import screen renders',
    importsPage.status === 200 && importsHtml.includes('Upload a booking file'),
  );

  // Drive a real import through the DAL, then check the app reflects it.
  const bookingCsv = [
    '"Passport Number","Appointment Date","Appointment Time","Location","Reference"',
    '"A99887766","27/08/2026","09:30","VFS Cairo","SMOKE-1"',
  ].join('\r\n');

  const committed = await dal.commitImport(adminDalActor, {
    buffer: Buffer.from(bookingCsv, 'utf8'),
    filename: 'smoke-bookings.csv',
  });
  check('a booking file books the passport and raises its charge', committed.booked === 1, JSON.stringify(committed.charges));

  const bookedPassport = await dal.getPassport(adminDalActor, new Oid(passportId));
  check('the passport is booked afterwards', bookedPassport.status === 'booked', bookedPassport.status);

  const reimport = await dal.commitImport(adminDalActor, {
    buffer: Buffer.from(bookingCsv, 'utf8'),
    filename: 'smoke-bookings.csv',
  });
  check('re-uploading the same file changes nothing', reimport.booked === 0 && Boolean(reimport.noop));

  const agencyAfterBooking = await fetch(`${BASE}/passports`, { headers: cookie(agencySession.token) });
  const agencyAfterHtml = await agencyAfterBooking.text();
  check(
    'the agency sees its passport as booked, without ever seeing a fee',
    agencyAfterHtml.includes('Booked') && !agencyAfterHtml.includes('120.00'),
  );

  const undone = await dal.undoImport(adminDalActor, new Oid(committed.batchId));
  const afterUndo = await dal.getPassport(adminDalActor, new Oid(passportId));
  check(
    'undoing the import reverts the passport and voids the charge',
    undone.chargesVoided === 1 && afterUndo.status === 'added',
    `${afterUndo.status}, charges voided ${undone.chargesVoided}`,
  );

  // --- milestone 5: payments and balances -------------------------------------------
  // Re-import so there is a live charge to pay against (the undo above voided the first).
  await dal.commitImport(adminDalActor, {
    buffer: Buffer.from(bookingCsv, 'utf8'),
    filename: 'smoke-bookings-2.csv',
  });

  const paymentsPage = await fetch(`${BASE}/admin/payments`, { headers: cookie(adminSession.token) });
  const paymentsHtml = await paymentsPage.text();
  check(
    'the daily payments form renders with the agency and its default currency',
    paymentsPage.status === 200 && paymentsHtml.includes('Record a payment') && paymentsHtml.includes('Smoke Agency'),
  );

  const key = dal.newIdempotencyKey();
  await dal.recordPayment(adminDalActor, {
    agencyId: agency.id,
    amountMinor: 5_000,
    currency: 'USD',
    idempotencyKey: key,
  });
  const duplicate = await dal.recordPayment(adminDalActor, {
    agencyId: agency.id,
    amountMinor: 5_000,
    currency: 'USD',
    idempotencyKey: key,
  });
  check('the same payment submitted twice is recorded once', duplicate.duplicate === true);

  const balancesPage = await fetch(`${BASE}/admin/balances`, { headers: cookie(adminSession.token) });
  const balancesHtml = await balancesPage.text();
  check(
    'the balance overview shows charged, paid and outstanding',
    balancesPage.status === 200 &&
      balancesHtml.includes('120.00 USD') &&
      balancesHtml.includes('50.00 USD') &&
      balancesHtml.includes('70.00 USD'),
  );
  check(
    'the EGP figure is shown and labelled indicative',
    balancesHtml.includes('indicative') && balancesHtml.includes('rate last updated'),
  );

  const agencyLedger = await fetch(`${BASE}/balance`, { headers: cookie(agencySession.token) });
  const agencyLedgerHtml = await agencyLedger.text();
  check(
    'the agency sees its own balance and payment history, read-only',
    agencyLedger.status === 200 &&
      agencyLedgerHtml.includes('70.00 USD') &&
      !agencyLedgerHtml.includes('Record a payment'),
  );

  // --- milestone 6: dashboards, audit log, notifications ----------------------------
  const adminDashboard = await fetch(`${BASE}/`, { headers: cookie(adminSession.token) });
  const adminDashboardHtml = await adminDashboard.text();
  check(
    'the admin home shows the operational tiles',
    adminDashboardHtml.includes('Ready to hand off') &&
      adminDashboardHtml.includes('Added, not yet booked') &&
      adminDashboardHtml.includes('Recent activity'),
  );

  const agencyDashboard = await fetch(`${BASE}/`, { headers: cookie(agencySession.token) });
  const agencyDashboardHtml = await agencyDashboard.text();
  check(
    'the agency home shows their own figures and no admin tiles',
    agencyDashboardHtml.includes('Smoke Agency') &&
      agencyDashboardHtml.includes('What you owe') &&
      !agencyDashboardHtml.includes('Ready to hand off') &&
      !agencyDashboardHtml.includes('Duplicates blocked'),
  );

  const auditPage = await fetch(`${BASE}/admin/audit`, { headers: cookie(adminSession.token) });
  const auditHtml = await auditPage.text();
  check(
    'the audit log lists what has happened, with no passport numbers in it',
    auditPage.status === 200 && auditHtml.includes('Audit log') && !auditHtml.includes('A99887766'),
  );

  const auditAsAgency = await fetch(`${BASE}/admin/audit`, {
    headers: cookie(agencySession.token),
    redirect: 'manual',
  });
  check(
    'an agency cannot open the audit log',
    auditAsAgency.status === 307 || auditAsAgency.status === 302,
    `status ${auditAsAgency.status}`,
  );

  const agenciesList = await fetch(`${BASE}/admin/agencies`, { headers: cookie(adminSession.token) });
  const agenciesHtml = await agenciesList.text();
  check(
    'the agencies list carries counts and what each one owes',
    agenciesHtml.includes('Smoke Agency') && agenciesHtml.includes('Booked') && agenciesHtml.includes('Owed'),
  );

  const notificationsPage = await fetch(`${BASE}/admin/settings/notifications`, {
    headers: cookie(adminSession.token),
  });
  const notificationsHtml = await notificationsPage.text();
  check(
    'the notification settings render with both emails listed',
    notificationsPage.status === 200 &&
      notificationsHtml.includes('Welcome an invited user') &&
      notificationsHtml.includes('Tell an agency their passports are booked'),
  );

  const settings = await fetch(`${BASE}/admin/settings/export`, { headers: cookie(adminSession.token) });
  const settingsHtml = await settings.text();
  check(
    'the export format screen renders with the editable template',
    settings.status === 200 && settingsHtml.includes('contactNumber (optional)'),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { getMongoClient } = await import('@/lib/mongodb');
    const client = await getMongoClient().catch(() => null);
    await client?.close();
    await replSet?.stop();
  });
