/**
 * 001 — create the collections, apply their validators, and build every index that
 * enforces an invariant.
 *
 * If a rule matters it belongs in the database. Application checks lose races: two
 * simultaneous submissions of the same passport number both pass an application-level
 * "does this exist?" check, and only a unique index stops both from being written.
 */

import type { Db } from 'mongodb';

import { COLLECTION_VALIDATORS, userValidatorExpression } from '@/lib/schema/jsonSchema';
import { OTP } from '@/config/validation';

export const id = '001_initial_collections';
export const description = 'Collections, $jsonSchema validators, and the invariant indexes';

export async function up(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, schema] of Object.entries(COLLECTION_VALIDATORS)) {
    const validator =
      name === 'users'
        ? { $and: [{ $jsonSchema: schema }, userValidatorExpression] }
        : { $jsonSchema: schema };

    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    }
  }

  // Collections without a validator: rate limiting is throwaway state, settings are
  // single documents keyed by name.
  for (const name of ['rate_limits', 'settings']) {
    if (!existing.has(name)) await db.createCollection(name);
  }

  // --- The rules that must not be able to lose a race --------------------------------

  // A passport number exists once in the entire system, across all agencies.
  await db.collection('passports').createIndex(
    { passportNumberNormalized: 1 },
    { unique: true, name: 'uniq_passport_number_normalized' },
  );

  // A route is the three parts together: the same pair at two centers is two routes.
  await db.collection('routes').createIndex(
    { originCountry: 1, destinationCountry: 1, centerNormalized: 1 },
    { unique: true, name: 'uniq_route_triple' },
  );

  // One account per email address.
  await db.collection('users').createIndex(
    { emailNormalized: 1 },
    { unique: true, name: 'uniq_user_email' },
  );

  await db.collection('agencies').createIndex(
    { nameNormalized: 1 },
    { unique: true, name: 'uniq_agency_name' },
  );

  // A passport must not be able to hold two active bookings.
  await db.collection('passports').createIndex(
    { bookingId: 1 },
    {
      unique: true,
      name: 'uniq_passport_active_booking',
      partialFilterExpression: { bookingId: { $type: 'objectId' } },
    },
  );

  // --- Query indexes ------------------------------------------------------------------

  // Every agency-scoped read filters on agencyId first, so it leads each index.
  await db.collection('passports').createIndex({ agencyId: 1, status: 1, submittedAt: -1 }, { name: 'agency_status_submitted' });
  await db.collection('passports').createIndex({ status: 1, routeId: 1, priority: -1, submittedAt: 1 }, { name: 'handoff_queue' });
  await db.collection('passports').createIndex({ status: 1, holdUntil: 1 }, { name: 'holds_due' });
  await db.collection('passports').createIndex({ agencyId: 1, lastName: 1, firstName: 1 }, { name: 'agency_name' });

  await db.collection('users').createIndex({ agencyId: 1, active: 1 }, { name: 'agency_active' });
  await db.collection('sessions').createIndex({ userId: 1 }, { name: 'session_user' });
  await db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_session_token' });
  await db.collection('audit_log').createIndex({ at: -1 }, { name: 'audit_recent' });
  await db.collection('audit_log').createIndex({ agencyId: 1, at: -1 }, { name: 'audit_by_agency' });
  await db.collection('audit_log').createIndex({ entity: 1, entityId: 1, at: -1 }, { name: 'audit_by_entity' });
  await db.collection('otps').createIndex({ emailNormalized: 1, createdAt: -1 }, { name: 'otp_by_email' });

  // --- Expiry ------------------------------------------------------------------------
  // Mongo clears these out on its own; nothing in the app has to remember to.
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_sessions' });
  await db.collection('otps').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: OTP.expiryMinutes * 60, name: 'ttl_otps' },
  );
  await db.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_rate_limits' });
}

export async function down(db: Db): Promise<void> {
  for (const name of [...Object.keys(COLLECTION_VALIDATORS), 'rate_limits', 'settings']) {
    await db.collection(name).drop().catch(() => undefined);
  }
}
