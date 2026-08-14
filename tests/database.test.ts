/**
 * The rules that must hold even when the write does not come from the app — a migration
 * script, a bulk import, or the Atlas console at midnight.
 *
 * Every write in this file goes straight to the driver, deliberately bypassing the DAL
 * and its Zod schemas. If a test here passes, the guarantee is in the database itself.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;

before(async () => {
  ctx = await startTestDb();
});

after(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await resetData(ctx.client);
  fx = await seedFixtures(ctx);
});

function passportDoc(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    firstName: 'Test',
    lastName: 'Person',
    passportNumber: 'A11111111',
    passportNumberNormalized: 'A11111111',
    passportExpiryDate: new Date(Date.UTC(2032, 0, 1)),
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    nationality: 'EGY',
    gender: 'Male',
    agencyId: fx.agencyA,
    routeId: fx.routeId,
    submittedAt: now,
    submittedBy: null,
    applicationType: 'single',
    priority: 'normal',
    holdUntil: null,
    notes: null,
    status: 'submitted',
    statusHistory: [{ status: 'submitted', at: now, actorId: null, actorRole: 'system', via: 'migration' }],
    addedAt: null,
    addedBy: null,
    bookingId: null,
    source: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('unique indexes', () => {
  it('refuses a second passport with the same normalized number, driver-direct', async () => {
    const passports = await ctx.collections.passports();
    await passports.insertOne(passportDoc() as never);

    await assert.rejects(
      () => passports.insertOne(passportDoc({ agencyId: fx.agencyB, _id: new ObjectId() }) as never),
      (error: { code?: number }) => error.code === 11000,
    );
  });

  it('refuses a duplicate route triple', async () => {
    const routes = await ctx.collections.routes();
    const now = new Date();
    const doc = {
      originCountry: 'EGY',
      destinationCountry: 'FRA',
      appointmentCenter: 'VFS Cairo',
      centerNormalized: 'vfs cairo',
      displayLabel: 'Egypt → France · VFS Cairo',
      feeMinor: 100,
      feeCurrency: 'USD',
      active: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    await assert.rejects(
      () => routes.insertOne(doc as never),
      (error: { code?: number }) => error.code === 11000,
    );

    // The same pair at a different center is a different route, and is allowed.
    await routes.insertOne({ ...doc, appointmentCenter: 'VFS Alexandria', centerNormalized: 'vfs alexandria' } as never);
  });

  it('refuses a duplicate user email', async () => {
    const users = await ctx.collections.users();
    const now = new Date();
    await assert.rejects(
      () =>
        users.insertOne({
          name: 'Impostor',
          email: 'A@Example.com',
          emailNormalized: 'a@example.com',
          role: 'agency',
          agencyId: fx.agencyB,
          active: true,
          createdAt: now,
          updatedAt: now,
        } as never),
      (error: { code?: number }) => error.code === 11000,
    );
  });

  it('refuses two passports pointing at the same booking', async () => {
    const passports = await ctx.collections.passports();
    const bookingId = new ObjectId();

    await passports.insertOne(passportDoc({ bookingId, status: 'booked' }) as never);
    await assert.rejects(
      () =>
        passports.insertOne(
          passportDoc({ bookingId, status: 'booked', passportNumberNormalized: 'A22222222', passportNumber: 'A22222222' }) as never,
        ),
      (error: { code?: number }) => error.code === 11000,
    );
  });
});

describe('$jsonSchema validators', () => {
  it('rejects a passport with no passport number', async () => {
    const passports = await ctx.collections.passports();
    const doc = passportDoc() as Record<string, unknown>;
    delete doc.passportNumberNormalized;

    await assert.rejects(
      () => passports.insertOne(doc as never),
      (error: Error) => error.name === 'MongoServerError',
    );
  });

  it('rejects a nationality that is not an alpha-3 code', async () => {
    const passports = await ctx.collections.passports();
    await assert.rejects(() => passports.insertOne(passportDoc({ nationality: 'Egypt' }) as never));
  });

  it('rejects a gender the main dashboard would not accept', async () => {
    const passports = await ctx.collections.passports();
    await assert.rejects(() => passports.insertOne(passportDoc({ gender: 'M' }) as never));
  });

  it('rejects a status that is not in the flow', async () => {
    const passports = await ctx.collections.passports();
    await assert.rejects(() => passports.insertOne(passportDoc({ status: 'in_progress' }) as never));
  });

  it('rejects a date stored as a string', async () => {
    const passports = await ctx.collections.passports();
    await assert.rejects(() => passports.insertOne(passportDoc({ dateOfBirth: '1990-01-01' }) as never));
  });

  it('rejects a route fee that is not an integer', async () => {
    const routes = await ctx.collections.routes();
    const now = new Date();
    await assert.rejects(() =>
      routes.insertOne({
        originCountry: 'EGY',
        destinationCountry: 'DEU',
        appointmentCenter: 'VFS Cairo',
        centerNormalized: 'vfs cairo',
        displayLabel: 'Egypt → Germany · VFS Cairo',
        feeMinor: 120.5,
        feeCurrency: 'USD',
        active: true,
        createdAt: now,
        updatedAt: now,
      } as never),
    );
  });

  it('rejects a fee currency that is not on the list', async () => {
    const routes = await ctx.collections.routes();
    const now = new Date();
    await assert.rejects(() =>
      routes.insertOne({
        originCountry: 'EGY',
        destinationCountry: 'ITA',
        appointmentCenter: 'VFS Cairo',
        centerNormalized: 'vfs cairo',
        displayLabel: 'Egypt → Italy · VFS Cairo',
        feeMinor: 100,
        feeCurrency: 'XYZ',
        active: true,
        createdAt: now,
        updatedAt: now,
      } as never),
    );
  });

  it('rejects an agency user with no agency, and an admin with one', async () => {
    const users = await ctx.collections.users();
    const now = new Date();
    const base = { active: true, createdAt: now, updatedAt: now };

    await assert.rejects(() =>
      users.insertOne({
        ...base,
        name: 'Orphan',
        email: 'orphan@example.com',
        emailNormalized: 'orphan@example.com',
        role: 'agency',
        agencyId: null,
      } as never),
    );

    await assert.rejects(() =>
      users.insertOne({
        ...base,
        name: 'Confused',
        email: 'confused@example.com',
        emailNormalized: 'confused@example.com',
        role: 'admin',
        agencyId: fx.agencyA,
      } as never),
    );
  });
});

describe('stored shapes', () => {
  it('stores date-only values at midnight UTC so a timezone cannot move them', async () => {
    const created = await ctx.dal.createPassport(ctx.actor.agencyActor(fx.userA, fx.agencyA), {
      firstName: 'Nour',
      lastName: 'Badawy',
      passportNumber: 'A37628038',
      passportExpiryDate: '2031-05-08',
      dateOfBirth: '2007-02-07',
      nationality: 'EGY',
      gender: 'Female',
      routeId: fx.routeId.toHexString(),
    });

    const passports = await ctx.collections.passports();
    const doc = await passports.findOne({ _id: new ObjectId(created.id) });

    assert.equal(doc!.dateOfBirth.toISOString(), '2007-02-07T00:00:00.000Z');
    assert.equal(doc!.passportExpiryDate.toISOString(), '2031-05-08T00:00:00.000Z');
  });

  it('stores the normalized passport number beside the original as typed', async () => {
    const created = await ctx.dal.createPassport(ctx.actor.agencyActor(fx.userA, fx.agencyA), {
      firstName: 'Test',
      lastName: 'Person',
      passportNumber: ' a45-386 663 ',
      passportExpiryDate: '2033-06-21',
      dateOfBirth: '1990-01-01',
      nationality: 'EGY',
      gender: 'Male',
      routeId: fx.routeId.toHexString(),
    });

    const passports = await ctx.collections.passports();
    const doc = await passports.findOne({ _id: new ObjectId(created.id) });

    assert.equal(doc!.passportNumber, 'a45-386 663');
    assert.equal(doc!.passportNumberNormalized, 'A45386663');
  });

  it('never writes a passport number or a name into the audit log', async () => {
    const agency = ctx.actor.agencyActor(fx.userA, fx.agencyA);
    await ctx.dal.createPassport(agency, {
      firstName: 'Salma',
      lastName: 'Soliman',
      passportNumber: 'A42865745',
      passportExpiryDate: '2032-09-15',
      dateOfBirth: '1995-07-11',
      nationality: 'EGY',
      gender: 'Female',
      routeId: fx.routeId.toHexString(),
    });

    // A blocked duplicate is the entry most likely to carry one by accident.
    await assert.rejects(() =>
      ctx.dal.createPassport(ctx.actor.agencyActor(fx.userB, fx.agencyB), {
        firstName: 'Salma',
        lastName: 'Soliman',
        passportNumber: 'A42865745',
        passportExpiryDate: '2032-09-15',
        dateOfBirth: '1995-07-11',
        nationality: 'EGY',
        gender: 'Female',
        routeId: fx.routeId.toHexString(),
      }),
    );

    const audit = await ctx.collections.auditLog();
    const entries = await audit.find({}).toArray();
    const serialized = JSON.stringify(entries);

    assert.equal(serialized.includes('A42865745'), false);
    assert.equal(serialized.includes('Salma'), false);
    assert.equal(serialized.includes('1995-07-11'), false);
    assert.ok(entries.some((entry) => entry.action === 'passport.duplicate_blocked'));
  });
});
