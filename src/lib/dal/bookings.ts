/**
 * Bulk booking import — the reconciliation feature, and the part that currently goes
 * wrong most, so it is built defensively.
 *
 * The order is fixed and the first step writes nothing:
 *
 *   1. parse the file and match rows to passports by normalized passport number;
 *   2. **preview**: how many matched, which will be booked, which matched nothing, and
 *      critically which are already booked — the accidental double-bookings;
 *   3. commit, as one batch, only on confirmation;
 *   4. undo the whole batch in one action if the wrong file went in.
 *
 * Booking a passport writes four things: a booking, a status change, a charge, and an
 * audit entry. They happen together or not at all — a passport that is charged but not
 * booked, or booked with no charge, is exactly the tangle this system exists to avoid.
 */

import { createHash } from 'node:crypto';

import { ObjectId, type ClientSession } from 'mongodb';

import { bookings, charges, importBatches, passports, routes, withTransaction } from '@/lib/db/collections';
import type { BookingDoc, ChargeDoc, ImportBatchDoc, PassportDoc } from '@/lib/db/types';
import { parseBookingFile, type ParsedBookingRow, type ParseResult } from '@/lib/import/parse';
import { DEFAULT_BOOKING_IMPORT_TEMPLATE, type BookingImportTemplate } from '@/lib/import/mapping';

import { assertAdmin, notDeleted, type Actor } from './actor';
import { writeAudit } from './audit';
import { NotFoundError, ValidationError } from './errors';

export function hashFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export type PreviewOutcome = 'will_book' | 'already_booked' | 'unmatched' | 'not_bookable' | 'rejected_row';

export interface PreviewRow {
  rowNumber: number;
  passportNumber: string;
  outcome: PreviewOutcome;
  reason?: string;
  appointmentAt: Date | null;
  location: string;
  reference: string;
  /** Present when the row matched a passport we hold. */
  passportId?: string;
  agencyId?: string;
  passportName?: string;
  currentStatus?: string;
  /** For an already-booked passport: the booking it already has. */
  existingBooking?: {
    appointmentAt: Date;
    location: string;
    reference: string | null;
    importedAt: Date;
  };
  /** What the charge would be, priced from the passport's route at this moment. */
  charge?: { amountMinor: number; currency: string };
}

export interface ImportPreview {
  fileHash: string;
  filename: string;
  sheetName: string | null;
  headerRow: number;
  recognisedColumns: { field: string; header: string }[];
  unknownColumns: string[];
  fileProblems: { rowNumber: number | null; message: string }[];
  rows: PreviewRow[];
  counts: Record<PreviewOutcome, number> & { rowsInFile: number };
  /** Set when this exact file has already been committed. */
  alreadyImported?: { batchId: string; uploadedAt: Date; filename: string };
  charges: { currency: string; amountMinor: number; count: number }[];
}

/**
 * Read a file and work out what committing it would do. Writes nothing.
 */
