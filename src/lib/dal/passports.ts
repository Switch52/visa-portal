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
import { agencies, passports, users } from '@/lib/db/collections';
import type { PassportDoc, StatusHistoryEntry } from '@/lib/db/types';
import { formatDateOnly, todayDateOnly } from '@/lib/dates';
import { passportInputSchema, type PassportInput } from '@/lib/schema/zod';

import {
  assertAdmin,
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
import {
  DalError,
  DuplicatePassportError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type DuplicatePassportDetail,
} from './errors';
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
  groupRef: string | null;
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
    groupRef: doc.groupRef ?? null,
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
  nationality?: string;
  submittedFrom?: Date;
  submittedTo?: Date;
  /** Matches a passport number, or a name once it is more than two characters. */
  search?: string;
  limit?: number;
  skip?: number;
}

/** One filter builder for lists and counts, so a screen's count always matches its rows. */
function buildFilter(filters: PassportFilters): Filter<PassportDoc> {
  const filter: Filter<PassportDoc> = {};

  if (filters.status) {
    filter.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
  }
  if (filters.routeId) filter.routeId = filters.routeId;
  if (filters.agencyId) filter.agencyId = filters.agencyId;
  if (filters.nationality) filter.nationality = filters.nationality.toUpperCase();

  if (filters.submittedFrom || filters.submittedTo) {
    filter.submittedAt = {
      ...(filters.submittedFrom ? { $gte: filters.submittedFrom } : {}),
      ...(filters.submittedTo ? { $lte: filters.submittedTo } : {}),
    };
  }

  const search = filters.search?.trim();
  if (search) {
    // A passport number is matched on its normalized form, so a typed space or dash still
    // finds the record. Names are matched as a prefix, case-insensitively.
    const normalized = escapeRegex(normalizePassportNumber(search));
    const name = escapeRegex(search);
    filter.$or = [
      { passportNumberNormalized: { $regex: `^${normalized}` } },
      ...(search.length > 2
        ? [
            { firstName: { $regex: `^${name}`, $options: 'i' } },
            { lastName: { $regex: `^${name}`, $options: 'i' } },
          ]
        : []),
    ];
  }

  return filter;
}

export async function listPassports(actor: Actor, filters: PassportFilters = {}): Promise<PassportView[]> {
  const collection = await passports();
  const docs = await collection
    .find(notDeleted(scopedFilter(actor, buildFilter(filters))))
    // Urgent first, then oldest first: the queue reads top-down in the order to work it.
    .sort({ priority: -1, submittedAt: -1 })
    .skip(filters.skip ?? 0)
    .limit(Math.min(filters.limit ?? 100, 500))
    .toArray();

  return docs.map((doc) => toView(doc, actor));
}

export async function countPassports(actor: Actor, filters: PassportFilters = {}): Promise<number> {
  const collection = await passports();
  return collection.countDocuments(notDeleted(scopedFilter(actor, buildFilter(filters))));
}

