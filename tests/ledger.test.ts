/**
 * Payments, charges and balances.
 *
 * The properties under test are the ones that decide whether the ledger can be trusted:
 * balances are derived rather than stored, currencies never mix, a double-clicked payment
 * is recorded once, an undone import leaves nothing owed, and the EGP figure is display
 * only — computed for reading and never part of any stored amount.
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

const HEADER = ['Passport Number', 'Appointment Date', 'Appointment Time', 'Location', 'Reference'];

function csvFile(rows: string[][], filename = 'bookings.csv') {
  const body = rows.map((cells) => cells.map((cell) => `"${cell}"`).join(',')).join('\r\n');
  return { buffer: Buffer.from(body, 'utf8'), filename };
}

/** Book `count` passports for agency A, raising a 120.00 USD charge each. */
async function bookPassports(count: number, filename = 'bookings.csv'): Promise<ObjectId[]> {
  const numbers = Array.from({ length: count }, (_, index) => `A2000000${index}`);
  const batch = await ctx.dal.createPassports(asA(), numbers.map((number) => row(number)));
  const ids = batch.rows.map((entry) => new ObjectId(entry.passportId!));

  await ctx.dal.changePassportStatuses(admin(), ids, 'ready');
  await ctx.dal.markAsAdded(admin(), ids);
  await ctx.dal.commitImport(
    admin(),
    csvFile([HEADER, ...numbers.map((number) => [number, '27/08/2026', '09:30', 'VFS Cairo', `REF-${number}`])], filename),
  );
  return ids;
}

const usd = <T extends { currency: string }>(balances: T[]): T | undefined =>
  balances.find((balance) => balance.currency === 'USD');

describe('balances are derived from the rows', () => {
  it('adds up charges from bookings', async () => {
    await bookPassports(3);

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.chargedMinor, 36_000);
    assert.equal(usd(balances)!.paidMinor, 0);
    assert.equal(usd(balances)!.outstandingMinor, 36_000);
  });

  it('takes payments off what is owed', async () => {
    await bookPassports(3);
    await ctx.dal.recordPayment(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 20_000,
      currency: 'USD',
    });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.outstandingMinor, 16_000);
  });

  it('supports a partial payment and then the rest', async () => {
    await bookPassports(1);
    await ctx.dal.recordPayment(admin(), { agencyId: fx.agencyA.toHexString(), amountMinor: 5_000, currency: 'USD' });
    await ctx.dal.recordPayment(admin(), { agencyId: fx.agencyA.toHexString(), amountMinor: 7_000, currency: 'USD' });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.outstandingMinor, 0);
  });

  it('lets a credit reduce what is owed, with its reason on the line', async () => {
    await bookPassports(2);
    await ctx.dal.recordCredit(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 4_000,
      currency: 'USD',
      description: 'Goodwill on a cancelled appointment',
    });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.outstandingMinor, 20_000);

    const ledger = await ctx.dal.getLedger(admin(), fx.agencyA);
    const credit = ledger.find((line) => line.kind === 'credit');
    assert.equal(credit?.deltaMinor, -4_000);
    assert.match(credit!.description, /goodwill/i);
  });

  it('carries an opening balance as its own dated, labelled line', async () => {
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 282_022,
      currency: 'USD',
      description: 'Opening balance at cutover, from the payments sheet',
      at: '2026-08-14',
    });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.outstandingMinor, 282_022);

    const [line] = await ctx.dal.getLedger(admin(), fx.agencyA);
    assert.equal(line!.kind, 'opening_balance');
    assert.equal(line!.at.toISOString().slice(0, 10), '2026-08-14');
  });

  it('is never stored — the number comes from the rows every time', async () => {
    await bookPassports(1);

    const agencies = await ctx.collections.agencies();
    const doc = await agencies.findOne({ _id: fx.agencyA });

    // No balance field exists to drift out of sync with the ledger.
    assert.equal('balance' in doc!, false);
    assert.equal('outstanding' in doc!, false);
  });
});

