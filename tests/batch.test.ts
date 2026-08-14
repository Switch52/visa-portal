/**
 * Batch entry: what actually happens when someone pastes thirty rows and two of them are
 * already registered.
 *
 * The promise made on screen is "nothing saves silently and nothing is lost", so these
 * check both halves — the clean rows go through, and every rejected row comes back with a
 * reason attached to its own line.
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

const admin = () => ctx.actor.adminActor(fx.adminId);
const asA = () => ctx.actor.agencyActor(fx.userA, fx.agencyA);
const asB = () => ctx.actor.agencyActor(fx.userB, fx.agencyB);

function row(passportNumber: string, overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Test',
    lastName: 'Person',
    passportNumber,
    passportExpiryDate: '2032-09-15',
    dateOfBirth: '1995-07-11',
    nationality: 'EGY',
    gender: 'Female' as const,
    routeId: fx.routeId.toHexString(),
    ...overrides,
  };
}

describe('saving a batch', () => {
  it('saves the clean rows and rejects only the offending ones', async () => {
    // The one that is already registered, plus one with an expired passport.
    await ctx.dal.createPassport(asB(), row('A11111111'));

    const result = await ctx.dal.createPassports(asA(), [
      row('A22222222'),
      row('A11111111'),
      row('A33333333'),
      row('A44444444', { passportExpiryDate: '2020-01-01' }),
      row('A55555555'),
    ]);

    assert.equal(result.saved, 3);
    assert.equal(result.blocked, 2);

    assert.equal(result.rows[1]!.status, 'blocked');
    assert.match(result.rows[1]!.reason ?? '', /already registered/i);
    assert.equal(result.rows[3]!.status, 'blocked');
    assert.match(JSON.stringify(result.rows[3]!.fieldErrors), /expired/i);

    // And the three good ones are really there.
    assert.equal(await ctx.dal.countPassports(asA()), 3);
  });

  it('reports each rejection against the row it came from', async () => {
    const result = await ctx.dal.createPassports(asA(), [
      row('A22222222'),
      row('A33333333', { nationality: 'XXX' }),
      row('A44444444'),
    ]);

    const blocked = result.rows.filter((r) => r.status === 'blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.index, 1);
  });

  it('blocks a number repeated inside the same paste, naming the earlier row', async () => {
    const result = await ctx.dal.createPassports(asA(), [
      row('A22222222'),
      row('A33333333'),
      row('a2222 2222'), // same number, spaced and lower-cased
    ]);

    assert.equal(result.saved, 2);
    assert.equal(result.rows[2]!.status, 'blocked');
    assert.match(result.rows[2]!.reason ?? '', /row 1 of this batch/);
  });

  it('tells an agency when and what, and never which agency', async () => {
    await ctx.dal.createPassport(asB(), row('A11111111'));

    const result = await ctx.dal.createPassports(asA(), [row('A11111111')]);
    const blocked = result.rows[0]!;

    assert.match(blocked.reason ?? '', /already registered in the system/);
    assert.match(blocked.reason ?? '', /status: submitted/);
    assert.equal(blocked.reason?.includes('Agency B'), false);
    assert.equal(JSON.stringify(blocked).includes('Agency B'), false);
    assert.equal(JSON.stringify(blocked).includes(fx.agencyB.toHexString()), false);
  });

  it('tells the admin which agency has it', async () => {
    await ctx.dal.createPassport(asB(), row('A11111111'));

    const result = await ctx.dal.createPassports(admin(), [row('A11111111')], { agencyId: fx.agencyA });
    assert.match(result.rows[0]!.reason ?? '', /submitted by Agency B/);
  });

  it('records the batch in the audit log with counts and no personal data', async () => {
    await ctx.dal.createPassports(asA(), [row('A22222222'), row('A22222222')]);

    const audit = await ctx.collections.auditLog();
    const entry = await audit.findOne({ action: 'passport.create' });

    assert.ok(entry);
    assert.deepEqual(entry.metadata, { submitted: 2, saved: 1, blocked: 1 });
    assert.equal(JSON.stringify(entry).includes('A22222222'), false);
  });

  it('puts a row with a hold date straight into on_hold', async () => {
    const result = await ctx.dal.createPassports(asA(), [row('A22222222', { holdUntil: '2026-09-27' })]);

    const [saved] = await ctx.dal.listPassports(asA());
    assert.equal(result.saved, 1);
    assert.equal(saved!.status, 'on_hold');
    assert.equal(saved!.holdUntil?.toISOString(), '2026-09-27T00:00:00.000Z');
  });
});

describe('checking duplicates before saving', () => {
  it('finds a number registered by another agency, without naming them', async () => {
    await ctx.dal.createPassport(asB(), row('A11111111'));

    const found = await ctx.dal.checkDuplicates(asA(), ['a1111-1111', 'A99999999']);

    assert.deepEqual(Object.keys(found), ['A11111111']);
    assert.equal(found.A11111111!.status, 'submitted');
    assert.equal(found.A11111111!.agencyName, undefined);
    assert.equal(found.A11111111!.agencyId, undefined);
  });

  it('gives the admin the owning agency', async () => {
    await ctx.dal.createPassport(asB(), row('A11111111'));

    const found = await ctx.dal.checkDuplicates(admin(), ['A11111111']);
    assert.equal(found.A11111111!.agencyName, 'Agency B');
  });
});

describe('editing a passport', () => {
  it('lets an agency fix its own details before booking', async () => {
    const created = await ctx.dal.createPassport(asA(), row('A22222222', { firstName: 'Salmaa' }));

    const updated = await ctx.dal.updatePassport(asA(), new ObjectId(created.id), {
      firstName: 'Salma',
      notes: 'مهم جدا',
    });

    assert.equal(updated.firstName, 'Salma');
    assert.equal(updated.notes, 'مهم جدا');
  });

  it('locks the details once the passport is booked', async () => {
    const created = await ctx.dal.createPassport(asA(), row('A22222222'));
    const id = new ObjectId(created.id);

    await ctx.dal.changePassportStatus(admin(), id, 'ready');
    await ctx.dal.changePassportStatus(admin(), id, 'added');
    await ctx.dal.changePassportStatus(admin(), id, 'booked', { via: 'booking_import' });

    await assert.rejects(
      () => ctx.dal.updatePassport(asA(), id, { firstName: 'Changed' }),
      (error: Error) => error.name === 'ForbiddenError' && /contact us/i.test(error.message),
    );

    // The admin can still correct it.
    const fixed = await ctx.dal.updatePassport(admin(), id, { firstName: 'Changed' });
    assert.equal(fixed.firstName, 'Changed');
  });

  it("refuses an edit to another agency's passport as a not-found", async () => {
    const theirs = await ctx.dal.createPassport(asB(), row('A22222222'));

    await assert.rejects(
      () => ctx.dal.updatePassport(asA(), new ObjectId(theirs.id), { firstName: 'Mine now' }),
      (error: Error) => error.name === 'NotFoundError',
    );
  });

  it('refuses an edit that would make the record invalid', async () => {
    const created = await ctx.dal.createPassport(asA(), row('A22222222'));

    await assert.rejects(
      () => ctx.dal.updatePassport(asA(), new ObjectId(created.id), { passportExpiryDate: '2020-01-01' }),
      (error: Error) => error.name === 'ValidationError',
    );
  });

  it('leaves the passport number where the unique index put it', async () => {
    const created = await ctx.dal.createPassport(asA(), row('A22222222'));

    // There is deliberately no way to pass a new number through the edit path.
    await ctx.dal.updatePassport(asA(), new ObjectId(created.id), {
      firstName: 'Still',
    } as never);

    const after = await ctx.dal.getPassport(asA(), new ObjectId(created.id));
    assert.equal(after.passportNumber, 'A22222222');
  });
});

describe('holds and bulk changes', () => {
  it('brings a hold back into the queue once its date has passed', async () => {
    await ctx.dal.createPassports(asA(), [
      row('A22222222', { holdUntil: '2026-08-01' }), // past
      row('A33333333', { holdUntil: '2027-01-01' }), // still ahead
    ]);

    const released = await ctx.dal.releaseDueHolds(admin(), new Date('2026-08-14T00:00:00Z'));
    assert.equal(released, 1);

    const counts = await ctx.dal.countByStatus(admin());
    assert.equal(counts.submitted, 1);
    assert.equal(counts.on_hold, 1);
  });

  it('changes several at once, and reports the ones that could not move', async () => {
    const batch = await ctx.dal.createPassports(asA(), [row('A22222222'), row('A33333333')]);
    const ids = batch.rows.map((r) => new ObjectId(r.passportId!));

    await ctx.dal.changePassportStatus(admin(), ids[0]!, 'cancelled');

    const result = await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    assert.equal(result.changed, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!.reason, /cannot move from Cancelled/i);
  });

  it('will not bulk-move anything to booked', async () => {
    const batch = await ctx.dal.createPassports(asA(), [row('A22222222')]);
    const ids = batch.rows.map((r) => new ObjectId(r.passportId!));

    await assert.rejects(
      () => ctx.dal.changePassportStatuses(admin(), ids, 'booked'),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});

describe('filters and search', () => {
  beforeEach(async () => {
    await ctx.dal.createPassports(asA(), [
      row('A22222222', { firstName: 'Salma', lastName: 'Soliman' }),
      row('B33333333', { firstName: 'Nourhan', lastName: 'Atteia', nationality: 'PHL' }),
    ]);
    await ctx.dal.createPassports(asB(), [row('C44444444', { firstName: 'Other', lastName: 'Agency' })]);
  });

  it('finds a passport by its number, spacing and case included', async () => {
    const found = await ctx.dal.listPassports(admin(), { search: 'a2222 2222' });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.passportNumber, 'A22222222');
  });

  it('finds a passport by name', async () => {
    const found = await ctx.dal.listPassports(admin(), { search: 'Nour' });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.lastName, 'Atteia');
  });

  it('filters by nationality and by agency', async () => {
    assert.equal((await ctx.dal.listPassports(admin(), { nationality: 'PHL' })).length, 1);
    assert.equal((await ctx.dal.listPassports(admin(), { agencyId: fx.agencyB })).length, 1);
  });

  it('never lets a search cross the agency boundary', async () => {
    // Agency A searching for Agency B's passport number finds nothing at all.
    assert.deepEqual(await ctx.dal.listPassports(asA(), { search: 'C44444444' }), []);
    assert.equal((await ctx.dal.listPassports(asA(), {})).length, 2);
  });
});
