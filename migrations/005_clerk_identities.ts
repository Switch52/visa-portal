/**
 * 005 — link user records to Clerk identities.
 *
 * Authentication moves to Clerk; authorization stays here. Clerk answers "who is this
 * person", and this collection keeps answering "what may they do" — role, agency, and
 * whether they are still allowed in at all.
 *
 * Splitting it that way preserves two properties that would otherwise be lost:
 *
 *   - invite-only access. Anyone can create a Clerk account; only an account whose email
 *     matches a row here resolves to an actor, and everything else refuses to serve them.
 *   - immediate deactivation. `active` is re-read on every request, so switching it off
 *     ends access on the next click rather than whenever a token happens to expire.
 */

import type { Db } from 'mongodb';

import { COLLECTION_VALIDATORS, userValidatorExpression } from '@/lib/schema/jsonSchema';

export const id = '005_clerk_identities';
export const description = 'Link user records to Clerk identities';

export async function up(db: Db): Promise<void> {
  // Re-apply the users validator, which now knows about clerkUserId.
  await db.command({
    collMod: 'users',
    validator: { $and: [{ $jsonSchema: COLLECTION_VALIDATORS.users }, userValidatorExpression] },
    validationLevel: 'strict',
    validationAction: 'error',
  });

  // Existing rows predate Clerk and have no link yet; they get one on first sign-in.
  await db.collection('users').updateMany(
    { clerkUserId: { $exists: false } },
    { $set: { clerkUserId: null } },
  );

  // One Clerk identity maps to at most one user record. Partial, because null is the
  // normal state before a first sign-in and a plain unique index would allow only one
  // unlinked user in the whole system.
  await db.collection('users').createIndex(
    { clerkUserId: 1 },
    {
      unique: true,
      name: 'uniq_user_clerk_id',
      partialFilterExpression: { clerkUserId: { $type: 'string' } },
    },
  );
}

export async function down(db: Db): Promise<void> {
  await db.collection('users').dropIndex('uniq_user_clerk_id').catch(() => {});
  await db.collection('users').updateMany({}, { $unset: { clerkUserId: '' } });
}