describe('currencies never mix', () => {
  it('keeps two currencies as two balances, side by side', async () => {
    await bookPassports(1); // 120.00 USD
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 25_000,
      currency: 'EUR',
      description: 'Older EUR work',
    });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(balances.length, 2);
    assert.equal(balances.find((balance) => balance.currency === 'USD')!.outstandingMinor, 12_000);
    assert.equal(balances.find((balance) => balance.currency === 'EUR')!.outstandingMinor, 25_000);
  });

  it('a payment in one currency does not touch the other', async () => {
    await bookPassports(1);
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 25_000,
      currency: 'EUR',
      description: 'Older EUR work',
    });

    await ctx.dal.recordPayment(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 12_000,
      currency: 'USD',
    });

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(balances.find((balance) => balance.currency === 'USD')!.outstandingMinor, 0);
    assert.equal(balances.find((balance) => balance.currency === 'EUR')!.outstandingMinor, 25_000);
  });

  it('refuses to settle a charge with a payment in another currency', async () => {
    await bookPassports(1);
    const charges = await ctx.collections.charges();
    const charge = await charges.findOne({ currency: 'USD' });

    await assert.rejects(
      () =>
        ctx.dal.recordPayment(admin(), {
          agencyId: fx.agencyA.toHexString(),
          amountMinor: 12_000,
          currency: 'EUR',
          appliesToChargeId: charge!._id.toHexString(),
        }),
      (error: Error) => {
        assert.equal(error.name, 'ValidationError');
        assert.match(error.message, /own currency only/i);
        return true;
      },
    );
  });

  it('the overview totals per currency and never across them', async () => {
    await bookPassports(2);
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyB.toHexString(),
      amountMinor: 50_000,
      currency: 'EUR',
      description: 'Older EUR work',
    });

    const { totals } = await ctx.dal.getBalanceOverview(admin());
    assert.deepEqual(
      totals.map((total) => [total.currency, total.outstandingMinor]),
      [
        ['EUR', 50_000],
        ['USD', 24_000],
      ],
    );
  });

  it('sorts the overview by who owes most', async () => {
    await bookPassports(3); // Agency A: 360.00 USD
    await ctx.dal.recordOpeningBalance(admin(), {
      agencyId: fx.agencyB.toHexString(),
      amountMinor: 5_000,
      currency: 'USD',
      description: 'Small opening balance',
    });

    const { rows } = await ctx.dal.getBalanceOverview(admin());
    assert.equal(rows[0]!.agencyName, 'Agency A');
    assert.equal(rows[1]!.agencyName, 'Agency B');
  });
});

describe('recording payments', () => {
  it('records one payment when the same submission arrives twice', async () => {
    const key = ctx.dal.newIdempotencyKey();
    const input = {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: key,
    };

    const first = await ctx.dal.recordPayment(admin(), input);
    const second = await ctx.dal.recordPayment(admin(), input);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);

    const payments = await ctx.collections.payments();
    assert.equal(await payments.countDocuments({}), 1);
  });

  it('survives a genuine double-click, where both requests race', async () => {
    const key = ctx.dal.newIdempotencyKey();
    const input = {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: key,
    };

    await Promise.all([ctx.dal.recordPayment(admin(), input), ctx.dal.recordPayment(admin(), input)]);

    const payments = await ctx.collections.payments();
    assert.equal(await payments.countDocuments({}), 1);

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.paidMinor, 10_000);
  });

  it('records two separate payments of the same amount when they really are two', async () => {
    const input = { agencyId: fx.agencyA.toHexString(), amountMinor: 10_000, currency: 'USD' };
    await ctx.dal.recordPayment(admin(), input);
    await ctx.dal.recordPayment(admin(), input);

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.paidMinor, 20_000);
  });

  it('refuses an amount of zero, a bad currency, or a date in the future', async () => {
    const base = { agencyId: fx.agencyA.toHexString(), amountMinor: 10_000, currency: 'USD' };

    await assert.rejects(() => ctx.dal.recordPayment(admin(), { ...base, amountMinor: 0 }));
    await assert.rejects(() => ctx.dal.recordPayment(admin(), { ...base, currency: 'XYZ' }));
    await assert.rejects(() => ctx.dal.recordPayment(admin(), { ...base, receivedAt: '2099-01-01' }));
  });

  it('reverses a payment without deleting it', async () => {
    const payment = await ctx.dal.recordPayment(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 10_000,
      currency: 'USD',
    });

    await ctx.dal.voidPayment(admin(), new ObjectId(payment.id), 'Recorded against the wrong agency');

    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)?.paidMinor ?? 0, 0);

    const payments = await ctx.collections.payments();
    assert.equal(await payments.countDocuments({}), 1, 'the reversed payment stays as history');
  });

  it('is admin-only, and refused inside a view-as session', async () => {
    const input = { agencyId: fx.agencyA.toHexString(), amountMinor: 10_000, currency: 'USD' };

    await assert.rejects(() => ctx.dal.recordPayment(asA(), input), (error: Error) => error.name === 'ForbiddenError');
    await assert.rejects(
      () => ctx.dal.recordPayment(viewingA(), input),
      (error: Error) => error.name === 'ReadOnlySessionError',
    );
  });
});

