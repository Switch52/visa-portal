/**
 * Payments, charges and balances.
 *
 * **This is a tracking ledger, not a payment system.** Money changes hands outside the
 * portal entirely: there is no processor, no card details, no bank details, and no "pay
 * now" anywhere. The only job here is to record what was charged, record what came in, and
 * show the difference.
 *
 * Two rules shape everything below:
 *
 *   - **Balances are derived, never stored.** A stored total that disagrees with its own
 *     ledger is a support nightmare; at this scale, deriving costs nothing.
 *   - **Currencies never mix.** Balances are per currency and are never summed across
 *     them. If an agency owes 400 USD and 250 EUR, that is two balances side by side, not
 *     one invented number — the system never applies a rate it was not given.
 */

import { randomUUID } from 'node:crypto';

import { ObjectId, type Filter } from 'mongodb';

import { charges, payments } from '@/lib/db/collections';
import type { ChargeDoc, LedgerEntryType, PaymentDoc } from '@/lib/db/types';
import { convertForDisplay, type Money } from '@/lib/money';
import { parseDateOnly, todayDateOnly } from '@/lib/dates';
import { isSupportedCurrency } from '@/config/currencies';

import { assertAdmin, notDeleted, scopeAgencyId, type Actor } from './actor';
import { writeAudit } from './audit';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { getDisplayRate } from './settings';

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface CurrencyBalance {
  currency: string;
  chargedMinor: number;
  paidMinor: number;
  /** Charged minus paid. Positive means the agency owes us. */
  outstandingMinor: number;
}

export interface AgencyBalance {
  agencyId: string;
  agencyName?: string;
  balances: CurrencyBalance[];
}

/** The agency an actor may read, or an explicit one for an admin. */
function resolveScope(actor: Actor, requested?: ObjectId | null): ObjectId | null {
  const scope = scopeAgencyId(actor);
  if (scope) {
    if (requested && !requested.equals(scope)) throw new NotFoundError();
    return scope;
  }
  return requested ?? null;
}

/**
 * Work out balances from the rows themselves, per agency and per currency.
 *
 * Voided charges and voided payments are excluded — which is what makes an undone import
 * leave nothing owed, without deleting the evidence that it happened.
 */
