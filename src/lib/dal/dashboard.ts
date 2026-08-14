/**
 * The numbers on the two home screens.
 *
 * Everything here goes through the scoped layer, so the admin's figures cover every agency
 * and an agency's cover only their own — from the same calls, rather than from a second
 * set of queries that has to be kept in step by hand.
 *
 * Nothing is cached. Counts and totals are computed on read: at this scale that is free,
 * and a stale cached total that disagrees with its own ledger is a support nightmare.
 */

import { ObjectId } from 'mongodb';

import { auditLog, passports } from '@/lib/db/collections';
import { todayDateOnly } from '@/lib/dates';
import type { PassportStatus } from '@/config/statuses';

import { assertAdmin, notDeleted, scopeAgencyId, scopedFilter, type Actor } from './actor';
import { getBalanceOverview, getAgencyBalance, type CurrencyBalance } from './ledger';

const DAY = 24 * 60 * 60 * 1000;

export interface ActivityEntry {
  id: string;
  at: Date;
  action: string;
  entity: string;
  agencyId: string | null;
  actorRole: string;
  summary: string;
}

export interface AdminDashboard {
  readyToHandOff: number;
  addedAwaitingBooking: number;
  submittedToday: number;
  submittedThisWeek: number;
  onHold: number;
  holdsDueToday: number;
  /** Blocked duplicate attempts in the last week — the ones worth a look. */
  blockedDuplicates: number;
  crossAgencyDuplicates: number;
  bookedThisWeek: number;
  balances: CurrencyBalance[];
  activity: ActivityEntry[];
}

function since(days: number): Date {
  return new Date(Date.now() - days * DAY);
}

const ACTIVITY_SUMMARY: Record<string, string> = {
  'passport.create': 'Passports submitted',
  'passport.status_change': 'Status changed',
  'passport.duplicate_blocked': 'Duplicate passport blocked',
  'passport.export': 'Handoff exported',
  'booking.import': 'Booking file imported',
  'booking.import_undo': 'Import undone',
  'payment.record': 'Payment recorded',
  'payment.delete': 'Payment reversed',
  'user.invite': 'User invited',
  'user.deactivate': 'User deactivated',
  'user.reactivate': 'User reactivated',
  'agency.create': 'Agency added',
  'agency.update': 'Agency updated',
  'route.create': 'Route added',
  'route.update': 'Route updated',
  'auth.login': 'Signed in',
  'auth.blocked_unknown_email': 'Sign-in attempt from an unknown email',
  'viewas.start': 'Started viewing as an agency',
  'viewas.end': 'Left the agency view',
};

export async function getAdminDashboard(actor: Actor): Promise<AdminDashboard> {
  assertAdmin(actor);

  const collection = await passports();
  const audit = await auditLog();
  const today = todayDateOnly();

  const [
    readyToHandOff,
    addedAwaitingBooking,
    submittedToday,
    submittedThisWeek,
    onHold,
    holdsDueToday,
    bookedThisWeek,
    blockedDuplicates,
    crossAgencyDuplicates,
    { totals },
    activityDocs,
  ] = await Promise.all([
    collection.countDocuments(notDeleted({ status: 'ready' })),
    collection.countDocuments(notDeleted({ status: 'added' })),
    collection.countDocuments(notDeleted({ submittedAt: { $gte: today } })),
    collection.countDocuments(notDeleted({ submittedAt: { $gte: since(7) } })),
    collection.countDocuments(notDeleted({ status: 'on_hold' })),
    collection.countDocuments(notDeleted({ status: 'on_hold', holdUntil: { $lte: today } })),
    collection.countDocuments(notDeleted({ status: 'booked', updatedAt: { $gte: since(7) } })),
    audit.countDocuments({ action: 'passport.duplicate_blocked', at: { $gte: since(7) } }),
    audit.countDocuments({
      action: 'passport.duplicate_blocked',
      at: { $gte: since(7) },
      'metadata.crossAgency': true,
    }),
    getBalanceOverview(actor),
    audit.find({}).sort({ at: -1 }).limit(25).toArray(),
  ]);

  return {
    readyToHandOff,
    addedAwaitingBooking,
    submittedToday,
    submittedThisWeek,
    onHold,
    holdsDueToday,
    blockedDuplicates,
    crossAgencyDuplicates,
    bookedThisWeek,
    balances: totals,
    activity: activityDocs.map((doc) => ({
      id: doc._id.toHexString(),
      at: doc.at,
      action: doc.action,
      entity: doc.entity,
      agencyId: doc.agencyId?.toHexString() ?? null,
      actorRole: doc.actorRole,
      summary: ACTIVITY_SUMMARY[doc.action] ?? doc.action,
    })),
  };
}

