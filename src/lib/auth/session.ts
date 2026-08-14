/**
 * Sessions are server-side and opaque.
 *
 * The cookie holds a random token; the database holds only its hash. That is what makes
 * "deactivate a user and their sessions die with them" true immediately — a self-contained
 * JWT would keep working until it expired, because nothing would be checking.
 *
 * It is also what makes view-as possible: the session, not the token, records which
 * agency the admin is currently looking at, and that a view-as session may not write.
 */

import { ObjectId } from 'mongodb';

import { OTP } from '@/config/validation';
import { sessions } from '@/lib/db/collections';
import { getUserById } from '@/lib/dal/users';
import type { Actor } from '@/lib/dal/actor';
import { addDays } from '@/lib/dates';

import { generateSessionToken, hashIp, hashSecret } from './crypto';

export const SESSION_COOKIE = 'vp_session';

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: ObjectId,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = addDays(now, OTP.sessionDays);

  const collection = await sessions();
  await collection.insertOne({
    userId,
    tokenHash: hashSecret(token),
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    revokedAt: null,
    ipHash: hashIp(meta.ip),
    userAgent: meta.userAgent?.slice(0, 200) ?? null,
    viewingAsAgencyId: null,
    viewAsStartedAt: null,
  } as never);

  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: ObjectId;
  actor: Actor;
}

/**
 * Turn a cookie value into an actor, or null.
 *
 * The user is re-read on every request, so a deactivation, a role change or a move
 * between agencies takes effect on the next click rather than at the next login.
 */
export async function resolveSession(token: string | undefined | null): Promise<ResolvedSession | null> {
  if (!token) return null;

  const collection = await sessions();
  const session = await collection.findOne({ tokenHash: hashSecret(token) });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt <= new Date()) return null;

  const user = await getUserById(session.userId);
  if (!user || !user.active) return null;

  // Touch at most once a minute; a write on every request would be pointless load.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await collection.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
  }

  const viewingAsAgencyId = user.role === 'admin' ? (session.viewingAsAgencyId ?? null) : null;

  return {
    sessionId: session._id,
    actor: {
      userId: user._id,
      role: user.role,
      agencyId: user.agencyId,
      viewingAsAgencyId,
      email: user.email,
      name: user.name,
    },
  };
}

export async function revokeSession(token: string): Promise<void> {
  const collection = await sessions();
  await collection.updateOne({ tokenHash: hashSecret(token) }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllSessionsForUser(userId: ObjectId): Promise<void> {
  const collection = await sessions();
  await collection.updateMany(
    { userId, revokedAt: { $in: [null, undefined] } },
    { $set: { revokedAt: new Date() } },
  );
}

/** Enter a view-as session. Admin-only, and read-only for as long as it lasts. */
export async function startViewAs(sessionId: ObjectId, agencyId: ObjectId): Promise<void> {
  const collection = await sessions();
  await collection.updateOne(
    { _id: sessionId },
    { $set: { viewingAsAgencyId: agencyId, viewAsStartedAt: new Date() } },
  );
}

export async function endViewAs(sessionId: ObjectId): Promise<void> {
  const collection = await sessions();
  await collection.updateOne(
    { _id: sessionId },
    { $set: { viewingAsAgencyId: null, viewAsStartedAt: null } },
  );
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
