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
