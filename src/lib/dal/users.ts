/**
 * Users. Invite-only, and only the admin can invite: an email that is not on the list
 * does not exist in the system, so no code is ever sent to it and no account is created.
 *
 * An agency user can see themselves and their own colleagues, never a user at another
 * agency and never the existence of one.
 */

import { ObjectId } from 'mongodb';

import { normalizeEmail } from '@/config/validation';
import { users, sessions } from '@/lib/db/collections';
import type { UserDoc } from '@/lib/db/types';
import { inviteUserSchema, type InviteUserInput } from '@/lib/schema/zod';

import { assertAdmin, notDeleted, scopeAgencyId, type Actor } from './actor';
import { isDuplicateKey } from './agencies';
import { writeAudit } from './audit';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agency';
  agencyId: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
}

function toSummary(doc: UserDoc): UserSummary {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    agencyId: doc.agencyId?.toHexString() ?? null,
    active: doc.active,
    lastLoginAt: doc.lastLoginAt ?? null,
    invitedAt: doc.invitedAt ?? null,
  };
}

/**
 * Look up an account by email for the login flow.
 *
 * Deliberately not exported through the DAL index: only the auth layer calls it, and it
 * must never be used to answer a question from an unauthenticated caller — the login page
 * shows the same neutral message either way.
 */
export async function findActiveUserByEmail(email: string): Promise<UserDoc | null> {
  const collection = await users();
  return collection.findOne(notDeleted({ emailNormalized: normalizeEmail(email), active: true }));
}

/**
 * The fast path for every authenticated request: Clerk hands us its user id, and this
 * turns it into the record that decides what they may see.
 */
export async function findActiveUserByClerkId(clerkUserId: string): Promise<UserDoc | null> {
  const collection = await users();
  return collection.findOne(notDeleted({ clerkUserId, active: true }));
}

/**
 * Attach a Clerk identity to an invited record, on that person's first sign-in.
 *
 * Guarded on the record still being unlinked, so two simultaneous first requests cannot
 * both claim it and a second Clerk account can never take over an existing user by
 * signing up with the same address later. `uniq_user_clerk_id` is the backstop.
 */
export async function linkClerkIdentity(id: ObjectId, clerkUserId: string): Promise<UserDoc | null> {
  const collection = await users();
  return collection.findOneAndUpdate(
    notDeleted({ _id: id, active: true, clerkUserId: { $in: [null, undefined] } }),
    { $set: { clerkUserId, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

export async function getUserById(id: ObjectId): Promise<UserDoc | null> {
  const collection = await users();
  return collection.findOne(notDeleted({ _id: id }));
}

export async function listUsers(actor: Actor): Promise<UserSummary[]> {
  const collection = await users();
  const scope = scopeAgencyId(actor);

  // An agency sees only its own people. An admin sees everyone — unless they are in a
  // view-as session, in which case they see exactly what that agency would.
  const filter = scope ? notDeleted({ agencyId: scope }) : notDeleted();
  if (!scope && actor.role !== 'admin' && actor.role !== 'system') throw new ForbiddenError();

  const docs = await collection.find(filter).sort({ name: 1 }).toArray();
  return docs.map(toSummary);
}

export async function getUser(actor: Actor, id: ObjectId): Promise<UserSummary> {
  const collection = await users();
  const doc = await collection.findOne(notDeleted({ _id: id }));
  if (!doc) throw new NotFoundError();

  const scope = scopeAgencyId(actor);
  // Same answer for "does not exist" and "belongs to someone else".
  if (scope && (!doc.agencyId || !doc.agencyId.equals(scope))) throw new NotFoundError();
  return toSummary(doc);
}

/** Adding a person by name and email is what makes that email exist in the system. */
export async function inviteUser(actor: Actor, input: InviteUserInput): Promise<UserSummary> {
  assertAdmin(actor);

  const parsed = inviteUserSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check the invite details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    name: parsed.data.name,
    email: parsed.data.email,
    emailNormalized: normalizeEmail(parsed.data.email),
    role: parsed.data.role,
    agencyId: parsed.data.agencyId ? new ObjectId(parsed.data.agencyId) : null,
    active: true,
    lastLoginAt: null,
    invitedBy: actor.userId,
    invitedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await users();
  try {
    const result = await collection.insertOne(doc as UserDoc);
    await writeAudit(actor, {
      action: 'user.invite',
      entity: 'user',
      entityId: result.insertedId,
      agencyId: doc.agencyId,
      after: { email: doc.email, role: doc.role },
    });

    // After the account exists, and never in a way that can undo it: a mail provider
    // being down must not mean the invite failed.
    const { notifyUserInvited } = await import('@/lib/notifications');
    await notifyUserInvited(actor, { email: doc.email, name: doc.name, agencyId: doc.agencyId });

    return toSummary({ ...doc, _id: result.insertedId } as UserDoc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new ValidationError('That email already has an account', { email: ['Already invited'] });
    }
    throw error;
  }
}

/**
 * Deactivating a user takes effect immediately: their sessions are revoked in the same
 * call, so an open tab cannot keep working until a token expires.
 */
export async function setUserActive(actor: Actor, id: ObjectId, active: boolean): Promise<UserSummary> {
  assertAdmin(actor);

  const collection = await users();
  const doc = await collection.findOneAndUpdate(
    notDeleted({ _id: id }),
    { $set: { active, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!doc) throw new NotFoundError();

  if (!active) {
    const sessionCollection = await sessions();
    await sessionCollection.updateMany(
      { userId: id, revokedAt: { $in: [null, undefined] } },
      { $set: { revokedAt: new Date() } },
    );
  }

  await writeAudit(actor, {
    action: active ? 'user.reactivate' : 'user.deactivate',
    entity: 'user',
    entityId: id,
    agencyId: doc.agencyId,
    after: { active },
  });
  return toSummary(doc);
}

/**
 * The email addresses to notify for one agency.
 *
 * Deliberately narrow: it returns addresses and nothing else, and only for the agency
 * asked about — a notification must never become a way to enumerate anybody.
 */
export async function listNotificationRecipients(agencyId: ObjectId): Promise<string[]> {
  const collection = await users();
  const docs = await collection.find(notDeleted({ agencyId, active: true })).toArray();
  return docs.map((doc) => doc.email);
}

export async function recordLogin(userId: ObjectId): Promise<void> {
  const collection = await users();
  await collection.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } });
}
