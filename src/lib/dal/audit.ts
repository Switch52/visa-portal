/**
 * The audit log is append-only. Every status change, booking, import, payment, invite,
 * deactivation and deletion lands here with actor, timestamp and before/after values.
 *
 * Nothing in this file may write a passport number, a name or a date of birth into the
 * `metadata` field — `redact()` strips them, because an audit entry is read far more
 * often, and by more tooling, than the record it describes.
 */

import type { ClientSession, ObjectId } from 'mongodb';

import { auditLog } from '@/lib/db/collections';
import type { AuditLogDoc } from '@/lib/db/types';

import type { Actor } from './actor';

export type AuditAction =
  | 'agency.create'
  | 'agency.update'
  | 'agency.deactivate'
  | 'user.invite'
  | 'user.update'
  | 'user.deactivate'
  | 'user.reactivate'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.otp_requested'
  | 'auth.otp_failed'
  | 'auth.blocked_unknown_email'
  | 'viewas.start'
  | 'viewas.end'
  | 'route.create'
  | 'route.update'
  | 'passport.create'
  | 'passport.update'
  | 'passport.status_change'
  | 'passport.duplicate_blocked'
  | 'passport.export'
  | 'booking.import'
  | 'booking.import_undo'
  | 'payment.record'
  | 'payment.delete';

const SENSITIVE_KEYS = new Set([
  'passportNumber',
  'passportNumberNormalized',
  'firstName',
  'lastName',
  'dateOfBirth',
  'contactNumber',
  'contactEmail',
  'raw',
  'code',
  'codeHash',
  'tokenHash',
]);

/** Replaces sensitive values with a marker, recursively, before anything is written. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value instanceof Date || value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redact(inner);
  }
  return out as T;
}

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: ObjectId | null;
  agencyId?: ObjectId | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface AuditFilters {
  action?: string;
  entity?: string;
  agencyId?: ObjectId;
  actorId?: ObjectId;
  from?: Date;
  to?: Date;
  limit?: number;
  skip?: number;
}

export interface AuditView {
  id: string;
  at: Date;
  action: string;
  entity: string;
  entityId: string | null;
  agencyId: string | null;
  actorId: string | null;
  actorRole: string;
  onBehalfOfAgencyId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
}

/**
 * Read the log. Admin-only: it spans every agency by definition, so there is no scoped
 * version of it — an agency-shaped actor is refused outright rather than filtered.
 *
 * What comes back was redacted on the way in, so nothing here can leak a passport number
 * or a name even though the entries describe records that have them.
 */
export async function listAuditEntries(actor: Actor, filters: AuditFilters = {}): Promise<AuditView[]> {
  const { assertAdmin } = await import('./actor');
  assertAdmin(actor);

  const filter: Record<string, unknown> = {};
  if (filters.action) filter.action = filters.action;
  if (filters.entity) filter.entity = filters.entity;
  if (filters.agencyId) filter.agencyId = filters.agencyId;
  if (filters.actorId) filter.actorId = filters.actorId;
  if (filters.from || filters.to) {
    filter.at = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  const collection = await auditLog();
  const docs = await collection
    .find(filter)
    .sort({ at: -1 })
    .skip(filters.skip ?? 0)
    .limit(Math.min(filters.limit ?? 100, 500))
    .toArray();

  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    at: doc.at,
    action: doc.action,
    entity: doc.entity,
    entityId: doc.entityId?.toHexString() ?? null,
    agencyId: doc.agencyId?.toHexString() ?? null,
    actorId: doc.actorId?.toHexString() ?? null,
    actorRole: doc.actorRole,
    onBehalfOfAgencyId: doc.onBehalfOfAgencyId?.toHexString() ?? null,
    before: doc.before ?? null,
    after: doc.after ?? null,
    metadata: doc.metadata ?? null,
  }));
}

export async function countAuditEntries(actor: Actor, filters: AuditFilters = {}): Promise<number> {
  const { assertAdmin } = await import('./actor');
  assertAdmin(actor);

  const collection = await auditLog();
  const filter: Record<string, unknown> = {};
  if (filters.action) filter.action = filters.action;
  if (filters.agencyId) filter.agencyId = filters.agencyId;
  return collection.countDocuments(filter);
}

/** The distinct actions present, so the filter offers only what exists. */
export async function listAuditActions(actor: Actor): Promise<string[]> {
  const { assertAdmin } = await import('./actor');
  assertAdmin(actor);

  const collection = await auditLog();
  const actions = await collection.distinct('action');
  return actions.sort();
}

export async function writeAudit(
  actor: Actor,
  entry: AuditEntry,
  session?: ClientSession,
): Promise<void> {
  const doc: Omit<AuditLogDoc, '_id'> = {
    at: new Date(),
    actorId: actor.userId,
    actorRole: actor.role,
    onBehalfOfAgencyId: actor.viewingAsAgencyId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    agencyId: entry.agencyId ?? null,
    before: entry.before === undefined ? undefined : redact(entry.before),
    after: entry.after === undefined ? undefined : redact(entry.after),
    metadata: entry.metadata ? redact(entry.metadata) : null,
  };

  const collection = await auditLog();
  await collection.insertOne(doc as AuditLogDoc, { session });
}
