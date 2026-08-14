/**
 * The acting user, and the scope that follows from them.
 *
 * MongoDB has no row-level security: a query that forgets its filter will happily return
 * another agency's data. So the scope is not left to each call site — every agency-scoped
 * read and write in this layer runs its filter through `scopedFilter()`, which takes the
 * actor and adds the agency condition itself.
 */

import { ObjectId, type Filter } from 'mongodb';

import { ForbiddenError, NotAuthenticatedError, ReadOnlySessionError } from './errors';

export type ActorRole = 'admin' | 'agency' | 'system';

export interface Actor {
  readonly userId: ObjectId | null;
  readonly role: ActorRole;
  /** Set for agency users. Null for admins and for system tasks. */
  readonly agencyId: ObjectId | null;
  /**
   * Set while an admin is viewing the portal as an agency. Reads are scoped to that
   * agency exactly as the agency would see them; writes are refused.
   */
  readonly viewingAsAgencyId: ObjectId | null;
  readonly email?: string;
  readonly name?: string;
}

export function adminActor(userId: ObjectId, extra: Partial<Actor> = {}): Actor {
  return { userId, role: 'admin', agencyId: null, viewingAsAgencyId: null, ...extra };
}

export function agencyActor(userId: ObjectId, agencyId: ObjectId, extra: Partial<Actor> = {}): Actor {
  return { userId, role: 'agency', agencyId, viewingAsAgencyId: null, ...extra };
}

/**
 * For migrations, imports and scheduled tasks. Unscoped by design, and only reachable
 * from server-side scripts — never from a request handler.
 */
export function systemActor(): Actor {
  return { userId: null, role: 'system', agencyId: null, viewingAsAgencyId: null };
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

export function isViewingAs(actor: Actor): boolean {
  return actor.role === 'admin' && actor.viewingAsAgencyId !== null;
}

/**
 * The agency whose data this actor may see, or null for unrestricted access.
 * An admin in a view-as session is restricted exactly as the agency is.
 */
export function scopeAgencyId(actor: Actor): ObjectId | null {
  if (actor.role === 'agency') {
    if (!actor.agencyId) throw new ForbiddenError('This account is not attached to an agency.');
    return actor.agencyId;
  }
  if (actor.role === 'admin') return actor.viewingAsAgencyId;
  return null; // system
}

/**
 * Merge the actor's agency scope into a filter. Every query in the DAL that touches an
 * agency-owned collection goes through here — that is the whole isolation guarantee.
 */
export function scopedFilter<T extends { agencyId: ObjectId }>(actor: Actor, filter: Filter<T> = {}): Filter<T> {
  const agencyId = scopeAgencyId(actor);
  if (!agencyId) return filter;

  // Set explicitly rather than spread-merged, so a caller-supplied agencyId can never
  // widen the scope — asking for another agency's id yields an impossible filter.
  const requested = (filter as { agencyId?: unknown }).agencyId;
  if (requested !== undefined && !(requested instanceof ObjectId && requested.equals(agencyId))) {
    return { ...filter, agencyId: new ObjectId('000000000000000000000000') } as Filter<T>;
  }
  return { ...filter, agencyId } as Filter<T>;
}

/** Excludes soft-deleted records. Deletion is soft by default everywhere. */
export function notDeleted<T>(filter: Filter<T> = {}): Filter<T> {
  return { ...filter, deletedAt: { $in: [null, undefined] } } as Filter<T>;
}

export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) throw new NotAuthenticatedError();
  return actor;
}

/** Admin-only operations — routes and fees, invites, exports, payments. */
export function assertAdmin(actor: Actor): void {
  if (actor.role === 'system') return;
  if (actor.role !== 'admin') throw new ForbiddenError();
  assertCanWrite(actor);
}

/** Any write at all. View-as is for seeing what they see, not for acting as them. */
export function assertCanWrite(actor: Actor): void {
  if (isViewingAs(actor)) throw new ReadOnlySessionError();
}

/** The agency a write belongs to: their own for an agency user, chosen for an admin. */
export function resolveWriteAgencyId(actor: Actor, requested?: ObjectId | null): ObjectId {
  assertCanWrite(actor);
  if (actor.role === 'agency') {
    if (!actor.agencyId) throw new ForbiddenError('This account is not attached to an agency.');
    if (requested && !requested.equals(actor.agencyId)) throw new ForbiddenError();
    return actor.agencyId;
  }
  if (!requested) throw new ForbiddenError('Choose an agency for this record.');
  return requested;
}
