/**
 * 003 — payments, and ledger lines that are not charges.
 *
 * Two changes:
 *
 *   1. a `payments` collection, with a unique idempotency key so a double-clicked form
 *      cannot record the same money twice;
 *   2. `charges` gains a `type`, because an opening balance and a credit are real ledger
 *      lines rather than special cases hidden in application code — and neither belongs to
 *      a passport, so `passportId` and `bookingId` become nullable.
 *
 * Balances stay derived from these rows. Nothing here stores a balance.
 */

import type { Db } from 'mongodb';

import { CURRENCY_CODES } from '@/config/currencies';

const objectId = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const nullableString = { bsonType: ['string', 'null'] };
const nullableObjectId = { bsonType: ['objectId', 'null'] };

export const id = '003_payments_and_ledger';
export const description = 'Payments, and opening balances and credits as ledger entry types';

const chargeSchema = {
  bsonType: 'object',
  required: ['type', 'agencyId', 'amountMinor', 'currency', 'chargedAt', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    type: { enum: ['charge', 'opening_balance', 'credit'] },
    agencyId: objectId,
    // Null for an opening balance or a credit: they belong to no single passport.
    passportId: nullableObjectId,
    bookingId: nullableObjectId,
    routeId: nullableObjectId,
    description: nullableString,
    amountMinor: { bsonType: ['int', 'long'], minimum: 0 },
    currency: { enum: CURRENCY_CODES },
    chargedAt: date,
    createdBy: nullableObjectId,
    importBatchId: nullableObjectId,
    voidedAt: nullableDate,
    voidedBy: nullableObjectId,
    voidReason: nullableString,
    createdAt: date,
    updatedAt: date,
  },
};

const paymentSchema = {
  bsonType: 'object',
  required: [
    'agencyId',
    'amountMinor',
    'currency',
    'receivedAt',
    'idempotencyKey',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    _id: objectId,
    agencyId: objectId,
    amountMinor: { bsonType: ['int', 'long'], minimum: 0 },
    currency: { enum: CURRENCY_CODES },
    receivedAt: date,
    method: nullableString,
    reference: nullableString,
    note: nullableString,
    recordedBy: nullableObjectId,
    idempotencyKey: { bsonType: 'string', minLength: 8 },
    voidedAt: nullableDate,
    voidedBy: nullableObjectId,
    voidReason: nullableString,
    appliesToChargeId: nullableObjectId,
    createdAt: date,
    updatedAt: date,
  },
};

export async function up(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  // Existing charges predate the type field; give them the only value they can have.
  await db.collection('charges').updateMany({ type: { $exists: false } }, { $set: { type: 'charge' } });

  await db.command({
    collMod: 'charges',
    validator: { $jsonSchema: chargeSchema },
    validationLevel: 'strict',
    validationAction: 'error',
  });

  if (existing.has('payments')) {
    await db.command({
      collMod: 'payments',
      validator: { $jsonSchema: paymentSchema },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.createCollection('payments', {
      validator: { $jsonSchema: paymentSchema },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }

  // A double-click, a retry or a resubmitted form cannot record the same payment twice.
  await db.collection('payments').createIndex(
    { idempotencyKey: 1 },
    { unique: true, name: 'uniq_payment_idempotency' },
  );

  await db.collection('payments').createIndex(
    { agencyId: 1, currency: 1, receivedAt: -1 },
    { name: 'payments_for_balance' },
  );
  await db.collection('payments').createIndex({ receivedAt: -1 }, { name: 'payments_recent' });

  // The live-charge uniqueness from 002 must not stop a second opening balance or credit,
  // neither of which carries a passport. Rebuilt to cover only real per-passport charges.
  await db.collection('charges').dropIndex('uniq_live_charge_per_passport').catch(() => undefined);
  await db.collection('charges').createIndex(
    { passportId: 1 },
    {
      unique: true,
      name: 'uniq_live_charge_per_passport',
      partialFilterExpression: { voidedAt: null, passportId: { $type: 'objectId' } },
    },
  );
}

export async function down(db: Db): Promise<void> {
  await db.collection('payments').drop().catch(() => undefined);
}
