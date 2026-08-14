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
