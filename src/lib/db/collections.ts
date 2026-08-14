/**
 * Typed collection handles. The only module that touches the Mongo client directly,
 * aside from the migration runner.
 *
 * These are still unscoped — they hand back a raw collection. Everything in the
 * application reaches them through `src/lib/dal`, which applies the agency scope.
 */

import type { ClientSession, Collection, Db } from 'mongodb';

import { getDb, getMongoClient } from '@/lib/mongodb';

import type {
  AgencyDoc,
  AuditLogDoc,
  BookingDoc,
  ChargeDoc,
  ImportBatchDoc,
  OtpDoc,
  PassportDoc,
  PaymentDoc,
  RateLimitDoc,
  RouteDoc,
  SessionDoc,
  SettingsDoc,
  UserDoc,
} from './types';

export const COLLECTIONS = {
  agencies: 'agencies',
  users: 'users',
  routes: 'routes',
  passports: 'passports',
  bookings: 'bookings',
  charges: 'charges',
  importBatches: 'import_batches',
  payments: 'payments',
  sessions: 'sessions',
  otps: 'otps',
  rateLimits: 'rate_limits',
  auditLog: 'audit_log',
  settings: 'settings',
} as const;

export async function db(): Promise<Db> {
  return getDb();
}

export async function agencies(): Promise<Collection<AgencyDoc>> {
  return (await getDb()).collection<AgencyDoc>(COLLECTIONS.agencies);
}

export async function users(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>(COLLECTIONS.users);
}

export async function routes(): Promise<Collection<RouteDoc>> {
  return (await getDb()).collection<RouteDoc>(COLLECTIONS.routes);
}

export async function passports(): Promise<Collection<PassportDoc>> {
  return (await getDb()).collection<PassportDoc>(COLLECTIONS.passports);
}

export async function bookings(): Promise<Collection<BookingDoc>> {
  return (await getDb()).collection<BookingDoc>(COLLECTIONS.bookings);
}

export async function charges(): Promise<Collection<ChargeDoc>> {
  return (await getDb()).collection<ChargeDoc>(COLLECTIONS.charges);
}

export async function importBatches(): Promise<Collection<ImportBatchDoc>> {
  return (await getDb()).collection<ImportBatchDoc>(COLLECTIONS.importBatches);
}

export async function payments(): Promise<Collection<PaymentDoc>> {
  return (await getDb()).collection<PaymentDoc>(COLLECTIONS.payments);
}

export async function sessions(): Promise<Collection<SessionDoc>> {
  return (await getDb()).collection<SessionDoc>(COLLECTIONS.sessions);
}

export async function otps(): Promise<Collection<OtpDoc>> {
  return (await getDb()).collection<OtpDoc>(COLLECTIONS.otps);
}

export async function rateLimits(): Promise<Collection<RateLimitDoc>> {
  return (await getDb()).collection<RateLimitDoc>(COLLECTIONS.rateLimits);
}

export async function auditLog(): Promise<Collection<AuditLogDoc>> {
  return (await getDb()).collection<AuditLogDoc>(COLLECTIONS.auditLog);
}

export async function settings(): Promise<Collection<SettingsDoc>> {
  return (await getDb()).collection<SettingsDoc>(COLLECTIONS.settings);
}

/**
 * Run a unit of work in a transaction.
 *
 * Booking a passport writes a booking, changes a status, creates a charge and appends to
 * the audit log — those either all happen or none do. Atlas replica sets support this on
 * the free tier. A single-node local mongod does not, so the helper falls back to running
 * the work without a session rather than failing outright; production is always a replica set.
 */
export async function withTransaction<T>(work: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  const client = await getMongoClient();
  const session = client.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result!;
  } catch (error) {
    if (isTransactionsUnsupported(error)) {
      return work(undefined);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

function isTransactionsUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return (
    message.includes('Transaction numbers are only allowed on a replica set') ||
    message.includes('Transactions are not supported')
  );
}
