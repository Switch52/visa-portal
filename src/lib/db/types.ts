/**
 * Document shapes, as they are stored.
 *
 * Conventions that hold across every collection:
 *  - money is `amountMinor` (integer) + `currency`, never a bare number;
 *  - dates are real `Date`s in UTC, date-only values at midnight UTC;
 *  - normalized forms are stored explicitly beside the original, never derived on read;
 *  - deletion is soft (`deletedAt`), and nothing with a charge, booking or audit entry
 *    against it is hard-deleted without an explicit irreversible confirmation.
 */

import type { ObjectId } from 'mongodb';

import type { PassportStatus } from '@/config/statuses';
import type { ApplicationType, Gender, Priority } from '@/config/validation';

export type Role = 'admin' | 'agency';

export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface AgencyDoc extends Timestamps {
  _id: ObjectId;
  name: string;
  /** Lowercased name, unique — stops "Karam" and "karam" becoming two agencies. */
  nameNormalized: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** Pre-fills the payments form. Any individual payment can override it. */
  defaultCurrency: string;
  /** Admin-only. Never returned to an agency, about themselves or anyone else. */
  internalNotes?: string | null;
  active: boolean;
}

export interface UserDoc extends Timestamps {
  _id: ObjectId;
  name: string;
  email: string;
  /** Lowercased and trimmed at write time; the unique index is on this field. */
  emailNormalized: string;
  role: Role;
  /** Null for admins. Required for agency users — enforced by the $jsonSchema validator. */
  agencyId: ObjectId | null;
  active: boolean;
  lastLoginAt?: Date | null;
  invitedBy?: ObjectId | null;
  invitedAt?: Date | null;
}

export interface RouteDoc extends Timestamps {
  _id: ObjectId;
  originCountry: string;
  destinationCountry: string;
  appointmentCenter: string;
  /** Uniqueness is the three parts together; the same pair at two centers is two routes. */
  centerNormalized: string;
  displayLabel: string;
  feeMinor: number;
  feeCurrency: string;
  active: boolean;
}

export interface StatusHistoryEntry {
  status: PassportStatus;
  at: Date;
  /** Null when the portal itself made the move (a hold date passing). */
  actorId: ObjectId | null;
  actorRole: Role | 'system';
  via: 'manual' | 'booking_import' | 'system' | 'migration';
  note?: string | null;
}

export interface PassportSourceRow {
  file: string;
  sheet: string;
  rowNumber: number;
  /** The raw original row, so any value can be traced back to the exact cell. */
  raw: Record<string, string>;
  importBatchId?: ObjectId | null;
}

export interface PassportDoc extends Timestamps {
  _id: ObjectId;

  // Fields the main dashboard's importer requires.
  firstName: string;
  lastName: string;
  passportNumber: string;
  /** Uppercased, whitespace and dashes stripped. The unique index is on this field. */
  passportNumberNormalized: string;
  passportExpiryDate: Date;
  dateOfBirth: Date;
  nationality: string;
  gender: Gender;
  contactNumber?: string | null;
  contactNumberDialCode?: string | null;
  contactEmail?: string | null;

  // Ours, never exported.
  agencyId: ObjectId;
  routeId: ObjectId;
  submittedAt: Date;
  submittedBy: ObjectId | null;
  applicationType: ApplicationType;
  /**
   * Shared by the members of one family application, so they travel together through the
   * queue, the export and the booking file. Null for a single applicant.
   */
  groupRef?: string | null;
  priority: Priority;
  /** "Don't start before this date." Surfaces automatically once it passes. */
  holdUntil?: Date | null;
  notes?: string | null;
  status: PassportStatus;
  statusHistory: StatusHistoryEntry[];

  /** Set when the passport is handed off to the main dashboard. */
  addedAt?: Date | null;
  addedBy?: ObjectId | null;
  /** Set only by a booking import. */
  bookingId?: ObjectId | null;

  source?: PassportSourceRow | null;
}

