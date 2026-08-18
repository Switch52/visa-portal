/**
 * Test harness: a real MongoDB, started as a single-node replica set so transactions
 * behave the way they do on Atlas, with every migration applied in order.
 *
 * The tests run against the actual validators and the actual unique indexes, because
 * those are the things being tested — a mocked collection would prove nothing about
 * whether the database refuses a duplicate.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId, type Db, type MongoClient } from 'mongodb';

let replSet: MongoMemoryReplSet | null = null;

export interface TestContext {
  client: MongoClient;
  dal: typeof import('@/lib/dal');
  actor: typeof import('@/lib/dal/actor');
  collections: typeof import('@/lib/db/collections');
}

/** Start the server, point the app's cached client at it, and migrate. */
export async function startTestDb(): Promise<TestContext> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();

  // Must be set before the app modules are imported: they read the env at module load.
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = 'visa_portal_test';
  process.env.AUTH_SECRET = 'test-secret';
  delete process.env.RESEND_API_KEY;

  const { getMongoClient } = await import('@/lib/mongodb');
  const client = await getMongoClient();

  // Every migration, discovered and ordered the way `npm run migrate` does it.
  //
  // Deliberately not a hand-written list. A list has to be remembered, and the migration
  // it forgets is invisible: the suite goes green against a schema that production does
  // not have, which is the one thing these tests exist to rule out.
  const db = client.db('visa_portal_test');
  const dir = join(process.cwd(), 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.ts$/.test(f))
    .sort();

  for (const file of files) {
    const { up } = (await import(pathToFileURL(join(dir, file)).href)) as { up: (db: Db) => Promise<void> };
    await up(db);
  }

  return {
    client,
    dal: await import('@/lib/dal'),
    actor: await import('@/lib/dal/actor'),
    collections: await import('@/lib/db/collections'),
  };
}

export async function stopTestDb(): Promise<void> {
  const { getMongoClient, __setMongoClientForTesting } = await import('@/lib/mongodb');
  const client = await getMongoClient().catch(() => null);
  await client?.close();
  __setMongoClientForTesting(undefined);
  await replSet?.stop();
  replSet = null;
}

/** Empty every collection between tests, leaving indexes and validators in place. */
export async function resetData(client: MongoClient): Promise<void> {
  const db = client.db('visa_portal_test');
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of names) {
    await db.collection(name).deleteMany({});
  }
}

export interface Fixtures {
  adminId: ObjectId;
  agencyA: ObjectId;
  agencyB: ObjectId;
  userA: ObjectId;
  userB: ObjectId;
  routeId: ObjectId;
}

/** Two agencies with a user each, one admin, and one route to hang passports on. */
export async function seedFixtures(ctx: TestContext): Promise<Fixtures> {
  const { adminActor } = ctx.actor;

  // A real user document, the way `npm run create-admin` bootstraps the first one — the
  // session tests resolve a token back to this record, so it has to exist.
  const users = await ctx.collections.users();
  const now = new Date();
  const { insertedId: adminId } = await users.insertOne({
    name: 'The Admin',
    email: 'admin@example.com',
    emailNormalized: 'admin@example.com',
    role: 'admin',
    agencyId: null,
    active: true,
    lastLoginAt: null,
    invitedBy: null,
    invitedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } as never);

  const admin = adminActor(adminId);

  const agencyA = await ctx.dal.createAgency(admin, { name: 'Agency A', defaultCurrency: 'USD' });
  const agencyB = await ctx.dal.createAgency(admin, { name: 'Agency B', defaultCurrency: 'USD' });

  const userA = await ctx.dal.inviteUser(admin, {
    name: 'A Person',
    email: 'a@example.com',
    role: 'agency',
    agencyId: agencyA.id,
  });
  const userB = await ctx.dal.inviteUser(admin, {
    name: 'B Person',
    email: 'b@example.com',
    role: 'agency',
    agencyId: agencyB.id,
  });

  const route = await ctx.dal.createRoute(admin, {
    originCountry: 'EGY',
    destinationCountry: 'FRA',
    appointmentCenter: 'VFS Cairo',
    feeMinor: 12_000,
    feeCurrency: 'USD',
    active: true,
  });

  return {
    adminId: admin.userId!,
    agencyA: new ObjectId(agencyA.id),
    agencyB: new ObjectId(agencyB.id),
    userA: new ObjectId(userA.id),
    userB: new ObjectId(userB.id),
    routeId: new ObjectId(route.id),
  };
}

/** A valid passport payload; override whatever the test is about. */
export function passportInput(routeId: ObjectId, overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Salma',
    lastName: 'Soliman',
    passportNumber: 'A42865745',
    passportExpiryDate: '2032-09-15',
    dateOfBirth: '1995-07-11',
    nationality: 'EGY',
    gender: 'Female' as const,
    routeId: routeId.toHexString(),
    ...overrides,
  };
}
