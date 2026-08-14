/**
 * Two centres, families, and moving one price without moving the other.
 *
 * Written against the real setup: Egypt → Greece runs at Cairo today, Alexandria is set up
 * but not open yet, both at 60 USD, and the rise to 70 needs to be applied to whichever
 * routes it actually covers.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { APPLICATION_TYPE_SIZE, isFamilyType } from '@/config/validation';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;
let cairo: ObjectId;
let alexandria: ObjectId;

before(async () => {
  ctx = await startTestDb();
});

after(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await resetData(ctx.client);
  fx = await seedFixtures(ctx);

  const admin = ctx.actor.adminActor(fx.adminId);
  const cairoRoute = await ctx.dal.createRoute(admin, {
    originCountry: 'EGY',
    destinationCountry: 'GRC',
    appointmentCenter: 'Greece Cairo',
    feeMinor: 6_000,
    feeCurrency: 'USD',
    active: true,
  });
  const alexRoute = await ctx.dal.createRoute(admin, {
    originCountry: 'EGY',
    destinationCountry: 'GRC',
    appointmentCenter: 'Greece Alexandria',
    feeMinor: 6_000,
    feeCurrency: 'USD',
    // Set up, not open for applications yet.
    active: false,
  });

  cairo = new ObjectId(cairoRoute.id);
  alexandria = new ObjectId(alexRoute.id);
});

const admin = () => ctx.actor.adminActor(fx.adminId);
const asA = () => ctx.actor.agencyActor(fx.userA, fx.agencyA);

function row(passportNumber: string, routeId: ObjectId, overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Test',
    lastName: 'Person',
    passportNumber,
    passportExpiryDate: '2032-09-15',
    dateOfBirth: '1995-07-11',
    nationality: 'EGY',
    gender: 'Female' as const,
    routeId: routeId.toHexString(),
    ...overrides,
  };
}

describe('two centres on the same country pair', () => {
  it('are two separate routes, priced separately', async () => {
    const routes = await ctx.dal.listRoutes(admin());
    const greece = routes.filter((route) => route.destinationCountry === 'GRC');

    assert.equal(greece.length, 2);
    assert.deepEqual(
      greece.map((route) => route.displayLabel).sort(),
      ['Egypt → Greece · Greece Alexandria', 'Egypt → Greece · Greece Cairo'],
    );
  });

  it('offers only the open one to an agency', async () => {
    const options = await ctx.dal.listRouteOptions(asA());
    const labels = options.map((option) => option.displayLabel);

    assert.ok(labels.includes('Egypt → Greece · Greece Cairo'));
    assert.equal(labels.includes('Egypt → Greece · Greece Alexandria'), false);
  });

  it('refuses a passport filed against a route that is not open', async () => {
    const result = await ctx.dal.createPassports(asA(), [row('A40000001', alexandria)]);

    assert.equal(result.saved, 0);
    assert.match(JSON.stringify(result.rows[0]!.fieldErrors), /not available/i);
  });

  it('keeps each centre’s passports in its own group in the handoff queue', async () => {
    await ctx.dal.updateRoute(admin(), alexandria, { active: true });

    const batch = await ctx.dal.createPassports(asA(), [
      row('A40000001', cairo),
      row('A40000002', cairo),
      row('A40000003', alexandria),
    ]);
    await ctx.dal.changePassportStatuses(
      admin(),
      batch.rows.map((entry) => new ObjectId(entry.passportId!)),
      'ready',
    );

    const queue = await ctx.dal.getHandoffQueue(admin());
    const byLabel = Object.fromEntries(queue.map((group) => [group.routeLabel, group.entries.length]));

    assert.equal(byLabel['Egypt → Greece · Greece Cairo'], 2);
    assert.equal(byLabel['Egypt → Greece · Greece Alexandria'], 1);
  });
});

describe('changing a price on chosen routes only', () => {
  it('moves the one picked and leaves the other alone', async () => {
    const result = await ctx.dal.repriceRoutes(admin(), [cairo], { amountMinor: 7_000, currency: 'USD' });

    assert.equal(result.updated.length, 1);
    assert.equal(result.updated[0]!.fromMinor, 6_000);
    assert.equal(result.updated[0]!.toMinor, 7_000);

    const routes = await ctx.dal.listRoutes(admin());
    assert.equal(routes.find((route) => route.id === cairo.toHexString())!.feeMinor, 7_000);
    assert.equal(routes.find((route) => route.id === alexandria.toHexString())!.feeMinor, 6_000);
  });

  it('moves several together when they are all picked', async () => {
    const result = await ctx.dal.repriceRoutes(admin(), [cairo, alexandria], {
      amountMinor: 7_000,
      currency: 'USD',
    });

    assert.equal(result.updated.length, 2);
    const routes = await ctx.dal.listRoutes(admin());
    assert.ok(
      routes
        .filter((route) => route.destinationCountry === 'GRC')
        .every((route) => route.feeMinor === 7_000),
    );
  });

  it('says nothing changed when a route is already at that price', async () => {
    await ctx.dal.repriceRoutes(admin(), [cairo], { amountMinor: 7_000, currency: 'USD' });
    const again = await ctx.dal.repriceRoutes(admin(), [cairo], { amountMinor: 7_000, currency: 'USD' });

    assert.equal(again.updated.length, 0);
    assert.equal(again.unchanged.length, 1);
    assert.match(again.unchanged[0]!.reason, /already at that price/i);
  });

  it('leaves charges already raised at the old price', async () => {
    // Book one at 60 through Cairo.
    const batch = await ctx.dal.createPassports(asA(), [row('A40000001', cairo)]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));
    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    await ctx.dal.markAsAdded(admin(), ids);
    await ctx.dal.commitImport(admin(), {
      buffer: Buffer.from('"Passport Number","Appointment Date"\r\n"A40000001","27/08/2026"', 'utf8'),
      filename: 'august.csv',
    });

    await ctx.dal.repriceRoutes(admin(), [cairo, alexandria], { amountMinor: 7_000, currency: 'USD' });

    const charges = await ctx.collections.charges();
    const charge = await charges.findOne({ voidedAt: null });
    assert.equal(charge!.amountMinor, 6_000);
  });

  it('is admin-only, and refuses an empty selection', async () => {
    await assert.rejects(
      () => ctx.dal.repriceRoutes(asA(), [cairo], { amountMinor: 7_000, currency: 'USD' }),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () => ctx.dal.repriceRoutes(admin(), [], { amountMinor: 7_000, currency: 'USD' }),
      (error: Error) => error.name === 'ValidationError',
    );
  });
});

describe('families', () => {
  it('knows how many people each application type covers', () => {
    assert.equal(APPLICATION_TYPE_SIZE.single, 1);
    assert.equal(APPLICATION_TYPE_SIZE.family_2, 2);
    assert.equal(APPLICATION_TYPE_SIZE.family_4, 4);
    assert.equal(isFamilyType('single'), false);
    assert.equal(isFamilyType('family_4'), true);
  });

  it('saves a family as several passports sharing one group', async () => {
    const groupRef = 'fam_abc123';
    const result = await ctx.dal.createPassports(asA(), [
      row('A40000001', cairo, { applicationType: 'family_2', groupRef }),
      row('A40000002', cairo, { applicationType: 'family_2', groupRef }),
    ]);

    assert.equal(result.saved, 2);

    const saved = await ctx.dal.listPassports(asA());
    assert.ok(saved.every((passport) => passport.applicationType === 'family_2'));
    assert.ok(saved.every((passport) => passport.groupRef === groupRef));
  });

  it('charges each member of a family its own booking fee', async () => {
    const groupRef = 'fam_abc123';
    const batch = await ctx.dal.createPassports(asA(), [
      row('A40000001', cairo, { applicationType: 'family_2', groupRef }),
      row('A40000002', cairo, { applicationType: 'family_2', groupRef }),
    ]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));

    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    await ctx.dal.markAsAdded(admin(), ids);
    await ctx.dal.commitImport(admin(), {
      buffer: Buffer.from(
        '"Passport Number","Appointment Date"\r\n"A40000001","27/08/2026"\r\n"A40000002","27/08/2026"',
        'utf8',
      ),
      filename: 'family.csv',
    });

    // Two people, two charges at 60. Whether a family should instead pay once is a pricing
    // decision, not a technical one — this pins today's behaviour so a change is deliberate.
    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(balances[0]!.chargedMinor, 12_000);
  });

  it('keeps a single applicant out of any group', async () => {
    await ctx.dal.createPassports(asA(), [row('A40000003', cairo)]);

    const [saved] = await ctx.dal.listPassports(asA());
    assert.equal(saved!.applicationType, 'single');
    assert.equal(saved!.groupRef, null);
  });

  it('refuses an application type the database does not know', async () => {
    const result = await ctx.dal.createPassports(asA(), [
      row('A40000004', cairo, { applicationType: 'family_3' }),
    ]);

    assert.equal(result.saved, 0);
    assert.equal(result.rows[0]!.status, 'blocked');
  });

  it('lets a family be found and exported together', async () => {
    const groupRef = 'fam_abc123';
    const batch = await ctx.dal.createPassports(asA(), [
      row('A40000001', cairo, { applicationType: 'family_2', groupRef }),
      row('A40000002', cairo, { applicationType: 'family_2', groupRef }),
      row('A40000005', cairo),
    ]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));
    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');

    const passports = await ctx.collections.passports();
    const family = await passports.find({ groupRef }).toArray();
    assert.equal(family.length, 2);

    // And they leave in the same export as everyone else, with nothing of ours attached.
    const { records } = await ctx.dal.getExportRecords(admin(), { ids });
    assert.equal(records.length, 3);
    assert.equal(JSON.stringify(records).includes('groupRef'), false);
    assert.equal(JSON.stringify(records).includes('family_2'), false);
  });
});