export interface AgencyDashboard {
  byStatus: Record<string, number>;
  booked: number;
  submittedThisWeek: number;
  balances: CurrencyBalance[];
  /** Things the agency needs to act on, in the order they should act on them. */
  attention: { label: string; count: number; href: string }[];
}

export async function getAgencyDashboard(actor: Actor): Promise<AgencyDashboard> {
  const scope = scopeAgencyId(actor);
  if (!scope) throw new Error('getAgencyDashboard needs an agency-scoped actor');

  const collection = await passports();
  const today = todayDateOnly();

  const [statusRows, submittedThisWeek, holdsPassed, balances] = await Promise.all([
    collection
      .aggregate<{ _id: PassportStatus; count: number }>([
        { $match: notDeleted(scopedFilter(actor, {})) },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray(),
    collection.countDocuments(notDeleted(scopedFilter(actor, { submittedAt: { $gte: since(7) } }))),
    collection.countDocuments(
      notDeleted(scopedFilter(actor, { status: 'on_hold', holdUntil: { $lte: today } })),
    ),
    getAgencyBalance(actor, scope),
  ]);

  const byStatus = Object.fromEntries(statusRows.map((row) => [row._id, row.count]));

  const attention = [
    {
      label: 'On hold with a date that has passed',
      count: holdsPassed,
      href: '/passports?status=on_hold',
    },
    {
      label: 'Waiting for us to take them in',
      count: byStatus.submitted ?? 0,
      href: '/passports?status=submitted',
    },
  ].filter((item) => item.count > 0);

  return {
    byStatus,
    booked: byStatus.booked ?? 0,
    submittedThisWeek,
    balances,
    attention,
  };
}

export interface AgencyRow {
  id: string;
  name: string;
  active: boolean;
  submitted: number;
  booked: number;
  onHold: number;
  balances: CurrencyBalance[];
}

/** One row per agency for the admin list: what they have sent, and what they owe. */
export async function getAgencyRows(actor: Actor): Promise<AgencyRow[]> {
  assertAdmin(actor);

  const { agencies } = await import('@/lib/db/collections');
  const agencyCollection = await agencies();
  const agencyDocs = await agencyCollection.find(notDeleted()).sort({ name: 1 }).toArray();

  const collection = await passports();
  const counts = await collection
    .aggregate<{ _id: { agencyId: ObjectId; status: PassportStatus }; count: number }>([
      { $match: notDeleted({}) },
      { $group: { _id: { agencyId: '$agencyId', status: '$status' }, count: { $sum: 1 } } },
    ])
    .toArray();

  const { rows: balanceRows } = await getBalanceOverview(actor);
  const balancesByAgency = new Map(balanceRows.map((row) => [row.agencyId, row.balances]));

  return agencyDocs.map((doc) => {
    const id = doc._id.toHexString();
    const forAgency = counts.filter((row) => row._id.agencyId.equals(doc._id));
    const total = (status: PassportStatus) =>
      forAgency.find((row) => row._id.status === status)?.count ?? 0;

    return {
      id,
      name: doc.name,
      active: doc.active,
      submitted: forAgency.reduce((sum, row) => sum + row.count, 0),
      booked: total('booked'),
      onHold: total('on_hold'),
      balances: balancesByAgency.get(id) ?? [],
    };
  });
}
