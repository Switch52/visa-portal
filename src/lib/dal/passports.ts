/**
 * Passports — the core record, and the duplicate rule.
 *
 * A passport number may exist once in the entire system, across all agencies. The
 * submission is blocked, not warned, and the block is enforced by a unique index rather
 * than by a lookup: two simultaneous submissions must not both succeed, and an
 * application-level check loses that race.
 *
 * What the blocked agency is told is deliberately thinner than what the admin is told.
 * The agency response carries no reference to any other agency at all — not the name, not
 * the id, nothing that hints one exists — including in the underlying payload.
 */

import { ObjectId, type Filter } from 'mongodb';

import { normalizePassportNumber } from '@/config/validation';
import { checkTransition, IMPORT_ONLY_STATUSES, type PassportStatus } from '@/config/statuses';
import { agencies, passports } from '@/lib/db/collections';
import type { PassportDoc, StatusHistoryEntry } from '@/lib/db/types';
import { passportInputSchema, type PassportInput } from '@/lib/schema/zod';

import {
  assertCanWrite,
  isAdmin,
  notDeleted,
  resolveWriteAgencyId,
  scopeAgencyId,
  scopedFilter,
  type Actor,
} from './actor';
import { isDuplicateKey } from './agencies';
import { writeAudit } from './audit';
import { DuplicatePassportError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import { getRouteForPricing } from './routes';

export interface PassportView {
  id: string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  passportExpiryDate: Date;
  dateOfBirth: Date;
  nationality: string;
  gender: string;
  contactNumber: string | null;
  contactNumberDialCode: string | null;
  contactEmail: string | null;
  routeId: string;
  status: PassportStatus;
  applicationType: string;
  priority: string;
  holdUntil: Date | null;
  notes: string | null;
  submittedAt: Date;
  addedAt: Date | null;
  /** Admin-only: an agency never sees another agency's id, and does not need its own. */
  agencyId?: string;
}

function toView(doc: PassportDoc, actor: Actor): PassportView {
  const view: PassportView = {
    id: doc._id.toHexString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    passportNumber: doc.passportNumber,
    passportExpiryDate: doc.passportExpiryDate,
    dateOfBirth: doc.dateOfBirth,
    nationality: doc.nationality,
    gender: doc.gender,
    contactNumber: doc.contactNumber ?? null,
    contactNumberDialCode: doc.contactNumberDialCode ?? null,
    contactEmail: doc.contactEmail ?? null,
    routeId: doc.routeId.toHexString(),
    status: doc.status,
    applicationType: doc.applicationType,
    priority: doc.priority,
    holdUntil: doc.holdUntil ?? null,
    notes: doc.notes ?? null,
    submittedAt: doc.submittedAt,
    addedAt: doc.addedAt ?? null,
  };
  if (isAdmin(actor) && actor.viewingAsAgencyId === null) {
    view.agencyId = doc.agencyId.toHexString();
  }
  return view;
}

export interface PassportFilters {
  status?: PassportStatus | PassportStatus[];
  routeId?: ObjectId;
  agencyId?: ObjectId;
  search?: string;
  limit?: number;
  skip?: number;
}

export async function listPassports(actor: Actor, filters: PassportFilters = {}): Promise<PassportView[]> {
  const filter: Filter<PassportDoc> = {};

  if (filters.status) {
    filter.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
  }
  if (filters.routeId) filter.routeId = filters.routeId;
  if (filters.agencyId) filter.agencyId = filters.agencyId;
  if (filters.search) {
    // Search by passport number only, and by its normalized form, so a typed space or
    // dash still finds the record.
    filter.passportNumberNormalized = { $regex: `^${escapeRegex(normalizePassportNumber(filters.search))}` };
  }

  const collection = await passports();
  const docs = await collection
    .find(notDeleted(scopedFilter(actor, filter)))
    .sort({ submittedAt: -1 })
    .skip(filters.skip ?? 0)
    .limit(Math.min(filters.limit ?? 100, 500))
    .toArray();

  return docs.map((doc) => toView(doc, actor));
}

export async function countPassports(actor: Actor, filters: PassportFilters = {}): Promise<number> {
  const filter: Filter<PassportDoc> = {};
  if (filters.status) {
    filter.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
  }
  if (filters.agencyId) filter.agencyId = filters.agencyId;
  const collection = await passports();
  return collection.countDocuments(notDeleted(scopedFilter(actor, filter)));
}

/** Another agency's passport is indistinguishable from one that does not exist. */
export async function getPassport(actor: Actor, id: ObjectId): Promise<PassportView> {
  const collection = await passports();
  const doc = await collection.findOne(notDeleted(scopedFilter(actor, { _id: id })));
  if (!doc) throw new NotFoundError();
  return toView(doc, actor);
}

export interface CreatePassportOptions {
  /** Admin submitting on an agency's behalf. Ignored for agency users. */
  agencyId?: ObjectId;
  /** Set by the migration importer; never by a request handler. */
  source?: PassportDoc['source'];
}

export async function createPassport(
  actor: Actor,
  input: PassportInput,
  options: CreatePassportOptions = {},
): Promise<PassportView> {
  assertCanWrite(actor);

  const parsed = passportInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check this row', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const agencyId = resolveWriteAgencyId(actor, options.agencyId ?? actor.agencyId ?? null);
  const routeId = new ObjectId(parsed.data.routeId);
  const route = await getRouteForPricing(routeId);
  if (!route || !route.active) {
    throw new ValidationError('Choose a route', { routeId: ['That route is not available'] });
  }

  const now = new Date();
  const normalized = normalizePassportNumber(parsed.data.passportNumber);
  const status: PassportStatus = parsed.data.holdUntil ? 'on_hold' : 'submitted';

  const historyEntry: StatusHistoryEntry = {
    status,
    at: now,
    actorId: actor.userId,
    actorRole: actor.role,
    via: actor.role === 'system' ? 'migration' : 'manual',
    note: null,
  };

  const doc: Omit<PassportDoc, '_id'> = {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    passportNumber: parsed.data.passportNumber.trim(),
    passportNumberNormalized: normalized,
    passportExpiryDate: parsed.data.passportExpiryDate,
    dateOfBirth: parsed.data.dateOfBirth,
    nationality: parsed.data.nationality,
    gender: parsed.data.gender,
    contactNumber: parsed.data.contactNumber || null,
    contactNumberDialCode: parsed.data.contactNumberDialCode || null,
    contactEmail: parsed.data.contactEmail || null,
    agencyId,
    routeId,
    submittedAt: now,
    submittedBy: actor.userId,
    applicationType: parsed.data.applicationType,
    priority: parsed.data.priority,
    holdUntil: parsed.data.holdUntil ?? null,
    notes: parsed.data.notes || null,
    status,
    statusHistory: [historyEntry],
    addedAt: null,
    addedBy: null,
    bookingId: null,
    source: options.source ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await passports();
  try {
    const result = await collection.insertOne(doc as PassportDoc);
    return toView({ ...doc, _id: result.insertedId } as PassportDoc, actor);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw await buildDuplicateError(actor, normalized, parsed.data.passportNumber.trim(), agencyId);
    }
    throw error;
  }
}

/**
 * Build the blocked-duplicate error. The unique index has already refused the write; this
 * only decides how much of the reason the caller is allowed to hear.
 */
async function buildDuplicateError(
  actor: Actor,
  normalized: string,
  original: string,
  attemptedAgencyId: ObjectId,
): Promise<DuplicatePassportError> {
  const collection = await passports();
  const existing = await collection.findOne({ passportNumberNormalized: normalized });

  const detail: DuplicatePassportError['detail'] = {
    submittedAt: existing?.submittedAt ?? new Date(),
    status: existing?.status ?? 'submitted',
  };

  // The admin sees the full picture, including which agency registered it first.
  if (isAdmin(actor) && actor.viewingAsAgencyId === null && existing) {
    const agencyCollection = await agencies();
    const owner = await agencyCollection.findOne({ _id: existing.agencyId });
    detail.agencyName = owner?.name;
    detail.agencyId = existing.agencyId.toHexString();
  }

  await writeAudit(actor, {
    action: 'passport.duplicate_blocked',
    entity: 'passport',
    entityId: existing?._id ?? null,
    agencyId: attemptedAgencyId,
    metadata: {
      // Never the number itself; the audit entry points at the record instead.
      existingStatus: detail.status,
      crossAgency: existing ? !existing.agencyId.equals(attemptedAgencyId) : false,
    },
  });

  return new DuplicatePassportError(original, detail);
}

export interface StatusChangeOptions {
  via?: 'manual' | 'booking_import' | 'system';
  note?: string;
}

/**
 * Change a passport's status, honouring the transition table.
 *
 * `booked` cannot be reached from here by a manual path — the transition config refuses
 * it, so a crafted API call fails the same way a UI click would.
 */
export async function changePassportStatus(
  actor: Actor,
  id: ObjectId,
  to: PassportStatus,
  options: StatusChangeOptions = {},
): Promise<PassportView> {
  assertCanWrite(actor);
  const via = options.via ?? 'manual';

  if (via === 'manual' && IMPORT_ONLY_STATUSES.includes(to)) {
    throw new ForbiddenError('Only importing a booking file can mark a passport as booked.');
  }

  const collection = await passports();
  const doc = await collection.findOne(notDeleted(scopedFilter(actor, { _id: id })));
  if (!doc) throw new NotFoundError();

  const role = actor.role === 'system' ? 'admin' : actor.role;
  const check = checkTransition({ from: doc.status, to, via, role });
  if (!check.allowed) throw new ValidationError(check.reason ?? 'That change is not allowed');

  const now = new Date();
  const entry: StatusHistoryEntry = {
    status: to,
    at: now,
    actorId: actor.userId,
    actorRole: actor.role,
    via: actor.role === 'system' ? 'system' : via,
    note: options.note ?? null,
  };

  const update: Partial<PassportDoc> = { status: to, updatedAt: now };
  if (to === 'added') {
    update.addedAt = now;
    update.addedBy = actor.userId;
  }

  // Guarded on the status we read, so two concurrent changes cannot both apply.
  const after = await collection.findOneAndUpdate(
    { _id: id, status: doc.status },
    { $set: update, $push: { statusHistory: entry } },
    { returnDocument: 'after' },
  );
  if (!after) throw new ValidationError('That passport changed while you were working on it. Try again.');

  await writeAudit(actor, {
    action: 'passport.status_change',
    entity: 'passport',
    entityId: id,
    agencyId: doc.agencyId,
    before: { status: doc.status },
    after: { status: to },
    metadata: { via },
  });

  return toView(after, actor);
}

/** Agencies may edit their own passports only while they are not yet booked. */
export async function assertEditable(actor: Actor, doc: PassportDoc): Promise<void> {
  assertCanWrite(actor);
  const scope = scopeAgencyId(actor);
  if (scope && !doc.agencyId.equals(scope)) throw new NotFoundError();
  if (scope && (doc.status === 'booked' || doc.status === 'completed')) {
    throw new ForbiddenError('This passport is booked and can no longer be edited. Contact us if something is wrong.');
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
