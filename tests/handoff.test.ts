/**
 * The handoff flow, where records currently go missing.
 *
 * The promises being checked here are the ones that make an interrupted handoff safe:
 * exporting changes nothing, marking as added is deliberate and idempotent, and a passport
 * already handed off cannot be handed off again.
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
const viewingA = () => ({ ...ctx.actor.adminActor(fx.adminId), viewingAsAgencyId: fx.agencyA });

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

/** Create passports and move them to `ready`, which is where the queue starts. */
async function seedReady(count: number, actor = asA(), overrides: Record<string, unknown> = {}) {
  const inputs = Array.from({ length: count }, (_, index) =>
    row(`A1000000${index}`, overrides),
  );
  const batch = await ctx.dal.createPassports(actor, inputs);
  const ids = batch.rows.filter((r) => r.passportId).map((r) => new ObjectId(r.passportId!));
  await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
  return ids;
}

describe('the queue', () => {
  it('holds everything ready but not yet added, across all agencies', async () => {
    await seedReady(2, asA());
    const otherBatch = await ctx.dal.createPassports(asB(), [row('B20000001')]);
    await ctx.dal.changePassportStatuses(
      admin(),
      otherBatch.rows.map((r) => new ObjectId(r.passportId!)),
      'ready',
    );
    // One that is only submitted, so it should not appear yet.
    await ctx.dal.createPassports(asA(), [row('A30000001')]);

    const queue = await ctx.dal.getHandoffQueue(admin());
    const total = queue.reduce((sum, group) => sum + group.entries.length, 0);

    assert.equal(total, 3);
  });

  it('groups by route, because that is how the work is done', async () => {
    const second = await ctx.dal.createRoute(admin(), {
      originCountry: 'EGY',
      destinationCountry: 'DEU',
      appointmentCenter: 'VFS Alexandria',
      feeMinor: 15_000,
      feeCurrency: 'USD',
      active: true,
    });

    await seedReady(2, asA());
    const otherRoute = await ctx.dal.createPassports(asA(), [row('A40000001', { routeId: second.id })]);
    await ctx.dal.changePassportStatuses(
      admin(),
      otherRoute.rows.map((r) => new ObjectId(r.passportId!)),
      'ready',
    );

    const queue = await ctx.dal.getHandoffQueue(admin());
    assert.equal(queue.length, 2);
    assert.deepEqual(
      queue.map((group) => group.entries.length).sort(),
      [1, 2],
    );
    assert.ok(queue.some((group) => group.routeLabel === 'Egypt → Germany · VFS Alexandria'));
  });

  it('shows how long each row has been waiting, and which route is worst', async () => {
    const ids = await seedReady(2);

    // Backdate one submission by twelve days.
    const collection = await ctx.collections.passports();
    await collection.updateOne(
      { _id: ids[0]! },
      { $set: { submittedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000) } },
    );

    const [group] = await ctx.dal.getHandoffQueue(admin());
    assert.equal(group!.oldestWaitingDays, 12);
    assert.ok(group!.entries.some((entry) => entry.waitingDays === 12));
  });

  it('is admin-only, and closed to a view-as session', async () => {
    await assert.rejects(() => ctx.dal.getHandoffQueue(asA()), (error: Error) => error.name === 'ForbiddenError');
    await assert.rejects(
      () => ctx.dal.getHandoffQueue(viewingA()),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });

  it('summarises what is waiting and what is already handed off', async () => {
    const ids = await seedReady(3);
    await ctx.dal.markAsAdded(admin(), [ids[0]!]);

    const summary = await ctx.dal.getHandoffSummary(admin());
    assert.equal(summary.readyCount, 2);
    assert.equal(summary.addedAwaitingBooking, 1);
  });
});

