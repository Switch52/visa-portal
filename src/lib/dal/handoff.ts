/**
 * The handoff queue: getting passports out of this portal and into the main booking
 * dashboard.
 *
 * This is the most repetitive job of the week and the place records currently go missing,
 * so the shape here follows the real workflow rather than a tidy abstraction:
 *
 *   1. work a route at a time — the queue groups by route;
 *   2. select a batch and export it as CSV — exporting changes no statuses at all;
 *   3. enter it into the other system;
 *   4. then, deliberately, mark those rows `added`.
 *
 * Steps 2 and 4 are separate on purpose. Exporting is not the same as having actually
 * entered them, and conflating the two is exactly how a batch gets marked done after an
 * interruption that stopped halfway. Re-exporting the same batch is always safe.
 */

import { ObjectId, type Filter } from 'mongodb';

import { passports, routes } from '@/lib/db/collections';
import type { PassportDoc } from '@/lib/db/types';
import { todayDateOnly } from '@/lib/dates';
import type { ExportableRecord } from '@/lib/export/template';

import { assertAdmin, notDeleted, type Actor } from './actor';
import { writeAudit } from './audit';
import { NotFoundError, ValidationError } from './errors';

/** How long a row has been waiting, so what is going stale is obvious at a glance. */
export interface QueueEntry {
  id: string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  nationality: string;
  agencyId: string;
  priority: string;
  submittedAt: Date;
  waitingDays: number;
  holdUntil: Date | null;
}

export interface QueueGroup {
  routeId: string;
  routeLabel: string;
  entries: QueueEntry[];
  /** The oldest wait in the group — what makes a route worth doing next. */
  oldestWaitingDays: number;
  urgentCount: number;
}

const DAY = 24 * 60 * 60 * 1000;

function waitingDays(submittedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - submittedAt.getTime()) / DAY);
}

/**
 * Everything `ready` but not yet `added`, across every agency, grouped by route.
 *
 * Agencies are not named here even though this is an admin screen: the queue is about
 * getting rows into the other system, and the passport is the unit of work.
 */
export async function getHandoffQueue(actor: Actor, now = new Date()): Promise<QueueGroup[]> {
  assertAdmin(actor);

  const collection = await passports();
  const docs = await collection
    .find(notDeleted({ status: 'ready' }))
    .sort({ priority: -1, submittedAt: 1 })
    .toArray();

  const routeCollection = await routes();
  const routeDocs = await routeCollection.find({}).toArray();
  const labels = new Map(routeDocs.map((route) => [route._id.toHexString(), route.displayLabel]));

  const groups = new Map<string, QueueGroup>();
  for (const doc of docs) {
    const routeId = doc.routeId.toHexString();
    const entry: QueueEntry = {
      id: doc._id.toHexString(),
      firstName: doc.firstName,
      lastName: doc.lastName,
      passportNumber: doc.passportNumber,
      nationality: doc.nationality,
      agencyId: doc.agencyId.toHexString(),
      priority: doc.priority,
      submittedAt: doc.submittedAt,
      waitingDays: waitingDays(doc.submittedAt, now),
      holdUntil: doc.holdUntil ?? null,
    };

    const group = groups.get(routeId) ?? {
      routeId,
      routeLabel: labels.get(routeId) ?? 'Unknown route',
      entries: [],
      oldestWaitingDays: 0,
      urgentCount: 0,
    };
    group.entries.push(entry);
    group.oldestWaitingDays = Math.max(group.oldestWaitingDays, entry.waitingDays);
    if (entry.priority === 'urgent') group.urgentCount += 1;
    groups.set(routeId, group);
  }

  // Longest-waiting route first: the queue reads top-down in the order to work it.
  return [...groups.values()].sort((a, b) => b.oldestWaitingDays - a.oldestWaitingDays);
}

export interface QueueSummary {
  readyCount: number;
  addedAwaitingBooking: number;
  onHold: number;
  holdsDueToday: number;
  oldestWaitingDays: number;
}

export async function getHandoffSummary(actor: Actor, now = new Date()): Promise<QueueSummary> {
  assertAdmin(actor);
  const collection = await passports();

  const [readyCount, addedAwaitingBooking, onHold, holdsDueToday, oldest] = await Promise.all([
    collection.countDocuments(notDeleted({ status: 'ready' })),
    collection.countDocuments(notDeleted({ status: 'added' })),
    collection.countDocuments(notDeleted({ status: 'on_hold' })),
    collection.countDocuments(notDeleted({ status: 'on_hold', holdUntil: { $lte: todayDateOnly(now) } })),
    collection.find(notDeleted({ status: 'ready' })).sort({ submittedAt: 1 }).limit(1).toArray(),
  ]);

  return {
    readyCount,
    addedAwaitingBooking,
    onHold,
    holdsDueToday,
    oldestWaitingDays: oldest[0] ? waitingDays(oldest[0].submittedAt, now) : 0,
  };
}

