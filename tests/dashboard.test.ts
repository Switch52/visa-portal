/**
 * Dashboards, the audit log, and notifications.
 *
 * The dashboards are where a scoping mistake would be least visible and most damaging — a
 * count is just a number on a tile, and nobody would notice it was counting somebody
 * else's passports. So these check the numbers themselves, agency by agency.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;
let notifications: typeof import('@/lib/notifications');

before(async () => {
  ctx = await startTestDb();
  notifications = await import('@/lib/notifications');
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

describe('the admin dashboard', () => {
  it('counts across every agency', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001'), row('A10000002')]);
    await ctx.dal.createPassports(asB(), [row('B20000001')]);

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.equal(dashboard.submittedToday, 3);
    assert.equal(dashboard.submittedThisWeek, 3);
  });

  it('separates ready-to-hand-off from added-but-not-booked', async () => {
    const batch = await ctx.dal.createPassports(asA(), [row('A10000001'), row('A10000002')]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));

    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    await ctx.dal.markAsAdded(admin(), [ids[0]!]);

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.equal(dashboard.readyToHandOff, 1);
    assert.equal(dashboard.addedAwaitingBooking, 1);
  });

  it('flags holds whose date has passed', async () => {
    await ctx.dal.createPassports(asA(), [
      row('A10000001', { holdUntil: '2026-08-01' }),
      row('A10000002', { holdUntil: '2027-01-01' }),
    ]);

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.equal(dashboard.onHold, 2);
    assert.equal(dashboard.holdsDueToday, 1);
  });

  it('counts blocked duplicates, and says which crossed agencies', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001')]);
    // Same agency trying again, then a different agency.
    await ctx.dal.createPassports(asA(), [row('A10000001')]);
    await ctx.dal.createPassports(asB(), [row('A10000001')]);

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.equal(dashboard.blockedDuplicates, 2);
    assert.equal(dashboard.crossAgencyDuplicates, 1);
  });

  it('shows outstanding per currency, with no combined figure', async () => {
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 40_000,
      currency: 'USD',
      description: 'Opening',
    });
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyB.toHexString(),
      amountMinor: 25_000,
      currency: 'EUR',
      description: 'Opening',
    });

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.deepEqual(
      dashboard.balances.map((balance) => [balance.currency, balance.outstandingMinor]),
      [
        ['EUR', 25_000],
        ['USD', 40_000],
      ],
    );
  });

  it('carries a recent activity feed', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001')]);

    const dashboard = await ctx.dal.getAdminDashboard(admin());
    assert.ok(dashboard.activity.length > 0);
    assert.ok(dashboard.activity.some((entry) => entry.action === 'passport.create'));
  });

  it('is refused to an agency, and to a view-as session', async () => {
    await assert.rejects(
      () => ctx.dal.getAdminDashboard(asA()),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () => ctx.dal.getAdminDashboard(viewingA()),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });
});

describe('the agency dashboard', () => {
  it('counts only that agency’s passports', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001'), row('A10000002')]);
    await ctx.dal.createPassports(asB(), [row('B20000001')]);

    const forA = await ctx.dal.getAgencyDashboard(asA());
    const forB = await ctx.dal.getAgencyDashboard(asB());

    assert.equal(forA.byStatus.submitted, 2);
    assert.equal(forB.byStatus.submitted, 1);
    assert.equal(forA.submittedThisWeek, 2);
  });

  it('shows their own balance and nobody else’s', async () => {
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 40_000,
      currency: 'USD',
      description: 'Opening',
    });
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyB.toHexString(),
      amountMinor: 99_000,
      currency: 'USD',
      description: 'Opening',
    });

    const forA = await ctx.dal.getAgencyDashboard(asA());
    assert.equal(forA.balances.length, 1);
    assert.equal(forA.balances[0]!.outstandingMinor, 40_000);
  });

  it('surfaces holds whose date has passed as something to act on', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001', { holdUntil: '2026-08-01' })]);

    const dashboard = await ctx.dal.getAgencyDashboard(asA());
    assert.ok(dashboard.attention.some((item) => /hold/i.test(item.label) && item.count === 1));
  });

  it('gives an admin in a view-as session exactly the agency’s figures', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001')]);
    await ctx.dal.createPassports(asB(), [row('B20000001'), row('B20000002')]);

    const viewed = await ctx.dal.getAgencyDashboard(viewingA());
    assert.equal(viewed.byStatus.submitted, 1);
  });
});

describe('the agencies list', () => {
  it('shows per-agency counts and balances, and no cross-contamination', async () => {
    const batch = await ctx.dal.createPassports(asA(), [row('A10000001'), row('A10000002')]);
    await ctx.dal.createPassports(asB(), [row('B20000001', { holdUntil: '2027-01-01' })]);
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 40_000,
      currency: 'USD',
      description: 'Opening',
    });

    const rows = await ctx.dal.getAgencyRows(admin());
    const rowA = rows.find((entry) => entry.name === 'Agency A')!;
    const rowB = rows.find((entry) => entry.name === 'Agency B')!;

    assert.equal(rowA.submitted, 2);
    assert.equal(rowA.balances[0]!.outstandingMinor, 40_000);
    assert.equal(rowB.submitted, 1);
    assert.equal(rowB.onHold, 1);
    assert.equal(rowB.balances.length, 0);
    assert.equal(batch.saved, 2);
  });

  it('is admin-only', async () => {
    await assert.rejects(
      () => ctx.dal.getAgencyRows(asA()),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});

describe('reading the audit log', () => {
  it('is admin-only — there is no agency-scoped version of it', async () => {
    await assert.rejects(
      () => ctx.dal.listAuditEntries(asA()),
      (error: Error) => error.name === 'ForbiddenError',
    );
    await assert.rejects(
      () => ctx.dal.listAuditEntries(viewingA()),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });

  it('filters by action and by agency', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001')]);
    await ctx.dal.createPassports(asB(), [row('B20000001')]);

    const created = await ctx.dal.listAuditEntries(admin(), { action: 'passport.create' });
    assert.equal(created.length, 2);

    const forA = await ctx.dal.listAuditEntries(admin(), { action: 'passport.create', agencyId: fx.agencyA });
    assert.equal(forA.length, 1);
  });

  it('carries no passport numbers, names or dates of birth', async () => {
    await ctx.dal.createPassports(asA(), [row('A10000001', { firstName: 'Salma', lastName: 'Soliman' })]);
    await ctx.dal.createPassports(asB(), [row('A10000001')]); // blocked duplicate

    const entries = await ctx.dal.listAuditEntries(admin());
    const serialized = JSON.stringify(entries);

    assert.equal(serialized.includes('A10000001'), false);
    assert.equal(serialized.includes('Salma'), false);
    assert.equal(serialized.includes('1995-07-11'), false);
  });

  it('records both ends of a view-as session', async () => {
    // Written the way the server action writes them.
    await ctx.dal.writeAudit(admin(), { action: 'viewas.start', entity: 'agency', agencyId: fx.agencyA });
    await ctx.dal.writeAudit(admin(), { action: 'viewas.end', entity: 'agency', agencyId: fx.agencyA });

    const entries = await ctx.dal.listAuditEntries(admin(), { entity: 'agency' });
    assert.ok(entries.some((entry) => entry.action === 'viewas.start'));
    assert.ok(entries.some((entry) => entry.action === 'viewas.end'));
  });

  it('marks anything done inside a view-as session as done on behalf of that agency', async () => {
    await ctx.dal.writeAudit(viewingA(), { action: 'passport.export', entity: 'passport' });

    const [entry] = await ctx.dal.listAuditEntries(admin(), { action: 'passport.export' });
    assert.equal(entry!.onBehalfOfAgencyId, fx.agencyA.toHexString());
  });
});

describe('notifications', () => {
  it('are off by default only when switched off, and settings persist', async () => {
    const before = await notifications.getNotificationSettings();
    assert.equal(before['passports.booked'], true);

    await notifications.saveNotificationSettings(admin(), { 'passports.booked': false });
    const after = await notifications.getNotificationSettings();
    assert.equal(after['passports.booked'], false);
    assert.equal(after['user.invited'], true);
  });

  it('are admin-only to change', async () => {
    await assert.rejects(
      () => notifications.saveNotificationSettings(asA(), { 'user.invited': false }),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });

  it('never throw, so a booking cannot be rolled back by a mail failure', async () => {
    // No mail provider is configured in tests, which is the failure mode being relied on.
    const result = await notifications.notifyPassportsBooked(admin(), fx.agencyA, 3);
    assert.equal(result.skipped, true);
    assert.equal(result.sent, 0);
  });

  it('leave the import committed even with notifications switched on', async () => {
    const batch = await ctx.dal.createPassports(asA(), [row('A10000001')]);
    const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));
    await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
    await ctx.dal.markAsAdded(admin(), ids);

    const csv = [
      '"Passport Number","Appointment Date"',
      '"A10000001","27/08/2026"',
    ].join('\r\n');

    const committed = await ctx.dal.commitImport(admin(), {
      buffer: Buffer.from(csv, 'utf8'),
      filename: 'bookings.csv',
    });

    assert.equal(committed.booked, 1);
    const passport = await ctx.dal.getPassport(admin(), ids[0]!);
    assert.equal(passport.status, 'booked');
  });

  it('record that a notification went out, without its contents', async () => {
    await notifications.notifyPassportsBooked(admin(), fx.agencyA, 2);

    // Inviting the two fixture users already wrote a notification entry each, so the
    // booking one is picked out by its event rather than by being the only one.
    const entries = await ctx.dal.listAuditEntries(admin(), { entity: 'notification' });
    const booked = entries.filter((entry) => (entry.metadata as { event?: string })?.event === 'passports.booked');

    assert.equal(booked.length, 1);
    assert.equal((booked[0]!.metadata as { count: number }).count, 2);
    assert.equal(entries.filter((entry) => (entry.metadata as { event?: string })?.event === 'user.invited').length, 2);
  });
});