describe('exporting a batch', () => {
  it('changes no statuses at all', async () => {
    const ids = await seedReady(3);

    const before = await ctx.dal.countByStatus(admin());
    await ctx.dal.getExportRecords(admin(), { ids });
    const after = await ctx.dal.countByStatus(admin());

    assert.deepEqual(after, before);
    assert.equal(after.ready, 3);
  });

  it('is safe to run twice — re-exporting the same batch changes nothing', async () => {
    const ids = await seedReady(2);

    const first = await ctx.dal.getExportRecords(admin(), { ids });
    const second = await ctx.dal.getExportRecords(admin(), { ids });

    assert.deepEqual(first.records, second.records);
    assert.equal((await ctx.dal.countByStatus(admin())).ready, 2);
  });

  it('carries only the fields the other system takes, and nothing of ours', async () => {
    const ids = await seedReady(1);
    const { records } = await ctx.dal.getExportRecords(admin(), { ids });

    assert.deepEqual(Object.keys(records[0]!).sort(), [
      'contactEmail',
      'contactNumber',
      'contactNumberDialCode',
      'dateOfBirth',
      'firstName',
      'gender',
      'lastName',
      'nationality',
      'passportExpiryDate',
      'passportNumber',
    ]);
  });

  it('names the route when a batch is all one route, and does not when it is not', async () => {
    const ids = await seedReady(2);
    const single = await ctx.dal.getExportRecords(admin(), { ids });
    assert.equal(single.routeLabel, 'Egypt → France · VFS Cairo');

    const second = await ctx.dal.createRoute(admin(), {
      originCountry: 'EGY',
      destinationCountry: 'ITA',
      appointmentCenter: 'VFS Cairo',
      feeMinor: 10_000,
      feeCurrency: 'USD',
      active: true,
    });
    const extra = await ctx.dal.createPassports(asA(), [row('A50000001', { routeId: second.id })]);
    const mixedIds = [...ids, new ObjectId(extra.rows[0]!.passportId!)];

    const mixed = await ctx.dal.getExportRecords(admin(), { ids: mixedIds });
    assert.equal(mixed.routeLabel, null);
  });

  it('writes every export to the audit log, by id and never by number', async () => {
    const ids = await seedReady(2);
    await ctx.dal.recordExport(admin(), ids, { filename: 'handoff_2026-08-14_x_2.csv', source: 'handoff_queue' });

    const audit = await ctx.collections.auditLog();
    const entry = await audit.findOne({ action: 'passport.export' });

    assert.ok(entry);
    assert.equal((entry.metadata as { count: number }).count, 2);
    assert.equal(JSON.stringify(entry).includes('A10000000'), false);
  });

  it('is refused for an agency and for a view-as session', async () => {
    const ids = await seedReady(1);
    await assert.rejects(
      () => ctx.dal.getExportRecords(asA(), { ids }),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () => ctx.dal.getExportRecords(viewingA(), { ids }),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });
});

describe('marking a batch as added', () => {
  it('moves the whole selection in one action', async () => {
    const ids = await seedReady(4);

    const result = await ctx.dal.markAsAdded(admin(), ids);
    assert.equal(result.marked, 4);

    const counts = await ctx.dal.countByStatus(admin());
    assert.equal(counts.added, 4);
    assert.equal(counts.ready, undefined);
  });

  it('survives a double-click without moving anything twice', async () => {
    const ids = await seedReady(3);

    const [first, second] = await Promise.all([
      ctx.dal.markAsAdded(admin(), ids),
      ctx.dal.markAsAdded(admin(), ids),
    ]);

    // Between them exactly three rows moved, however the race resolved.
    assert.equal(first.marked + second.marked, 3);
    assert.equal((await ctx.dal.countByStatus(admin())).added, 3);
  });

  it('reports a passport that was already added rather than adding it again', async () => {
    const ids = await seedReady(2);
    await ctx.dal.markAsAdded(admin(), [ids[0]!]);

    const result = await ctx.dal.markAsAdded(admin(), ids);
    assert.equal(result.marked, 1);
    assert.equal(result.alreadyAdded.length, 1);
    assert.ok(result.alreadyAdded[0]!.addedAt instanceof Date);
  });

  it('records when it happened and who did it', async () => {
    const ids = await seedReady(1);
    await ctx.dal.markAsAdded(admin(), ids);

    const collection = await ctx.collections.passports();
    const doc = await collection.findOne({ _id: ids[0]! });

    assert.ok(doc!.addedAt instanceof Date);
    assert.equal(doc!.addedBy?.toHexString(), fx.adminId.toHexString());
    assert.equal(doc!.statusHistory.at(-1)!.status, 'added');
    assert.match(doc!.statusHistory.at(-1)!.note ?? '', /handoff export/i);
  });

  it('refuses a passport that is not ready, without failing the rest', async () => {
    const ids = await seedReady(2);
    await ctx.dal.changePassportStatus(admin(), ids[0]!, 'cancelled');

    const result = await ctx.dal.markAsAdded(admin(), ids);
    assert.equal(result.marked, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!.reason, /only passports that are ready/i);
  });

  it('is admin-only, and refused inside a view-as session', async () => {
    const ids = await seedReady(1);
    await assert.rejects(() => ctx.dal.markAsAdded(asA(), ids), (error: Error) => error.name === 'ForbiddenError');
    await assert.rejects(
      () => ctx.dal.markAsAdded(viewingA(), ids),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });

  it('still cannot reach booked — that stays the import path alone', async () => {
    const ids = await seedReady(1);
    await ctx.dal.markAsAdded(admin(), ids);

    await assert.rejects(
      () => ctx.dal.changePassportStatus(admin(), ids[0]!, 'booked'),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});

describe('the export template setting', () => {
  it('falls back to the shipped format until it is edited', async () => {
    const template = await ctx.dal.getExportTemplate();
    assert.equal(template.columns[0]!.header, 'firstName');
    assert.equal(template.columns[7]!.header, 'contactNumber (optional)');
  });

  it('saves an edit and reads it back', async () => {
    await ctx.dal.saveExportTemplate(admin(), {
      columns: [{ header: 'Given Name', source: 'firstName', transform: 'none' }],
      includeBom: true,
      excelTextFormulas: false,
    });

    const template = await ctx.dal.getExportTemplate();
    assert.equal(template.columns.length, 1);
    assert.equal(template.columns[0]!.header, 'Given Name');
  });

  it('is admin-only', async () => {
    await assert.rejects(
      () => ctx.dal.saveExportTemplate(asA(), { columns: [{ header: 'x', source: 'firstName' }] }),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });

  it('refuses a template that would produce an unusable file', async () => {
    await assert.rejects(
      () => ctx.dal.saveExportTemplate(admin(), { columns: [] }),
      (error: Error) => error.name === 'ValidationError',
    );
  });
});
