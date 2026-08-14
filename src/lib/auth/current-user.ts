/**
 * Reading the current actor inside a server component, server action or route handler.
 *
 * Everything server-side that needs to know who is asking calls `requireAdmin()` or
 * `requireUser()` here, and then passes the returned actor into the DAL. Nothing infers
 * permissions from the URL or from a client-supplied value.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { Actor } from '@/lib/dal/actor';
import { ForbiddenError } from '@/lib/dal/errors';

import { SESSION_COOKIE, resolveSession, type ResolvedSession } from './session';

export async function getSession(): Promise<ResolvedSession | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function getActor(): Promise<Actor | null> {
  return (await getSession())?.actor ?? null;
}

/** For pages: send anyone not signed in to the login screen. */
export async function requireUser(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
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

/** The client IP, as the platform reports it. Hashed before it is ever stored. */
export async function getClientIp(): Promise<string | null> {
  const headerList = await headers();
  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headerList.get('x-real-ip');
}

export async function getUserAgent(): Promise<string | null> {
  return (await headers()).get('user-agent');
}