export interface BookingDoc {
  _id: ObjectId;
  passportId: ObjectId;
  agencyId: ObjectId;
  /** A real instant, not a date-only value. */
  appointmentAt: Date;
  /** The center's timezone, recorded alongside so the instant can be read back locally. */
  timezone: string;
  location: string;
  reference?: string | null;
  importBatchId: ObjectId;
  recordedBy: ObjectId | null;
  createdAt: Date;
  /**
   * Set when the import that created this booking is undone. The row stays as evidence
   * that it happened and was reversed, rather than vanishing from the record.
   */
  undoneAt?: Date | null;
  undoneBy?: ObjectId | null;
  /** The raw row it came from, so any value can be traced back to the file. */
  source?: { file: string; sheet: string; rowNumber: number; raw: Record<string, string> } | null;
}

/**
 * What a ledger line is.
 *
 *  - `charge`          — one booked passport, priced from its route.
 *  - `opening_balance` — what an agency owed on the cutover date, carried across from the
 *    old payments sheet as a single dated line rather than reconstructed history.
 *  - `credit`          — a reduction the admin grants, with a reason.
 */
export type LedgerEntryType = 'charge' | 'opening_balance' | 'credit';

export interface ChargeDoc {
  _id: ObjectId;
  type: LedgerEntryType;
  agencyId: ObjectId;
  /** Null for an opening balance or a credit: they belong to no single passport. */
  passportId: ObjectId | null;
  bookingId: ObjectId | null;
  routeId: ObjectId | null;
  /** Shown on the ledger line — the "why" behind a number that has no passport. */
  description?: string | null;
  /**
   * Copied from the route at the moment of booking, never read back through the route.
   * Editing a route's price later must not rewrite what an agency already owes.
   */
  amountMinor: number;
  currency: string;
  chargedAt: Date;
  createdBy: ObjectId | null;
  importBatchId: ObjectId | null;
  /** Reversal keeps the entry and marks it, so the ledger reads as history rather than edits. */
  voidedAt?: Date | null;
  voidedBy?: ObjectId | null;
  voidReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentDoc {
  _id: ObjectId;
  agencyId: ObjectId;
  /** Integer minor units. A payment is never a bare number. */
  amountMinor: number;
  currency: string;
  /** Date-only, at midnight UTC: the day the money was received. */
  receivedAt: Date;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  recordedBy: ObjectId | null;
  /**
   * Supplied by the form, unique per submission. A double-click cannot record the same
   * payment twice — the unique index refuses the second write.
   */
  idempotencyKey: string;
  /** Reversal keeps the row and marks it, so the ledger reads as history. */
  voidedAt?: Date | null;
  voidedBy?: ObjectId | null;
  voidReason?: string | null;
  /** Set only when a payment is recorded against one specific charge. */
  appliesToChargeId?: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ImportBatchStatus = 'committed' | 'undone';

export interface ImportBatchDoc {
  _id: ObjectId;
  filename: string;
  /** SHA-256 of the uploaded bytes: re-uploading the same file is recognised, not repeated. */
  fileHash: string;
  sheetName?: string | null;
  uploadedBy: ObjectId | null;
  uploadedAt: Date;
  status: ImportBatchStatus;
  counts: {
    rowsInFile: number;
    matched: number;
    booked: number;
    unmatched: number;
    alreadyBooked: number;
    skipped: number;
  };
  undoneAt?: Date | null;
  undoneBy?: ObjectId | null;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  /** Only the hash is stored; the raw token lives in the user's cookie and nowhere else. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt?: Date | null;
  ipHash?: string | null;
  userAgent?: string | null;
  /** Set while the admin is viewing the portal as an agency. Read-only by construction. */
  viewingAsAgencyId?: ObjectId | null;
  viewAsStartedAt?: Date | null;
}

export interface OtpDoc {
  _id: ObjectId;
  emailNormalized: string;
  /** Hashed; compared in constant time. */
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  consumedAt?: Date | null;
  invalidatedAt?: Date | null;
  ipHash?: string | null;
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  windowStart: Date;
  expiresAt: Date;
}

export interface AuditLogDoc {
  _id: ObjectId;
  at: Date;
  actorId: ObjectId | null;
  actorRole: Role | 'system';
  /** Present when the action happened inside a view-as session. */
  onBehalfOfAgencyId?: ObjectId | null;
  action: string;
  entity: string;
  entityId: ObjectId | null;
  agencyId: ObjectId | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface SettingsDoc {
  _id: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: ObjectId | null;
}
