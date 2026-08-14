/**
 * Agencies. Admin-only to create or edit; an agency can read exactly one record — its own —
 * and never learns that any other agency exists.
 */

import { ObjectId } from 'mongodb';

import { agencyInputSchema, type AgencyInput } from '@/lib/schema/zod';
import { agencies } from '@/lib/db/collections';
import type { AgencyDoc } from '@/lib/db/types';

import { assertAdmin, notDeleted, scopeAgencyId, type Actor } from './actor';
import { writeAudit } from './audit';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';

export interface AgencySummary {
  id: string;
  name: string;
  defaultCurrency: string;
  active: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

/** What an agency user is allowed to see about their own agency: no internal notes. */
function toSummary(doc: AgencyDoc): AgencySummary {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    defaultCurrency: doc.defaultCurrency,
    active: doc.active,
    contactName: doc.contactName ?? null,
    contactEmail: doc.contactEmail ?? null,
    contactPhone: doc.contactPhone ?? null,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Listing agencies is admin-only, and stays that way even in a view-as session: an
 * agency-shaped view must never be able to enumerate the client list.
 */
export async function listAgencies(actor: Actor): Promise<AgencySummary[]> {
  if (actor.role !== 'admin' || actor.viewingAsAgencyId !== null) throw new ForbiddenError();
  const collection = await agencies();
  const docs = await collection.find(notDeleted()).sort({ name: 1 }).toArray();
  return docs.map(toSummary);
}

/** An agency user may only ever resolve their own agency. */
export async function getAgency(actor: Actor, id: ObjectId): Promise<AgencySummary> {
  const scope = scopeAgencyId(actor);
  if (scope && !scope.equals(id)) throw new NotFoundError();

  const collection = await agencies();
  const doc = await collection.findOne(notDeleted({ _id: id }));
  if (!doc) throw new NotFoundError();
  return toSummary(doc);
}

/** The agency attached to the current actor, for their own dashboard. */
export async function getOwnAgency(actor: Actor): Promise<AgencySummary | null> {
  const scope = scopeAgencyId(actor);
  if (!scope) return null;
  return getAgency(actor, scope);
}

export async function createAgency(actor: Actor, input: AgencyInput): Promise<AgencySummary> {
  assertAdmin(actor);
  const parsed = agencyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check the agency details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const now = new Date();
  const doc: Omit<AgencyDoc, '_id'> = {
    name: parsed.data.name,
    nameNormalized: normalizeName(parsed.data.name),
    contactName: parsed.data.contactName || null,
    contactEmail: parsed.data.contactEmail || null,
    contactPhone: parsed.data.contactPhone || null,
    defaultCurrency: parsed.data.defaultCurrency,
    internalNotes: parsed.data.internalNotes || null,
    active: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await agencies();
  try {
    const result = await collection.insertOne(doc as AgencyDoc);
    const created = { ...doc, _id: result.insertedId } as AgencyDoc;
    await writeAudit(actor, {
      action: 'agency.create',
      entity: 'agency',
      entityId: result.insertedId,
      agencyId: result.insertedId,
      after: { name: created.name, defaultCurrency: created.defaultCurrency },
    });
    return toSummary(created);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new ValidationError('An agency with that name already exists', { name: ['Already in use'] });
    }
    throw error;
  }
}

export async function updateAgency(
  actor: Actor,
  id: ObjectId,
  input: Partial<AgencyInput>,
): Promise<AgencySummary> {
  assertAdmin(actor);
  const parsed = agencyInputSchema.partial().safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check the agency details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const collection = await agencies();
  const before = await collection.findOne(notDeleted({ _id: id }));
  if (!before) throw new NotFoundError();

  const update: Partial<AgencyDoc> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.name) update.nameNormalized = normalizeName(parsed.data.name);

  const after = await collection.findOneAndUpdate(
    { _id: id },
    { $set: update },
    { returnDocument: 'after' },
  );
  if (!after) throw new NotFoundError();

  await writeAudit(actor, {
    action: 'agency.update',
    entity: 'agency',
    entityId: id,
    agencyId: id,
    before: { name: before.name, defaultCurrency: before.defaultCurrency, active: before.active },
    after: { name: after.name, defaultCurrency: after.defaultCurrency, active: after.active },
  });
  return toSummary(after);
}

export async function setAgencyActive(actor: Actor, id: ObjectId, active: boolean): Promise<AgencySummary> {
  assertAdmin(actor);
  const collection = await agencies();
  const after = await collection.findOneAndUpdate(
    notDeleted({ _id: id }),
    { $set: { active, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!after) throw new NotFoundError();

  await writeAudit(actor, {
    action: 'agency.deactivate',
    entity: 'agency',
    entityId: id,
    agencyId: id,
    after: { active },
  });
  return toSummary(after);
}

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
