/**
 * View-as: an admin looking at the portal exactly as one agency sees it, and unable to
 * write anything while they do.
 *
 * It used to live on the session row, which was one of the three reasons this app had its
 * own sessions at all. Clerk owns sessions now and has no concept of it, so it moves to a
 * cookie of our own — deliberately separate from Clerk's, so signing out, refreshing a
 * token or rotating a session cannot silently strand someone inside another agency's data.
 *
 * The cookie is HMAC-signed. Not because forging it grants anything — `resolveViewAs`
 * ignores it entirely unless the caller is already an admin, and an admin may view any
 * agency anyway — but because an unsigned identifier in a cookie invites someone to try,
 * and a tampered value should be discarded rather than parsed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { ObjectId } from 'mongodb';

import type { Actor } from '@/lib/dal/actor';

export const VIEW_AS_COOKIE = 'vp_view_as';

function sign(value: string): string {
  return createHmac('sha256', process.env.AUTH_SECRET ?? '').update(value).digest('hex');
}

function verify(value: string, signature: string): boolean {
  const expected = Buffer.from(sign(value), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** `<agencyId>.<signature>` — opaque enough, and self-verifying. */
export function encodeViewAs(agencyId: ObjectId): string {
  const id = agencyId.toHexString();
  return `${id}.${sign(id)}`;
}

/**
 * The agency an admin is currently viewing as, or null.
 *
 * Returns null for anyone who is not an admin, whatever the cookie says. That check is
 * the actual security boundary; the signature only keeps out malformed input.
 */
export function decodeViewAs(cookieValue: string | undefined, role: Actor['role']): ObjectId | null {
  if (!cookieValue || role !== 'admin') return null;

  const [id, signature] = cookieValue.split('.');
  if (!id || !signature) return null;
  if (!verify(id, signature)) return null;
  if (!ObjectId.isValid(id)) return null;

  return new ObjectId(id);
}

export function viewAsCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Session-scoped: closing the browser drops it. Viewing as an agency is something
    // you do for a few minutes to answer a question, not a state to wake up inside.
    maxAge: undefined,
  };
}
