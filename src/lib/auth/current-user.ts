/**
 * Reading the current actor inside a server component, server action or route handler.
 *
 * Clerk answers who someone is. This file answers what they may do, and that answer comes
 * from our own `users` collection on every single request — never from a token claim.
 *
 * Two properties depend on it working that way:
 *
 *   - **Invite-only.** Anyone can create a Clerk account. Only an account whose email
 *     matches an invited record resolves to an actor; everyone else is signed in to Clerk
 *     and still has access to nothing.
 *   - **Deactivation is immediate.** `active` is re-read per request, so switching it off
 *     ends access on the next click rather than whenever a token happens to expire.
 *
 * Everything server-side that needs to know who is asking calls `requireAdmin()` or
 * `requireUser()` here and passes the returned actor into the DAL. Nothing infers
 * permissions from the URL or from anything the client sent.
 */

import { auth, currentUser } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import type { Actor } from '@/lib/dal/actor';
import { ForbiddenError } from '@/lib/dal/errors';
import {
  findActiveUserByClerkId,
  findActiveUserByEmail,
  linkClerkIdentity,
  recordLogin,
} from '@/lib/dal/users';
import type { UserDoc } from '@/lib/db/types';

import { VIEW_AS_COOKIE, decodeViewAs } from './view-as';

/** Refresh `lastLoginAt` at most once an hour, from a document we already hold. */
const LOGIN_TOUCH_MS = 60 * 60 * 1000;

/**
 * First sign-in: match the Clerk account to an invited record by email, once, and record
 * the link so every later request is a single indexed lookup.
 *
 * `currentUser()` reaches Clerk's backend API and counts against its rate limit, which is
 * why it is only called on the one request that needs an email address.
 */
async function linkOnFirstSignIn(clerkUserId: string): Promise<UserDoc | null> {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  const invited = await findActiveUserByEmail(email);
  // No invitation, no access. Signing up with Clerk grants nothing on its own.
  if (!invited) return null;
  // Already linked to a different Clerk account — someone else signed up with this
  // address. Refuse rather than move the link.
  if (invited.clerkUserId && invited.clerkUserId !== clerkUserId) return null;

  return linkClerkIdentity(invited._id, clerkUserId);
}

export async function getActor(): Promise<Actor | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  const user = (await findActiveUserByClerkId(clerkUserId)) ?? (await linkOnFirstSignIn(clerkUserId));
  if (!user) return null;

  const last = user.lastLoginAt?.getTime() ?? 0;
  if (Date.now() - last > LOGIN_TOUCH_MS) await recordLogin(user._id);

  const store = await cookies();
  const viewingAsAgencyId = decodeViewAs(store.get(VIEW_AS_COOKIE)?.value, user.role);

  return {
    userId: user._id,
    role: user.role,
    agencyId: user.agencyId,
    viewingAsAgencyId,
    email: user.email,
    name: user.name,
  };
}

/**
 * For pages.
 *
 * The two failures are deliberately different destinations. Not signed in goes to Clerk.
 * Signed in but not invited goes to an explanation — sending them back to sign-in would
 * loop forever, since Clerk would hand them straight back as authenticated.
 */
export async function requireUser(): Promise<Actor> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const actor = await getActor();
  if (!actor) redirect('/no-access');
  return actor;
}

export async function requireAdmin(): Promise<Actor> {
  const actor = await requireUser();
  if (actor.role !== 'admin') redirect('/passports');
  return actor;
}

/** For route handlers, which return a status rather than redirecting. */
export async function requireActorForApi(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError('Sign in to continue.');
  return actor;
}
