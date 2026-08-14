/**
 * Raising a route's price.
 *
 * Written against the real case: Egypt → Greece is 60 USD today and goes to 70 USD soon.
 * The thing that must hold is that the change applies to future charges only — anything
 * already booked keeps the fee it was booked at, because a ledger that quietly rewrites
 * history is one nobody can argue from.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;
let routeId: ObjectId;

before(async () => {
  ctx = await startTestDb();
});

after(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await resetData(ctx.client);
  fx = await seedFixtures(ctx);

  const route = await ctx.dal.createRoute(ctx.actor.adminActor(fx.adminId), {
    originCountry: 'EGY',
    destinationCountry: 'GRC',
    appointmentCenter: 'VFS Cairo',
    feeMinor: 6_000, // 60.00 USD
    feeCurrency: 'USD',
    active: true,
  });
  routeId = new ObjectId(route.id);
});

const admin = () => ctx.actor.adminActor(fx.adminId);
const asA = () => ctx.actor.agencyActor(fx.userA, fx.agencyA);

function row(passportNumber: string) {
  return {
    firstName: 'Test',
    lastName: 'Person',
    passportNumber,
    passportExpiryDate: '2032-09-15',
    dateOfBirth: '1995-07-11',
    nationality: 'EGY',
    gender: 'Female' as const,
    routeId: routeId.toHexString(),
  };
}

async function bookOne(passportNumber: string, filename: string): Promise<void> {
  const batch = await ctx.dal.createPassports(asA(), [row(passportNumber)]);
  const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));
  await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
  await ctx.dal.markAsAdded(admin(), ids);

  const csv = ['"Passport Number","Appointment Date"', `"${passportNumber}","27/08/2026"`].join('\r\n');
  await ctx.dal.commitImport(admin(), { buffer: Buffer.from(csv, 'utf8'), filename });
}

describe('Egypt → Greece at 60 USD, going to 70', () => {
  it('reads as a route label without anyone reading three columns', async () => {
    // The fixture already has an Egypt → France route, so this picks its own out by id.
    const options = await ctx.dal.listRouteOptions(admin());
    const greece = options.find((option) => option.id === routeId.toHexString());
    assert.equal(greece!.displayLabel, 'Egypt → Greece · VFS Cairo');
  });

  it('charges 60 today', async () => {
    await bookOne('A30000001', 'august.csv');

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(balances[0]!.chargedMinor, 6_000);
  });

  it('charges 70 after the rise, and leaves the 60 already booked alone', async () => {
    await bookOne('A30000001', 'august.csv');

    // The rise, made on the Routes screen.
    await ctx.dal.updateRoute(admin(), routeId, { feeMinor: 7_000 });

    await bookOne('A30000002', 'september.csv');

    const charges = await ctx.collections.charges();
    const amounts = (await charges.find({ voidedAt: null }).sort({ chargedAt: 1 }).toArray()).map(
      (charge) => charge.amountMinor,
    );

    assert.deepEqual(amounts, [6_000, 7_000]);

    // 130.00 owed in total: one at the old price, one at the new.
    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(balances[0]!.chargedMinor, 13_000);
  });

  it('leaves an unbooked passport to be charged at whatever the price is when it books', async () => {
    // Submitted at 60, booked after the rise: the charge follows the booking, not the entry.
    const batch = await ctx.dal.createPassports(asA(), [row('A30000003')]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));
    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    await ctx.dal.markAsAdded(admin(), ids);

    await ctx.dal.updateRoute(admin(), routeId, { feeMinor: 7_000 });

    const csv = ['"Passport Number","Appointment Date"', '"A30000003","27/08/2026"'].join('\r\n');
    await ctx.dal.commitImport(admin(), { buffer: Buffer.from(csv, 'utf8'), filename: 'later.csv' });

    const charges = await ctx.collections.charges();
    const charge = await charges.findOne({ voidedAt: null });
    assert.equal(charge!.amountMinor, 7_000);
  });

  it('records the price change in the audit log, marked as future-only', async () => {
    await ctx.dal.updateRoute(admin(), routeId, { feeMinor: 7_000 });

    const [entry] = await ctx.dal.listAuditEntries(admin(), { action: 'route.update' });
    assert.equal((entry!.before as { feeMinor: number }).feeMinor, 6_000);
    assert.equal((entry!.after as { feeMinor: number }).feeMinor, 7_000);
    assert.match(String((entry!.metadata as { appliesTo: string }).appliesTo), /future charges only/i);
  });

  it('still shows an agency the label and never the price', async () => {
    const options = await ctx.dal.listRouteOptions(asA());
    const greece = options.find((option) => option.id === routeId.toHexString())!;

    assert.equal(greece.displayLabel, 'Egypt → Greece · VFS Cairo');
    assert.equal('feeMinor' in greece, false);

    await assert.rejects(
      () => ctx.dal.listRoutes(asA()),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});
