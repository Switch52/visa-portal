/**
 * 002 — bookings, charges and import batches.
 *
 * The indexes here carry three rules that must not be able to lose a race:
 *
 *   - a passport can hold one live booking, and one only;
 *   - a booked passport carries one live charge, and one only;
 *   - the same file cannot be committed as an import twice.
 *
 * Each is a partial unique index rather than a plain one, because an undone import must
 * leave its rows in place as evidence while freeing the passport to be booked again.
 */

import type { Db } from 'mongodb';

import { CURRENCY_CODES } from '@/config/currencies';

const objectId = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const nullableString = { bsonType: ['string', 'null'] };
const nullableObjectId = { bsonType: ['objectId', 'null'] };

export const id = '002_bookings_and_charges';
export const description = 'Bookings, charges and import batches, with their invariant indexes';

const bookingSchema = {
  bsonType: 'object',
  required: ['passportId', 'agencyId', 'appointmentAt', 'timezone', 'location', 'importBatchId', 'createdAt'],
  properties: {
    _id: objectId,
    passportId: objectId,
    agencyId: objectId,
    appointmentAt: date,
    timezone: { bsonType: 'string', minLength: 1 },
    location: { bsonType: 'string', minLength: 1 },
    reference: nullableString,
    importBatchId: objectId,
    recordedBy: nullableObjectId,
    createdAt: date,
    undoneAt: nullableDate,
    undoneBy: nullableObjectId,
    source: { bsonType: ['object', 'null'] },
  },
};

const chargeSchema = {
  bsonType: 'object',
  required: [
    'agencyId',
    'passportId',
    'bookingId',
    'routeId',
    'amountMinor',
    'currency',
    'chargedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    _id: objectId,
    agencyId: objectId,
    passportId: objectId,
    bookingId: objectId,
    routeId: objectId,
    // Minor units, integer, with its own currency. Never a float, never a bare number.
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

const importBatchSchema = {
  bsonType: 'object',
  required: ['filename', 'fileHash', 'uploadedAt', 'status', 'counts'],
  properties: {
    _id: objectId,
    filename: { bsonType: 'string', minLength: 1 },
    fileHash: { bsonType: 'string', minLength: 32 },
    sheetName: nullableString,
    uploadedBy: nullableObjectId,
    uploadedAt: date,
    status: { enum: ['committed', 'undone'] },
    counts: { bsonType: 'object' },
    undoneAt: nullableDate,
    undoneBy: nullableObjectId,
  },
};

const VALIDATORS: Record<string, object> = {
  bookings: bookingSchema,
  charges: chargeSchema,
  import_batches: importBatchSchema,
};

export async function up(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, schema] of Object.entries(VALIDATORS)) {
    const validator = { $jsonSchema: schema };
    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    }
  }

  // One live booking per passport. An undone booking is excluded, so the passport can be
  // booked again by a later, correct import.
  await db.collection('bookings').createIndex(
    { passportId: 1 },
    {
      unique: true,
      name: 'uniq_live_booking_per_passport',
      partialFilterExpression: { undoneAt: null },
    },
  );

  // One live charge per passport, for the same reason: no double-charging on a re-import.
  await db.collection('charges').createIndex(
    { passportId: 1 },
    {
      unique: true,
      name: 'uniq_live_charge_per_passport',
      partialFilterExpression: { voidedAt: null },
    },
  );

  // Re-uploading a file that was already committed is recognised rather than repeated.
  await db.collection('import_batches').createIndex(
    { fileHash: 1 },
    {
      unique: true,
      name: 'uniq_committed_import_file',
      partialFilterExpression: { status: 'committed' },
    },
  );

  await db.collection('bookings').createIndex({ importBatchId: 1 }, { name: 'bookings_by_batch' });
  await db.collection('bookings').createIndex({ appointmentAt: 1 }, { name: 'bookings_by_date' });
  await db.collection('charges').createIndex({ agencyId: 1, currency: 1, voidedAt: 1 }, { name: 'charges_for_balance' });
  await db.collection('charges').createIndex({ importBatchId: 1 }, { name: 'charges_by_batch' });
  await db.collection('import_batches').createIndex({ uploadedAt: -1 }, { name: 'batches_recent' });
}

export async function down(db: Db): Promise<void> {
  for (const name of Object.keys(VALIDATORS)) {
    await db.collection(name).drop().catch(() => undefined);
  }
}
