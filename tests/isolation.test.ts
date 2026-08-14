/**
 * The tests that are the reason to trust the system.
 *
 * Not "does the app work" — these prove that cross-agency reads fail, that a duplicate
 * passport cannot be inserted even concurrently, that only a booking import can set
 * `booked`, and that a view-as session cannot write.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import {
  passportInput,
  resetData,
  seedFixtures,
  startTestDb,
  stopTestDb,
  type Fixtures,
  type TestContext,
} from './helpers/db';

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

const admin = () => ctx.actor.adminActor(fx.adminId);
const asA = () => ctx.actor.agencyActor(fx.userA, fx.agencyA);
const asB = () => ctx.actor.agencyActor(fx.userB, fx.agencyB);

describe('agency isolation', () => {
  it('an agency listing passports sees only its own', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));
    await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    const seenByA = await ctx.dal.listPassports(asA());
    const seenByB = await ctx.dal.listPassports(asB());

    assert.equal(seenByA.length, 1);
    assert.equal(seenByA[0]!.passportNumber, 'A1000001');
    assert.equal(seenByB.length, 1);
    assert.equal(seenByB[0]!.passportNumber, 'B2000002');
  });

  it("reading another agency's passport by id is a not-found, not a forbidden", async () => {
    const theirs = await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    // The distinction matters: "forbidden" would confirm the record exists.
    await assert.rejects(
      () => ctx.dal.getPassport(asA(), new ObjectId(theirs.id)),
      (error: Error) => error.name === 'NotFoundError',
    );
  });

  it('asking for another agency by id in a filter cannot widen the scope', async () => {
    await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    const results = await ctx.dal.listPassports(asA(), { agencyId: fx.agencyB });
    assert.deepEqual(results, []);
  });

  it('counts are scoped too, so no number can imply another agency exists', async () => {
    await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    assert.equal(await ctx.dal.countPassports(asA()), 0);
    assert.equal(await ctx.dal.countPassports(admin()), 1);
  });

  it('an agency cannot change another agency’s passport status', async () => {
    const theirs = await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    await assert.rejects(
      () => ctx.dal.changePassportStatus(asA(), new ObjectId(theirs.id), 'cancelled'),
      (error: Error) => error.name === 'NotFoundError',
    );
  });

  it('an agency sees only its own colleagues, and cannot resolve a user elsewhere', async () => {
    const users = await ctx.dal.listUsers(asA());
    assert.deepEqual(
      users.map((u) => u.email),
      ['a@example.com'],
    );

    await assert.rejects(
      () => ctx.dal.getUser(asA(), fx.userB),
      (error: Error) => error.name === 'NotFoundError',
    );
  });

  it('an agency cannot list agencies, or read another agency record', async () => {
    await assert.rejects(() => ctx.dal.listAgencies(asA()), (error: Error) => error.name === 'ForbiddenError');
    await assert.rejects(
      () => ctx.dal.getAgency(asA(), fx.agencyB),
      (error: Error) => error.name === 'NotFoundError',
    );

    // Its own record is fine.
    const own = await ctx.dal.getAgency(asA(), fx.agencyA);
    assert.equal(own.name, 'Agency A');
  });

  it('an agency never receives an agencyId in a passport payload', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));

    const [mine] = await ctx.dal.listPassports(asA());
    assert.equal(mine!.agencyId, undefined);

    const [asAdmin] = await ctx.dal.listPassports(admin());
    assert.equal(asAdmin!.agencyId, fx.agencyA.toHexString());
  });
});

describe('routes and pricing are admin-only', () => {
  it('an agency cannot create, list or read routes with fees', async () => {
    await assert.rejects(() => ctx.dal.listRoutes(asA()), (error: Error) => error.name === 'ForbiddenError');
    await assert.rejects(
      () => ctx.dal.getRoute(asA(), fx.routeId),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () =>
        ctx.dal.createRoute(asA(), {
          originCountry: 'EGY',
          destinationCountry: 'DEU',
          appointmentCenter: 'VFS Cairo',
          feeMinor: 1,
          feeCurrency: 'USD',
          active: true,
        }),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });

  it('the route options an agency can see carry a label and no fee', async () => {
    const options = await ctx.dal.listRouteOptions(asA());
    assert.equal(options.length, 1);
    assert.equal(options[0]!.displayLabel, 'Egypt → France · VFS Cairo');
    assert.equal('feeMinor' in options[0]!, false);
    assert.equal('feeCurrency' in options[0]!, false);
  });
});

describe('the duplicate passport rule', () => {
  it('blocks a duplicate across agencies, and does not save it', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A42865745' }));

    await assert.rejects(
      () => ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'A42865745' })),
      (error: Error) => error.name === 'DuplicatePassportError',
    );

    assert.equal(await ctx.dal.countPassports(admin()), 1);
  });

  it('matches on the normalized number, so spacing and case cannot slip one through', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A42865745' }));

    await assert.rejects(
      () => ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: ' a42-865 745 ' })),
      (error: Error) => error.name === 'DuplicatePassportError',
    );
  });

  it('tells an agency when and what, and never who', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A42865745' }));

    await assert.rejects(
      () => ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'A42865745' })),
      (error: Error) => {
        const detail = (error as unknown as { detail: Record<string, unknown> }).detail;
        assert.ok(detail.submittedAt instanceof Date);
        assert.equal(detail.status, 'submitted');
        // The whole payload, not just the message, is free of the other agency.
        assert.equal(detail.agencyName, undefined);
        assert.equal(detail.agencyId, undefined);
        assert.equal(JSON.stringify(detail).includes('Agency A'), false);
        return true;
      },
    );
  });

  it('tells the admin who submitted it first', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A42865745' }));

    await assert.rejects(
      () => ctx.dal.createPassport(admin(), passportInput(fx.routeId, { passportNumber: 'A42865745' }), { agencyId: fx.agencyB }),
      (error: Error) => {
        const detail = (error as unknown as { detail: Record<string, unknown> }).detail;
        assert.equal(detail.agencyName, 'Agency A');
        assert.equal(detail.agencyId, fx.agencyA.toHexString());
        return true;
      },
    );
  });

  it('two simultaneous submissions cannot both succeed', async () => {
    // The application check would let both through; the unique index is what decides.
    const results = await Promise.allSettled([
      ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A99999999' })),
      ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'A99999999' })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(await ctx.dal.countPassports(admin()), 1);
  });
});

describe('booked is import-only', () => {
  it('refuses a manual move to booked, from an admin as much as an agency', async () => {
    const created = await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));
    const id = new ObjectId(created.id);

    await ctx.dal.changePassportStatus(admin(), id, 'ready');
    await ctx.dal.changePassportStatus(admin(), id, 'added');

    await assert.rejects(
      () => ctx.dal.changePassportStatus(admin(), id, 'booked'),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () => ctx.dal.changePassportStatus(asA(), id, 'booked'),
      (error: Error) => error.name === 'ForbiddenError',
    );

    const after = await ctx.dal.getPassport(admin(), id);
    assert.equal(after.status, 'added');
  });

  it('allows it through the booking-import path, and records the history', async () => {
    const created = await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));
    const id = new ObjectId(created.id);

    await ctx.dal.changePassportStatus(admin(), id, 'ready');
    await ctx.dal.changePassportStatus(admin(), id, 'added');
    const booked = await ctx.dal.changePassportStatus(admin(), id, 'booked', { via: 'booking_import' });

    assert.equal(booked.status, 'booked');

    const passports = await ctx.collections.passports();
    const doc = await passports.findOne({ _id: id });
    assert.deepEqual(
      doc!.statusHistory.map((entry) => entry.status),
      ['submitted', 'ready', 'added', 'booked'],
    );
  });

  it('refuses a status jump the flow does not allow', async () => {
    const created = await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));

    await assert.rejects(
      () => ctx.dal.changePassportStatus(admin(), new ObjectId(created.id), 'completed'),
      (error: Error) => error.name === 'ValidationError',
    );
  });
});

describe('view-as is read-only', () => {
  const viewingA = () => ({ ...ctx.actor.adminActor(fx.adminId), viewingAsAgencyId: fx.agencyA });

  it('reads exactly what the agency reads', async () => {
    await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));
    await ctx.dal.createPassport(asB(), passportInput(fx.routeId, { passportNumber: 'B2000002' }));

    const seen = await ctx.dal.listPassports(viewingA());
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.passportNumber, 'A1000001');
    assert.equal(seen[0]!.agencyId, undefined);
  });

  it('cannot write anything', async () => {
    const created = await ctx.dal.createPassport(asA(), passportInput(fx.routeId, { passportNumber: 'A1000001' }));

    await assert.rejects(
      () => ctx.dal.changePassportStatus(viewingA(), new ObjectId(created.id), 'cancelled'),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
    await assert.rejects(
      () => ctx.dal.createPassport(viewingA(), passportInput(fx.routeId, { passportNumber: 'A3000003' })),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
    await assert.rejects(
      () => ctx.dal.inviteUser(viewingA(), { name: 'X', email: 'x@example.com', role: 'admin', agencyId: null }),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });

  it('cannot enumerate the client list while in an agency view', async () => {
    await assert.rejects(
      () => ctx.dal.listAgencies(viewingA()),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});