export async function previewImport(
  actor: Actor,
  file: { buffer: Buffer; filename: string },
  template: BookingImportTemplate = DEFAULT_BOOKING_IMPORT_TEMPLATE,
): Promise<ImportPreview> {
  assertAdmin(actor);

  const parsed: ParseResult = await parseBookingFile(file, template);
  const fileHash = hashFile(file.buffer);

  const batchCollection = await importBatches();
  const existingBatch = await batchCollection.findOne({ fileHash, status: 'committed' });

  const passportCollection = await passports();
  const numbers = parsed.rows.map((row) => row.passportNumberNormalized);
  const matches = await passportCollection
    .find(notDeleted({ passportNumberNormalized: { $in: numbers } }))
    .toArray();
  const byNumber = new Map(matches.map((doc) => [doc.passportNumberNormalized, doc]));

  const bookingCollection = await bookings();
  const liveBookings = await bookingCollection
    .find({ passportId: { $in: matches.map((doc) => doc._id) }, undoneAt: null })
    .toArray();
  const bookingByPassport = new Map(liveBookings.map((doc) => [doc.passportId.toHexString(), doc]));

  const routeCollection = await routes();
  const routeDocs = await routeCollection.find({}).toArray();
  const routeById = new Map(routeDocs.map((route) => [route._id.toHexString(), route]));

  const rows: PreviewRow[] = [];

  // Rows the parser could not use at all still appear, so nothing disappears silently.
  for (const row of parsed.rejected) {
    rows.push({
      rowNumber: row.rowNumber,
      passportNumber: row.passportNumber,
      outcome: 'rejected_row',
      reason: row.problems.join('; '),
      appointmentAt: row.appointmentAt,
      location: row.location,
      reference: row.reference,
    });
  }

  for (const row of parsed.rows) {
    const passport = byNumber.get(row.passportNumberNormalized);

    if (!passport) {
      rows.push({
        rowNumber: row.rowNumber,
        passportNumber: row.passportNumber,
        outcome: 'unmatched',
        reason: 'No passport in the portal carries this number',
        appointmentAt: row.appointmentAt,
        location: row.location,
        reference: row.reference,
      });
      continue;
    }

    const base: PreviewRow = {
      rowNumber: row.rowNumber,
      passportNumber: row.passportNumber,
      outcome: 'will_book',
      appointmentAt: row.appointmentAt,
      location: row.location,
      reference: row.reference,
      passportId: passport._id.toHexString(),
      agencyId: passport.agencyId.toHexString(),
      passportName: `${passport.firstName} ${passport.lastName}`,
      currentStatus: passport.status,
    };

    // The one the preview exists for: already booked, and excluded by default.
    const existing = bookingByPassport.get(passport._id.toHexString());
    if (existing || passport.status === 'booked') {
      rows.push({
        ...base,
        outcome: 'already_booked',
        reason: 'This passport already has a confirmed booking',
        existingBooking: existing
          ? {
              appointmentAt: existing.appointmentAt,
              location: existing.location,
              reference: existing.reference ?? null,
              importedAt: existing.createdAt,
            }
          : undefined,
      });
      continue;
    }

    if (passport.status === 'cancelled' || passport.status === 'rejected' || passport.status === 'completed') {
      rows.push({
        ...base,
        outcome: 'not_bookable',
        reason: `This passport is ${passport.status}`,
      });
      continue;
    }

    const route = routeById.get(passport.routeId.toHexString());
    rows.push({
      ...base,
      charge: route ? { amountMinor: route.feeMinor, currency: route.feeCurrency } : undefined,
      reason: route ? undefined : 'No route fee found — this row cannot be charged',
    });
  }

  rows.sort((a, b) => a.rowNumber - b.rowNumber);

  const counts = {
    will_book: rows.filter((row) => row.outcome === 'will_book').length,
    already_booked: rows.filter((row) => row.outcome === 'already_booked').length,
    unmatched: rows.filter((row) => row.outcome === 'unmatched').length,
    not_bookable: rows.filter((row) => row.outcome === 'not_bookable').length,
    rejected_row: rows.filter((row) => row.outcome === 'rejected_row').length,
    rowsInFile: parsed.rowsInFile,
  };

  // Charges are shown per currency and never summed across them.
  const chargeTotals = new Map<string, { amountMinor: number; count: number }>();
  for (const row of rows) {
    if (row.outcome !== 'will_book' || !row.charge) continue;
    const current = chargeTotals.get(row.charge.currency) ?? { amountMinor: 0, count: 0 };
    current.amountMinor += row.charge.amountMinor;
    current.count += 1;
    chargeTotals.set(row.charge.currency, current);
  }

  return {
    fileHash,
    filename: file.filename,
    sheetName: parsed.sheetName,
    headerRow: parsed.headerRow,
    recognisedColumns: parsed.recognisedColumns,
    unknownColumns: parsed.unknownColumns,
    fileProblems: parsed.problems,
    rows,
    counts,
    alreadyImported: existingBatch
      ? {
          batchId: existingBatch._id.toHexString(),
          uploadedAt: existingBatch.uploadedAt,
          filename: existingBatch.filename,
        }
      : undefined,
    charges: [...chargeTotals.entries()]
      .map(([currency, totals]) => ({ currency, ...totals }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

export interface CommitResult {
  batchId: string;
  booked: number;
  skipped: number;
  charges: { currency: string; amountMinor: number; count: number }[];
  failures: { rowNumber: number; passportNumber: string; reason: string }[];
  /** Set when the file had already been committed and nothing was done. */
  noop?: { batchId: string; uploadedAt: Date };
}

/**
 * Commit an import.
 *
 * Re-uploading a file that was already committed is a no-op — recognised by its hash, and
 * backed by a unique index so two simultaneous uploads cannot both commit it.
 */
export async function commitImport(
  actor: Actor,
  file: { buffer: Buffer; filename: string },
  options: { template?: BookingImportTemplate; only?: string[] } = {},
): Promise<CommitResult> {
  assertAdmin(actor);

  const preview = await previewImport(actor, file, options.template);

  if (preview.alreadyImported) {
    return {
      batchId: preview.alreadyImported.batchId,
      booked: 0,
      skipped: preview.counts.rowsInFile,
      charges: [],
      failures: [],
      noop: {
        batchId: preview.alreadyImported.batchId,
        uploadedAt: preview.alreadyImported.uploadedAt,
      },
    };
  }

  const selected = new Set(options.only ?? []);
  const toBook = preview.rows.filter(
    (row) => row.outcome === 'will_book' && (selected.size === 0 || selected.has(row.passportId!)),
  );

  if (toBook.length === 0) {
    throw new ValidationError('Nothing in that file would be booked.');
  }

  const batchCollection = await importBatches();
  const batchId = new ObjectId();
  const now = new Date();

  const batch: ImportBatchDoc = {
    _id: batchId,
    filename: file.filename,
    fileHash: preview.fileHash,
    sheetName: preview.sheetName,
    uploadedBy: actor.userId,
    uploadedAt: now,
    status: 'committed',
    counts: {
      rowsInFile: preview.counts.rowsInFile,
      matched: toBook.length + preview.counts.already_booked + preview.counts.not_bookable,
      booked: 0,
      unmatched: preview.counts.unmatched,
      alreadyBooked: preview.counts.already_booked,
      skipped: preview.counts.rejected_row + preview.counts.not_bookable,
    },
  };

  try {
    await batchCollection.insertOne(batch);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      // The unique index caught a simultaneous commit of the same file.
      const existing = await batchCollection.findOne({ fileHash: preview.fileHash, status: 'committed' });
      return {
        batchId: existing!._id.toHexString(),
        booked: 0,
        skipped: preview.counts.rowsInFile,
        charges: [],
        failures: [],
        noop: { batchId: existing!._id.toHexString(), uploadedAt: existing!.uploadedAt },
      };
    }
    throw error;
  }

  const failures: CommitResult['failures'] = [];
  let booked = 0;

  for (const row of toBook) {
    try {
      await bookOnePassport(actor, row, batchId, file.filename, preview.sheetName);
      booked += 1;
    } catch (error) {
      failures.push({
        rowNumber: row.rowNumber,
        passportNumber: row.passportNumber,
        reason: error instanceof Error ? error.message : 'Could not book this row',
      });
    }
  }

  await batchCollection.updateOne({ _id: batchId }, { $set: { 'counts.booked': booked } });

  const chargeTotals = new Map<string, { amountMinor: number; count: number }>();
  for (const row of toBook.slice(0, booked)) {
    if (!row.charge) continue;
    const current = chargeTotals.get(row.charge.currency) ?? { amountMinor: 0, count: 0 };
    current.amountMinor += row.charge.amountMinor;
    current.count += 1;
    chargeTotals.set(row.charge.currency, current);
  }

  await writeAudit(actor, {
    action: 'booking.import',
    entity: 'import_batch',
    entityId: batchId,
    metadata: {
      filename: file.filename,
      fileHash: preview.fileHash,
      booked,
      unmatched: preview.counts.unmatched,
      alreadyBooked: preview.counts.already_booked,
      failed: failures.length,
    },
  });

  return {
    batchId: batchId.toHexString(),
    booked,
    skipped: preview.counts.rowsInFile - booked,
    charges: [...chargeTotals.entries()].map(([currency, totals]) => ({ currency, ...totals })),
    failures,
  };
}

/**
 * One passport's booking: the booking row, the status change, the charge and the audit
 * entry, in a single transaction. Either all four land or none do.
 */
async function bookOnePassport(
  actor: Actor,
  row: PreviewRow,
  batchId: ObjectId,
  filename: string,
  sheetName: string | null,
): Promise<void> {
  const passportId = new ObjectId(row.passportId!);

  await withTransaction(async (session?: ClientSession) => {
    const passportCollection = await passports();
    const bookingCollection = await bookings();
    const chargeCollection = await charges();
    const routeCollection = await routes();

    const passport = await passportCollection.findOne({ _id: passportId }, { session });
    if (!passport) throw new NotFoundError();
    // Re-checked inside the transaction: the preview may be seconds old.
    if (passport.status === 'booked') throw new Error('This passport was booked while the preview was open');

    const route = await routeCollection.findOne({ _id: passport.routeId }, { session });
    if (!route) throw new Error('The route this passport is on no longer exists');

    const now = new Date();
    const bookingId = new ObjectId();

    const booking: BookingDoc = {
      _id: bookingId,
      passportId,
      agencyId: passport.agencyId,
      appointmentAt: row.appointmentAt ?? now,
      timezone: DEFAULT_BOOKING_IMPORT_TEMPLATE.timezone,
      location: row.location || route.appointmentCenter,
      reference: row.reference || null,
      importBatchId: batchId,
      recordedBy: actor.userId,
      createdAt: now,
      undoneAt: null,
      undoneBy: null,
      source: { file: filename, sheet: sheetName ?? '', rowNumber: row.rowNumber, raw: {} },
    };
    await bookingCollection.insertOne(booking, { session });

    // The charge stores the fee it was created with, copied from the route at this
    // moment. A later price change must not rewrite what this agency owes.
    const charge: ChargeDoc = {
      _id: new ObjectId(),
      agencyId: passport.agencyId,
      passportId,
      bookingId,
      routeId: route._id,
      amountMinor: route.feeMinor,
      currency: route.feeCurrency,
      chargedAt: now,
      createdBy: actor.userId,
      importBatchId: batchId,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await chargeCollection.insertOne(charge, { session });

    const updated = await passportCollection.updateOne(
      // Guarded on the status we saw, so two imports cannot both book it.
      { _id: passportId, status: { $ne: 'booked' } },
      {
        $set: { status: 'booked', bookingId, updatedAt: now },
        $push: {
          statusHistory: {
            status: 'booked' as const,
            at: now,
            actorId: actor.userId,
            actorRole: actor.role,
            via: 'booking_import' as const,
            note: `Imported from ${filename}`,
          },
        },
      },
      { session },
    );
    if (updated.modifiedCount === 0) throw new Error('This passport was booked while the preview was open');

    await writeAudit(
      actor,
      {
        action: 'booking.import',
        entity: 'passport',
        entityId: passportId,
        agencyId: passport.agencyId,
        before: { status: passport.status },
        after: { status: 'booked' },
        metadata: { batchId: batchId.toHexString(), amountMinor: charge.amountMinor, currency: charge.currency },
      },
      session,
    );
  });
}

export interface UndoResult {
  batchId: string;
  bookingsUndone: number;
  chargesVoided: number;
  passportsReverted: number;
}

/**
 * Undo a whole import.
 *
 * The bookings and charges stay as marked-reversed evidence rather than disappearing, the
 * passports return to `added` — where they were before the file arrived — and the money
 * goes with them. A rolled-back booking must not leave anything owed.
 */
export async function undoImport(actor: Actor, batchId: ObjectId): Promise<UndoResult> {
  assertAdmin(actor);

  const batchCollection = await importBatches();
  const batch = await batchCollection.findOne({ _id: batchId });
  if (!batch) throw new NotFoundError();
  if (batch.status === 'undone') throw new ValidationError('That import has already been undone.');

  const bookingCollection = await bookings();
  const chargeCollection = await charges();
  const passportCollection = await passports();

  const batchBookings = await bookingCollection.find({ importBatchId: batchId, undoneAt: null }).toArray();
  const now = new Date();

  let bookingsUndone = 0;
  let chargesVoided = 0;
  let passportsReverted = 0;

  for (const booking of batchBookings) {
    await withTransaction(async (session?: ClientSession) => {
      await bookingCollection.updateOne(
        { _id: booking._id },
        { $set: { undoneAt: now, undoneBy: actor.userId } },
        { session },
      );
      bookingsUndone += 1;

      const voided = await chargeCollection.updateMany(
        { bookingId: booking._id, voidedAt: null },
        {
          $set: {
            voidedAt: now,
            voidedBy: actor.userId,
            voidReason: `Import ${batch.filename} was undone`,
            updatedAt: now,
          },
        },
        { session },
      );
      chargesVoided += voided.modifiedCount;

      const reverted = await passportCollection.updateOne(
        { _id: booking.passportId, status: 'booked' },
        {
          $set: { status: 'added', bookingId: null, updatedAt: now },
          $push: {
            statusHistory: {
              status: 'added' as const,
              at: now,
              actorId: actor.userId,
              actorRole: actor.role,
              via: 'booking_import' as const,
              note: `Import ${batch.filename} undone`,
            },
          },
        },
        { session },
      );
      passportsReverted += reverted.modifiedCount;
    });
  }

  await batchCollection.updateOne(
    { _id: batchId },
    { $set: { status: 'undone', undoneAt: now, undoneBy: actor.userId } },
  );

  await writeAudit(actor, {
    action: 'booking.import_undo',
    entity: 'import_batch',
    entityId: batchId,
    metadata: { filename: batch.filename, bookingsUndone, chargesVoided, passportsReverted },
  });

  return {
    batchId: batchId.toHexString(),
    bookingsUndone,
    chargesVoided,
    passportsReverted,
  };
}

export interface BatchSummary {
  id: string;
  filename: string;
  uploadedAt: Date;
  status: string;
  counts: ImportBatchDoc['counts'];
  undoneAt: Date | null;
}

export async function listImportBatches(actor: Actor, limit = 50): Promise<BatchSummary[]> {
  assertAdmin(actor);
  const collection = await importBatches();
  const docs = await collection.find({}).sort({ uploadedAt: -1 }).limit(limit).toArray();

  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    filename: doc.filename,
    uploadedAt: doc.uploadedAt,
    status: doc.status,
    counts: doc.counts,
    undoneAt: doc.undoneAt ?? null,
  }));
}

/** The booking behind a passport, for its detail screen. */
export async function getBookingForPassport(passportId: ObjectId): Promise<BookingDoc | null> {
  const collection = await bookings();
  return collection.findOne({ passportId, undoneAt: null });
}

export type { PassportDoc, ParsedBookingRow };