/** The records for an export, in the order they will appear in the file. */
export async function getExportRecords(
  actor: Actor,
  filter: { ids?: ObjectId[]; routeId?: ObjectId; status?: PassportDoc['status'] },
): Promise<{ records: ExportableRecord[]; ids: ObjectId[]; routeLabel: string | null }> {
  assertAdmin(actor);

  const query: Filter<PassportDoc> = {};
  if (filter.ids && filter.ids.length > 0) query._id = { $in: filter.ids };
  if (filter.routeId) query.routeId = filter.routeId;
  if (filter.status) query.status = filter.status;

  const collection = await passports();
  const docs = await collection.find(notDeleted(query)).sort({ lastName: 1, firstName: 1 }).toArray();

  let routeLabel: string | null = null;
  const routeIds = new Set(docs.map((doc) => doc.routeId.toHexString()));
  if (routeIds.size === 1) {
    const routeCollection = await routes();
    const route = await routeCollection.findOne({ _id: docs[0]!.routeId });
    routeLabel = route?.displayLabel ?? null;
  }

  return {
    // Only the fields the other system's importer takes. Nothing of ours travels.
    records: docs.map((doc) => ({
      firstName: doc.firstName,
      lastName: doc.lastName,
      passportNumber: doc.passportNumber,
      passportExpiryDate: doc.passportExpiryDate,
      dateOfBirth: doc.dateOfBirth,
      nationality: doc.nationality,
      gender: doc.gender,
      contactNumber: doc.contactNumber,
      contactNumberDialCode: doc.contactNumberDialCode,
      contactEmail: doc.contactEmail,
    })),
    ids: docs.map((doc) => doc._id),
    routeLabel,
  };
}

/** Every export is written to the audit log: who, when, which passports, how many. */
export async function recordExport(
  actor: Actor,
  ids: ObjectId[],
  meta: { filename: string; source: string },
): Promise<void> {
  await writeAudit(actor, {
    action: 'passport.export',
    entity: 'passport',
    metadata: {
      count: ids.length,
      // Ids, not numbers or names: the audit log points at records rather than repeating
      // their contents.
      passportIds: ids.map((id) => id.toHexString()),
      filename: meta.filename,
      source: meta.source,
    },
  });
}

export interface MarkAddedResult {
  marked: number;
  /** Rows that were already `added`, with when and by whom. Not an error — just already done. */
  alreadyAdded: { id: string; addedAt: Date | null }[];
  failures: { id: string; reason: string }[];
}

/**
 * Mark a batch as handed off.
 *
 * Idempotent by construction: the update is guarded on the row still being `ready`, so a
 * double-click, a retry, or marking a batch that was already marked moves nothing twice.
 * A row already `added` is reported as such rather than failing the batch.
 */
export async function markAsAdded(actor: Actor, ids: readonly ObjectId[]): Promise<MarkAddedResult> {
  assertAdmin(actor);
  if (ids.length === 0) throw new ValidationError('Select some passports first');

  const collection = await passports();
  const docs = await collection.find(notDeleted({ _id: { $in: [...ids] } })).toArray();
  if (docs.length === 0) throw new NotFoundError();

  const now = new Date();
  const alreadyAdded: MarkAddedResult['alreadyAdded'] = [];
  const failures: MarkAddedResult['failures'] = [];
  const toMark: ObjectId[] = [];

  for (const doc of docs) {
    if (doc.status === 'added') {
      alreadyAdded.push({ id: doc._id.toHexString(), addedAt: doc.addedAt ?? null });
      continue;
    }
    if (doc.status !== 'ready') {
      failures.push({
        id: doc._id.toHexString(),
        reason: `Only passports that are ready can be marked as added; this one is ${doc.status}.`,
      });
      continue;
    }
    toMark.push(doc._id);
  }

  let marked = 0;
  if (toMark.length > 0) {
    const result = await collection.updateMany(
      // Guarded on `ready`: two people clicking at once cannot both apply the change.
      { _id: { $in: toMark }, status: 'ready' },
      {
        $set: { status: 'added', addedAt: now, addedBy: actor.userId, updatedAt: now },
        $push: {
          statusHistory: {
            status: 'added',
            at: now,
            actorId: actor.userId,
            actorRole: actor.role,
            via: 'manual',
            note: 'Marked as added after a handoff export',
          },
        },
      },
    );
    marked = result.modifiedCount;
  }

  await writeAudit(actor, {
    action: 'passport.status_change',
    entity: 'passport',
    metadata: {
      to: 'added',
      marked,
      alreadyAdded: alreadyAdded.length,
      failed: failures.length,
      passportIds: toMark.map((id) => id.toHexString()),
    },
  });

  return { marked, alreadyAdded, failures };
}