describe('an agency sees only its own ledger', () => {
  it('cannot read another agency’s balance or ledger', async () => {
    await bookPassports(1);

    await assert.rejects(
      () => ctx.dal.getLedger(asB(), fx.agencyA),
      (error: Error) => error.name === 'NotFoundError',
    );
    assert.deepEqual(await ctx.dal.getAgencyBalance(asB(), fx.agencyA).catch(() => 'refused'), 'refused');
  });

  it('sees its own charges, each tied to a passport', async () => {
    await bookPassports(2);

    const ledger = await ctx.dal.getLedger(asA(), fx.agencyA);
    assert.equal(ledger.length, 2);
    assert.ok(ledger.every((line) => line.kind === 'charge' && line.passportId));
  });

  it('cannot record a payment for itself', async () => {
    await assert.rejects(
      () =>
        ctx.dal.recordPayment(asA(), {
          agencyId: fx.agencyA.toHexString(),
          amountMinor: 10_000,
          currency: 'USD',
        }),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });

  it('cannot list another agency’s payments', async () => {
    await ctx.dal.recordPayment(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 10_000,
      currency: 'USD',
    });

    assert.deepEqual(await ctx.dal.listPayments(asB()), []);
    assert.equal((await ctx.dal.listPayments(asA())).length, 1);
  });
});

describe('an undone import leaves nothing owed', () => {
  it('voids the charges it raised', async () => {
    await bookPassports(2);
    const before = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(before)!.outstandingMinor, 24_000);

    const batches = await ctx.collections.importBatches();
    const batch = await batches.findOne({ status: 'committed' });
    await ctx.dal.undoImport(admin(), batch!._id);

    const after = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(after)?.outstandingMinor ?? 0, 0);
  });

  it('leaves a payment already made as a credit balance, not as a loss', async () => {
    await bookPassports(1);
    await ctx.dal.recordPayment(admin(), {
      agencyId: fx.agencyA.toHexString(),
      amountMinor: 12_000,
      currency: 'USD',
    });

    const batches = await ctx.collections.importBatches();
    const batch = await batches.findOne({ status: 'committed' });
    await ctx.dal.undoImport(admin(), batch!._id);

    // The charge is gone, the payment is not: the agency is 120.00 in credit.
    const balances = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.equal(usd(balances)!.outstandingMinor, -12_000);
  });
});

describe('the EGP figure is display only', () => {
  it('converts for reading at the stored rate, and says when it was set', async () => {
    const converted = await ctx.dal.toDisplayEgp({ amountMinor: 10_000, currency: 'USD' });

    assert.ok(converted);
    assert.equal(converted.amount.currency, 'EGP');
    assert.equal(converted.amount.amountMinor, Math.round(10_000 * 51.08));
    assert.equal(converted.rate, 51.08);
    assert.equal(converted.rateUpdatedAt, '2026-07-27');
  });

  it('refuses to convert anything that is not in the rate’s base currency', async () => {
    assert.equal(await ctx.dal.toDisplayEgp({ amountMinor: 10_000, currency: 'EUR' }), null);
  });

  it('changing the rate moves no stored amount', async () => {
    await bookPassports(1);
    const before = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);

    await ctx.dal.saveDisplayRate(admin(), 60);

    const after = await ctx.dal.getAgencyBalance(admin(), fx.agencyA);
    assert.deepEqual(after, before);

    // And nothing on the charge itself mentions EGP.
    const charges = await ctx.collections.charges();
    const charge = await charges.findOne({ currency: 'USD' });
    assert.equal(JSON.stringify(charge).includes('EGP'), false);
  });

  it('is admin-only to change', async () => {
    await assert.rejects(
      () => ctx.dal.saveDisplayRate(asA(), 60),
      (error: Error) => error.name === 'ForbiddenError',
    );
  });
});
