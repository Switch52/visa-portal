/**
 * 004 — families.
 *
 * An application is no longer always one person. A family of two or four goes in as one
 * application covering several people, each of whom is still a passport in their own
 * right, linked by a shared `groupRef` so they stay together through the queue, the
 * handoff export and the booking file.
 *
 * The validator's `applicationType` enum comes from the config module, so adding another
 * size later is one entry there plus a migration like this one.
 */

import type { Db } from 'mongodb';

import { passportSchema } from '@/lib/schema/jsonSchema';

export const id = '004_family_applications';
export const description = 'Family application types, and a group reference linking their members';

export async function up(db: Db): Promise<void> {
  await db.command({
    collMod: 'passports',
    validator: { $jsonSchema: passportSchema },
    validationLevel: 'strict',
    validationAction: 'error',
  });

  // Everything that exists today was submitted as a single applicant.
  await db.collection('passports').updateMany(
    { applicationType: { $exists: false } },
    { $set: { applicationType: 'single' } },
  );

  // A family is read as a unit, so the index leads with the reference.
  await db.collection('passports').createIndex(
    { groupRef: 1 },
    { name: 'passports_by_group', partialFilterExpression: { groupRef: { $type: 'string' } } },
  );
}

export async function down(db: Db): Promise<void> {
  await db.collection('passports').dropIndex('passports_by_group').catch(() => undefined);
}