/** Counts per status for the current scope, for the dashboards and the list filters. */
export async function countByStatus(
  actor: Actor,
  filters: PassportFilters = {},
): Promise<Record<string, number>> {
  const collection = await passports();
  const rows = await collection
    .aggregate<{ _id: PassportStatus; count: number }>([
      { $match: notDeleted(scopedFilter(actor, buildFilter(filters))) },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    .toArray();

  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
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
    groupRef: parsed.data.groupRef || null,
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

export interface BatchRowResult {
  /** Index of the row as it sat in the grid, so an error lands on the right line. */
  index: number;
  status: 'saved' | 'blocked';
  passportId?: string;
  /** Present when blocked. Written for the person who will read it, not for a log. */
  reason?: string;
  fieldErrors?: Record<string, string[]>;
  duplicate?: DuplicatePassportDetail;
}

export interface BatchResult {
  saved: number;
  blocked: number;
  rows: BatchRowResult[];
}

/**
 * Save a batch of rows.
 *
 * The whole batch is validated, offending rows are rejected individually, and the clean
 * rows go through — one bad row does not cost someone the other twenty-nine they typed.
 * Each row is its own insert, so a duplicate blocks itself and nothing else.
 *
 * Duplicates *within* the batch are caught here as well: the second row carrying a number
 * that an earlier row in the same paste already used is blocked with the same reason, which
 * a per-row unique index alone would report as a database error nobody could read.
 */
export async function createPassports(
  actor: Actor,
  inputs: readonly PassportInput[],
  options: CreatePassportOptions = {},
): Promise<BatchResult> {
  assertCanWrite(actor);

  const rows: BatchRowResult[] = [];
  const seenInBatch = new Map<string, number>();

  for (const [index, input] of inputs.entries()) {
    const normalized = normalizePassportNumber(String(input.passportNumber ?? ''));
    const earlierRow = seenInBatch.get(normalized);

    if (earlierRow !== undefined) {
      rows.push({
        index,
        status: 'blocked',
        reason: `This passport number is already on row ${earlierRow + 1} of this batch.`,
      });
      continue;
    }

    try {
      const created = await createPassport(actor, input, options);
      seenInBatch.set(normalized, index);
      rows.push({ index, status: 'saved', passportId: created.id });
    } catch (error) {
      if (error instanceof DuplicatePassportError) {
        rows.push({
          index,
          status: 'blocked',
          reason: describeDuplicate(error.detail),
          duplicate: error.detail,
        });
        continue;
      }
      if (error instanceof ValidationError) {
        rows.push({ index, status: 'blocked', reason: error.message, fieldErrors: error.fieldErrors });
        continue;
      }
      throw error;
    }
  }

  const saved = rows.filter((row) => row.status === 'saved').length;

  await writeAudit(actor, {
    action: 'passport.create',
    entity: 'passport',
    agencyId: options.agencyId ?? actor.agencyId ?? null,
    metadata: { submitted: inputs.length, saved, blocked: inputs.length - saved },
  });

  return { saved, blocked: rows.length - saved, rows };
}

/** The message an agency reads: when it was registered and what state it is in. Never who. */
export function describeDuplicate(detail: DuplicatePassportDetail): string {
  const when = detail.submittedAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const who = detail.agencyName ? `, submitted by ${detail.agencyName}` : '';
  return `This passport is already registered in the system (submitted ${when}${who}, status: ${detail.status}). Contact us if you believe this is an error.`;
}

/**
 * Check a set of passport numbers before anything is typed further, so the grid can mark a
 * duplicate as the person moves off the cell rather than at submit time.
 *
 * The answer is the same either way — already registered, or not — and for an agency it
 * carries no clue about who registered it.
 */
export async function checkDuplicates(
  actor: Actor,
  numbers: readonly string[],
): Promise<Record<string, DuplicatePassportDetail>> {
  const normalized = [...new Set(numbers.map(normalizePassportNumber))].filter((value) => value !== '');
  if (normalized.length === 0) return {};

  const collection = await passports();
  // Deliberately unscoped: the rule is system-wide, and an agency finding out that a
  // number is taken is the point. What comes back is what they may know about it.
  const docs = await collection
    .find({ passportNumberNormalized: { $in: normalized } })
    .project<{ passportNumberNormalized: string; submittedAt: Date; status: string; agencyId: ObjectId }>({
      passportNumberNormalized: 1,
      submittedAt: 1,
      status: 1,
      agencyId: 1,
    })
    .toArray();

  const showOwner = isAdmin(actor) && actor.viewingAsAgencyId === null;
  const agencyNames = new Map<string, string>();
  if (showOwner && docs.length > 0) {
    const agencyCollection = await agencies();
    const owners = await agencyCollection
      .find({ _id: { $in: docs.map((doc) => doc.agencyId) } })
      .toArray();
    for (const owner of owners) agencyNames.set(owner._id.toHexString(), owner.name);
  }

  return Object.fromEntries(
    docs.map((doc) => [
      doc.passportNumberNormalized,
      {
        submittedAt: doc.submittedAt,
        status: doc.status,
        ...(showOwner
          ? { agencyName: agencyNames.get(doc.agencyId.toHexString()), agencyId: doc.agencyId.toHexString() }
          : {}),
      } satisfies DuplicatePassportDetail,
    ]),
  );
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

/**
 * Change several passports' statuses at once.
 *
 * Each one is decided on its own, so a row that cannot make the move reports why instead
 * of failing the whole selection — the same rule the batch save follows.
 */
export async function changePassportStatuses(
  actor: Actor,
  ids: readonly ObjectId[],
  to: PassportStatus,
  options: StatusChangeOptions = {},
): Promise<{ changed: number; failures: { id: string; reason: string }[] }> {
  assertCanWrite(actor);

  // Asking to bulk-mark anything as booked is refused before a single row is touched.
  // It is not a per-row outcome to report — the whole request is one the system does not
  // accept, whatever the rows happen to be.
  if ((options.via ?? 'manual') === 'manual' && IMPORT_ONLY_STATUSES.includes(to)) {
    throw new ForbiddenError('Only importing a booking file can mark a passport as booked.');
  }

  let changed = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const id of ids) {
    try {
      await changePassportStatus(actor, id, to, options);
      changed += 1;
    } catch (error) {
      if (error instanceof DalError) {
        failures.push({ id: id.toHexString(), reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return { changed, failures };
}

/**
 * Agencies may edit their own passports only while they are not yet booked. After booking
 * it is locked and they have to contact the admin — the details are in the other system by
 * then, and changing them here would only make the two disagree.
 */
export function assertEditable(actor: Actor, doc: PassportDoc): void {
  assertCanWrite(actor);
  const scope = scopeAgencyId(actor);
  if (scope && !doc.agencyId.equals(scope)) throw new NotFoundError();
  if (scope && (doc.status === 'booked' || doc.status === 'completed')) {
    throw new ForbiddenError(
      'This passport is booked and can no longer be edited. Contact us if something is wrong.',
    );
  }
}

/** Fields an edit may touch. The passport number is not among them — see below. */
export type PassportEdit = Partial<
  Pick<
    PassportInput,
    | 'firstName'
    | 'lastName'
    | 'passportExpiryDate'
    | 'dateOfBirth'
    | 'nationality'
    | 'gender'
    | 'contactNumber'
    | 'contactNumberDialCode'
    | 'contactEmail'
    | 'notes'
    | 'holdUntil'
    | 'priority'
    | 'applicationType'
  >
>;

/**
 * Edit a passport's details.
 *
 * The passport number itself cannot be changed here. Editing it would move the record from
 * under the unique index that has already accepted it — the honest operations are to
 * cancel the record and submit the right one, so the duplicate history stays readable.
 */
export async function updatePassport(actor: Actor, id: ObjectId, edit: PassportEdit): Promise<PassportView> {
  const collection = await passports();
  const doc = await collection.findOne(notDeleted(scopedFilter(actor, { _id: id })));
  if (!doc) throw new NotFoundError();

  assertEditable(actor, doc);

  // Validate the edit against the full record, so a change cannot make the whole thing
  // invalid — an expiry moved into the past, for instance.
  const merged = {
    firstName: edit.firstName ?? doc.firstName,
    lastName: edit.lastName ?? doc.lastName,
    passportNumber: doc.passportNumber,
    passportExpiryDate: edit.passportExpiryDate ?? formatDateOnly(doc.passportExpiryDate),
    dateOfBirth: edit.dateOfBirth ?? formatDateOnly(doc.dateOfBirth),
    nationality: edit.nationality ?? doc.nationality,
    gender: edit.gender ?? doc.gender,
    contactNumber: edit.contactNumber ?? doc.contactNumber,
    contactNumberDialCode: edit.contactNumberDialCode ?? doc.contactNumberDialCode,
    contactEmail: edit.contactEmail ?? doc.contactEmail,
    notes: edit.notes ?? doc.notes,
    holdUntil: edit.holdUntil ?? (doc.holdUntil ? formatDateOnly(doc.holdUntil) : null),
    priority: edit.priority ?? doc.priority,
    applicationType: edit.applicationType ?? doc.applicationType,
    routeId: doc.routeId.toHexString(),
  };

  const parsed = passportInputSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ValidationError('Check these details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const update: Partial<PassportDoc> = {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    passportExpiryDate: parsed.data.passportExpiryDate,
    dateOfBirth: parsed.data.dateOfBirth,
    nationality: parsed.data.nationality,
    gender: parsed.data.gender,
    contactNumber: parsed.data.contactNumber || null,
    contactNumberDialCode: parsed.data.contactNumberDialCode || null,
    contactEmail: parsed.data.contactEmail || null,
    notes: parsed.data.notes || null,
    holdUntil: parsed.data.holdUntil ?? null,
    priority: parsed.data.priority,
    applicationType: parsed.data.applicationType,
    updatedAt: new Date(),
  };

  const after = await collection.findOneAndUpdate({ _id: id }, { $set: update }, { returnDocument: 'after' });
  if (!after) throw new NotFoundError();

  await writeAudit(actor, {
    action: 'passport.update',
    entity: 'passport',
    entityId: id,
    agencyId: doc.agencyId,
    before: { status: doc.status, priority: doc.priority, holdUntil: doc.holdUntil },
    after: { status: after.status, priority: after.priority, holdUntil: after.holdUntil },
    metadata: { fields: Object.keys(edit) },
  });

  return toView(after, actor);
}

export interface StatusHistoryView {
  status: PassportStatus;
  at: Date;
  actorRole: string;
  via: string;
  note: string | null;
  actorName?: string;
}

/** A passport carries its full history, not just a current value. */
export async function getPassportHistory(actor: Actor, id: ObjectId): Promise<StatusHistoryView[]> {
  const collection = await passports();
  const doc = await collection.findOne(notDeleted(scopedFilter(actor, { _id: id })));
  if (!doc) throw new NotFoundError();

  const actorIds = doc.statusHistory.map((entry) => entry.actorId).filter((value): value is ObjectId => value !== null);
  const names = new Map<string, string>();

  if (actorIds.length > 0 && isAdmin(actor)) {
    const userCollection = await users();
    const docs = await userCollection.find({ _id: { $in: actorIds } }).toArray();
    for (const user of docs) names.set(user._id.toHexString(), user.name);
  }

  return doc.statusHistory.map((entry) => ({
    status: entry.status,
    at: entry.at,
    actorRole: entry.actorRole,
    via: entry.via,
    note: entry.note ?? null,
    // Agencies see that it happened and when, not which of our people did it.
    actorName: entry.actorId ? names.get(entry.actorId.toHexString()) : undefined,
  }));
}

/**
 * Holds that have come due.
 *
 * `holdUntil` exists so nobody has to remember: once the date passes, the passport comes
 * back into the intake queue on its own rather than sitting on hold indefinitely.
 */
export async function releaseDueHolds(actor: Actor, now = new Date()): Promise<number> {
  assertAdmin(actor);
  const collection = await passports();
  const due = await collection
    .find(notDeleted({ status: 'on_hold', holdUntil: { $ne: null, $lte: todayDateOnly(now) } }))
    .toArray();

  let released = 0;
  for (const doc of due) {
    await changePassportStatus(actor, doc._id, 'submitted', {
      via: 'system',
      note: 'Hold date passed',
    });
    released += 1;
  }
  return released;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