export async function getBalances(actor: Actor, agencyId?: ObjectId | null): Promise<AgencyBalance[]> {
  const scope = resolveScope(actor, agencyId);
  const match: Filter<ChargeDoc> = scope ? { agencyId: scope } : {};

  const chargeCollection = await charges();
  const chargeRows = await chargeCollection
    .aggregate<{ _id: { agencyId: ObjectId; currency: string; type: LedgerEntryType }; total: number }>([
      { $match: { ...match, voidedAt: null } },
      { $group: { _id: { agencyId: '$agencyId', currency: '$currency', type: '$type' }, total: { $sum: '$amountMinor' } } },
    ])
    .toArray();

  const paymentCollection = await payments();
  const paymentRows = await paymentCollection
    .aggregate<{ _id: { agencyId: ObjectId; currency: string }; total: number }>([
      { $match: { ...(scope ? { agencyId: scope } : {}), voidedAt: null } },
      { $group: { _id: { agencyId: '$agencyId', currency: '$currency' }, total: { $sum: '$amountMinor' } } },
    ])
    .toArray();

  const byAgency = new Map<string, Map<string, CurrencyBalance>>();
  const bucket = (agency: ObjectId, currency: string): CurrencyBalance => {
    const key = agency.toHexString();
    const currencies = byAgency.get(key) ?? new Map<string, CurrencyBalance>();
    const entry = currencies.get(currency) ?? {
      currency,
      chargedMinor: 0,
      paidMinor: 0,
      outstandingMinor: 0,
    };
    currencies.set(currency, entry);
    byAgency.set(key, currencies);
    return entry;
  };

  for (const row of chargeRows) {
    const entry = bucket(row._id.agencyId, row._id.currency);
    // A credit reduces what is owed; a charge and an opening balance increase it.
    if (row._id.type === 'credit') entry.chargedMinor -= row.total;
    else entry.chargedMinor += row.total;
  }
  for (const row of paymentRows) {
    bucket(row._id.agencyId, row._id.currency).paidMinor += row.total;
  }

  return [...byAgency.entries()].map(([agency, currencies]) => ({
    agencyId: agency,
    balances: [...currencies.values()]
      .map((entry) => ({ ...entry, outstandingMinor: entry.chargedMinor - entry.paidMinor }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }));
}

export async function getAgencyBalance(actor: Actor, agencyId: ObjectId): Promise<CurrencyBalance[]> {
  const [balance] = await getBalances(actor, agencyId);
  return balance?.balances ?? [];
}

/**
 * The indicative EGP figure shown beside a real amount.
 *
 * Display only: computed for reading, never stored on a charge or a payment, never used to
 * settle anything, never the basis of a balance. If the rate changes, only the display
 * changes and no ledger entry moves.
 */
export async function toDisplayEgp(amount: Money): Promise<{ amount: Money; rate: number; rateUpdatedAt: string } | null> {
  const rate = await getDisplayRate();
  if (amount.currency !== rate.base) return null;
  return {
    amount: convertForDisplay(amount, rate.rate, rate.quote),
    rate: rate.rate,
    rateUpdatedAt: rate.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The line-by-line ledger
// ---------------------------------------------------------------------------

export interface LedgerLine {
  id: string;
  kind: 'charge' | 'opening_balance' | 'credit' | 'payment';
  at: Date;
  description: string;
  currency: string;
  /** What the line adds to what is owed. Payments and credits are negative. */
  deltaMinor: number;
  reference?: string | null;
  method?: string | null;
  note?: string | null;
  passportId?: string;
  voided: boolean;
  voidReason?: string | null;
}

/** Everything behind an agency's balance, newest first. */
export async function getLedger(actor: Actor, agencyId: ObjectId, limit = 500): Promise<LedgerLine[]> {
  const scope = resolveScope(actor, agencyId);
  if (!scope) throw new ValidationError('Choose an agency');

  const chargeCollection = await charges();
  const paymentCollection = await payments();

  const [chargeDocs, paymentDocs] = await Promise.all([
    chargeCollection.find({ agencyId: scope }).sort({ chargedAt: -1 }).limit(limit).toArray(),
    paymentCollection.find({ agencyId: scope }).sort({ receivedAt: -1 }).limit(limit).toArray(),
  ]);

  const lines: LedgerLine[] = [
    ...chargeDocs.map((doc) => ({
      id: doc._id.toHexString(),
      kind: doc.type,
      at: doc.chargedAt,
      description:
        doc.description ??
        (doc.type === 'charge'
          ? 'Booking fee'
          : doc.type === 'opening_balance'
            ? 'Opening balance at cutover'
            : 'Credit'),
      currency: doc.currency,
      deltaMinor: doc.type === 'credit' ? -doc.amountMinor : doc.amountMinor,
      passportId: doc.passportId?.toHexString(),
      voided: Boolean(doc.voidedAt),
      voidReason: doc.voidReason ?? null,
    })),
    ...paymentDocs.map((doc) => ({
      id: doc._id.toHexString(),
      kind: 'payment' as const,
      at: doc.receivedAt,
      description: 'Payment received',
      currency: doc.currency,
      deltaMinor: -doc.amountMinor,
      reference: doc.reference ?? null,
      method: doc.method ?? null,
      note: doc.note ?? null,
      voided: Boolean(doc.voidedAt),
      voidReason: doc.voidReason ?? null,
    })),
  ];

  return lines.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ---------------------------------------------------------------------------
// Recording money
// ---------------------------------------------------------------------------

export interface PaymentInput {
  agencyId: string;
  amountMinor: number;
  currency: string;
  /** `YYYY-MM-DD`. Defaults to today. */
  receivedAt?: string;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  /** Generated by the form; the same key twice records one payment, not two. */
  idempotencyKey?: string;
  /** Optional: settle one specific charge. Its currency must match. */
  appliesToChargeId?: string | null;
}

export interface RecordedPayment {
  id: string;
  duplicate: boolean;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Record a payment that arrived outside the portal.
 *
 * A payment settles charges in its own currency only — confirmed, no exceptions. When one
 * is pointed at a specific charge, a currency mismatch is refused with a clear error
 * rather than converted at some rate nobody agreed.
 */
export async function recordPayment(actor: Actor, input: PaymentInput): Promise<RecordedPayment> {
  assertAdmin(actor);

  const currency = input.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new ValidationError('Choose a currency', { currency: ['Unsupported currency'] });
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError('Enter an amount above zero', { amount: ['Enter an amount above zero'] });
  }
  if (!ObjectId.isValid(input.agencyId)) {
    throw new ValidationError('Choose an agency', { agencyId: ['Choose an agency'] });
  }

  const receivedAt = input.receivedAt ? parseDateOnly(input.receivedAt) : todayDateOnly();
  if (receivedAt > todayDateOnly()) {
    throw new ValidationError('That date is in the future', { receivedAt: ['That date is in the future'] });
  }

  let appliesToChargeId: ObjectId | null = null;
  if (input.appliesToChargeId) {
    const chargeCollection = await charges();
    const charge = await chargeCollection.findOne({ _id: new ObjectId(input.appliesToChargeId) });
    if (!charge) throw new NotFoundError();

    if (charge.currency !== currency) {
      // The rule, enforced rather than assumed.
      throw new ValidationError(
        `That charge is in ${charge.currency}. A payment settles charges in its own currency only — record this as a ${charge.currency} payment, or apply it elsewhere.`,
        { currency: [`Charge is in ${charge.currency}`] },
      );
    }
    appliesToChargeId = charge._id;
  }

  const now = new Date();
  const doc: PaymentDoc = {
    _id: new ObjectId(),
    agencyId: new ObjectId(input.agencyId),
    amountMinor: input.amountMinor,
    currency,
    receivedAt,
    method: input.method || null,
    reference: input.reference || null,
    note: input.note || null,
    recordedBy: actor.userId,
    idempotencyKey: input.idempotencyKey || newIdempotencyKey(),
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    appliesToChargeId,
    createdAt: now,
    updatedAt: now,
  };

  const collection = await payments();
  try {
    await collection.insertOne(doc);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      // The same submission arriving twice. The first one stands; this is not an error.
      const existing = await collection.findOne({ idempotencyKey: doc.idempotencyKey });
      return {
        id: existing!._id.toHexString(),
        duplicate: true,
        amountMinor: existing!.amountMinor,
        currency: existing!.currency,
        receivedAt: existing!.receivedAt,
      };
    }
    throw error;
  }

  await writeAudit(actor, {
    action: 'payment.record',
    entity: 'payment',
    entityId: doc._id,
    agencyId: doc.agencyId,
    after: { amountMinor: doc.amountMinor, currency: doc.currency, receivedAt: doc.receivedAt },
  });

  return {
    id: doc._id.toHexString(),
    duplicate: false,
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    receivedAt: doc.receivedAt,
  };
}

/** Reverse a payment, keeping the row so the ledger still reads as history. */
export async function voidPayment(actor: Actor, paymentId: ObjectId, reason: string): Promise<void> {
  assertAdmin(actor);
  if (!reason.trim()) throw new ValidationError('Say why this payment is being reversed');

  const collection = await payments();
  const doc = await collection.findOneAndUpdate(
    { _id: paymentId, voidedAt: null },
    { $set: { voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason.trim(), updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!doc) throw new NotFoundError();

  await writeAudit(actor, {
    action: 'payment.delete',
    entity: 'payment',
    entityId: paymentId,
    agencyId: doc.agencyId,
    metadata: { reason: reason.trim(), amountMinor: doc.amountMinor, currency: doc.currency },
  });
}

export interface LedgerEntryInput {
  agencyId: string;
  amountMinor: number;
  currency: string;
  description: string;
  /** `YYYY-MM-DD`. Defaults to today. */
  at?: string;
}

/**
 * The opening balance carried across at cutover.
 *
 * One dated line per agency per currency, labelled as such, rather than a reconstructed
 * history — the old sheets cannot say which passport produced which charge, and inventing
 * that is inventing data. Everything after cutover is generated from real bookings.
 */
export async function recordOpeningBalance(actor: Actor, input: LedgerEntryInput): Promise<string> {
  return createLedgerEntry(actor, input, 'opening_balance');
}

/** A credit against what an agency owes, with a reason on the line. */
export async function recordCredit(actor: Actor, input: LedgerEntryInput): Promise<string> {
  return createLedgerEntry(actor, input, 'credit');
}

async function createLedgerEntry(
  actor: Actor,
  input: LedgerEntryInput,
  type: Exclude<LedgerEntryType, 'charge'>,
): Promise<string> {
  assertAdmin(actor);

  const currency = input.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) throw new ValidationError('Unsupported currency');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError('Enter an amount above zero');
  }
  if (!input.description.trim()) throw new ValidationError('Say what this entry is for');

  const now = new Date();
  const doc: ChargeDoc = {
    _id: new ObjectId(),
    type,
    agencyId: new ObjectId(input.agencyId),
    passportId: null,
    bookingId: null,
    routeId: null,
    description: input.description.trim(),
    amountMinor: input.amountMinor,
    currency,
    chargedAt: input.at ? parseDateOnly(input.at) : now,
    createdBy: actor.userId,
    importBatchId: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: now,
    updatedAt: now,
  };

  const collection = await charges();
  await collection.insertOne(doc);

  await writeAudit(actor, {
    action: 'payment.record',
    entity: 'charge',
    entityId: doc._id,
    agencyId: doc.agencyId,
    after: { type, amountMinor: doc.amountMinor, currency: doc.currency, description: doc.description },
  });

  return doc._id.toHexString();
}

// ---------------------------------------------------------------------------
// Reading payments
// ---------------------------------------------------------------------------

export interface PaymentView {
  id: string;
  agencyId: string;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  method: string | null;
  reference: string | null;
  note: string | null;
  voided: boolean;
  voidReason: string | null;
}

export async function listPayments(
  actor: Actor,
  filters: { agencyId?: ObjectId; limit?: number } = {},
): Promise<PaymentView[]> {
  const scope = resolveScope(actor, filters.agencyId);
  if (!scope && actor.role !== 'admin' && actor.role !== 'system') throw new ForbiddenError();

  const collection = await payments();
  const docs = await collection
    .find(scope ? { agencyId: scope } : {})
    .sort({ receivedAt: -1, createdAt: -1 })
    .limit(Math.min(filters.limit ?? 100, 500))
    .toArray();

  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    agencyId: doc.agencyId.toHexString(),
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    receivedAt: doc.receivedAt,
    method: doc.method ?? null,
    reference: doc.reference ?? null,
    note: doc.note ?? null,
    voided: Boolean(doc.voidedAt),
    voidReason: doc.voidReason ?? null,
  }));
}

/** The admin overview: every agency's balance, worst first. */
export async function getBalanceOverview(
  actor: Actor,
): Promise<{ rows: AgencyBalance[]; totals: CurrencyBalance[] }> {
  assertAdmin(actor);

  const { agencies } = await import('@/lib/db/collections');
  const agencyCollection = await agencies();
  const agencyDocs = await agencyCollection.find(notDeleted()).toArray();
  const names = new Map(agencyDocs.map((doc) => [doc._id.toHexString(), doc.name]));

  const balances = await getBalances(actor);
  const rows = balances
    .map((row) => ({ ...row, agencyName: names.get(row.agencyId) ?? 'Unknown agency' }))
    .sort((a, b) => {
      const owedA = Math.max(...a.balances.map((balance) => balance.outstandingMinor), 0);
      const owedB = Math.max(...b.balances.map((balance) => balance.outstandingMinor), 0);
      return owedB - owedA;
    });

  // Totals are per currency. There is deliberately no grand total across currencies.
  const totals = new Map<string, CurrencyBalance>();
  for (const row of rows) {
    for (const balance of row.balances) {
      const entry = totals.get(balance.currency) ?? {
        currency: balance.currency,
        chargedMinor: 0,
        paidMinor: 0,
        outstandingMinor: 0,
      };
      entry.chargedMinor += balance.chargedMinor;
      entry.paidMinor += balance.paidMinor;
      entry.outstandingMinor += balance.outstandingMinor;
      totals.set(balance.currency, entry);
    }
  }

  return { rows, totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}
