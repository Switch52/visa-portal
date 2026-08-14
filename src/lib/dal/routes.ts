/**
 * Routes carry the pricing, so they are admin-only at every level: the screens, the API
 * endpoints, and here. An agency must not be able to reach a route-editing path even by
 * crafting the request directly, which is why the check lives in this layer and not in a
 * hidden button.
 *
 * Agencies see a route's label. They never see its fee.
 */

import { ObjectId } from 'mongodb';

import { countryName } from '@/config/countries';
import { routes } from '@/lib/db/collections';
import type { RouteDoc } from '@/lib/db/types';
import { routeInputSchema, type RouteInput } from '@/lib/schema/zod';

import { assertAdmin, notDeleted, type Actor } from './actor';
import { isDuplicateKey } from './agencies';
import { writeAudit } from './audit';
import { NotFoundError, ValidationError } from './errors';

/** What an agency may see. Note the absence of a fee — that is the point of the type. */
export interface RouteOption {
  id: string;
  displayLabel: string;
  active: boolean;
}

/** Admin view, with the money. */
export interface RouteDetail extends RouteOption {
  originCountry: string;
  destinationCountry: string;
  appointmentCenter: string;
  feeMinor: number;
  feeCurrency: string;
}

function normalizeCenter(center: string): string {
  return center.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** "Lebanon → France · VFS Beirut" — so three columns never have to be read as one. */
export function buildDisplayLabel(origin: string, destination: string, center: string): string {
  return `${countryName(origin) ?? origin} → ${countryName(destination) ?? destination} · ${center.trim()}`;
}

function toOption(doc: RouteDoc): RouteOption {
  return { id: doc._id.toHexString(), displayLabel: doc.displayLabel, active: doc.active };
}

function toDetail(doc: RouteDoc): RouteDetail {
  return {
    ...toOption(doc),
    originCountry: doc.originCountry,
    destinationCountry: doc.destinationCountry,
    appointmentCenter: doc.appointmentCenter,
    feeMinor: doc.feeMinor,
    feeCurrency: doc.feeCurrency,
  };
}

/** Safe for everyone: labels only, no pricing, no counts that imply anything. */
export async function listRouteOptions(_actor: Actor, includeInactive = false): Promise<RouteOption[]> {
  const collection = await routes();
  const filter = includeInactive ? notDeleted() : notDeleted({ active: true });
  const docs = await collection.find(filter).sort({ displayLabel: 1 }).toArray();
  return docs.map(toOption);
}

export async function listRoutes(actor: Actor): Promise<RouteDetail[]> {
  assertAdmin(actor);
  const collection = await routes();
  const docs = await collection.find(notDeleted()).sort({ displayLabel: 1 }).toArray();
  return docs.map(toDetail);
}

export async function getRoute(actor: Actor, id: ObjectId): Promise<RouteDetail> {
  assertAdmin(actor);
  const collection = await routes();
  const doc = await collection.findOne(notDeleted({ _id: id }));
  if (!doc) throw new NotFoundError();
  return toDetail(doc);
}

/** Used when pricing a charge: the fee is copied onto the charge at that moment. */
export async function getRouteForPricing(id: ObjectId): Promise<RouteDoc | null> {
  const collection = await routes();
  return collection.findOne(notDeleted({ _id: id }));
}

export async function createRoute(actor: Actor, input: RouteInput): Promise<RouteDetail> {
  assertAdmin(actor);
  const parsed = routeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check the route details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const now = new Date();
  const doc: Omit<RouteDoc, '_id'> = {
    originCountry: parsed.data.originCountry,
    destinationCountry: parsed.data.destinationCountry,
    appointmentCenter: parsed.data.appointmentCenter.trim(),
    centerNormalized: normalizeCenter(parsed.data.appointmentCenter),
    displayLabel: buildDisplayLabel(
      parsed.data.originCountry,
      parsed.data.destinationCountry,
      parsed.data.appointmentCenter,
    ),
    feeMinor: parsed.data.feeMinor,
    feeCurrency: parsed.data.feeCurrency,
    active: parsed.data.active,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await routes();
  try {
    const result = await collection.insertOne(doc as RouteDoc);
    await writeAudit(actor, {
      action: 'route.create',
      entity: 'route',
      entityId: result.insertedId,
      after: { label: doc.displayLabel, feeMinor: doc.feeMinor, feeCurrency: doc.feeCurrency },
    });
    return toDetail({ ...doc, _id: result.insertedId } as RouteDoc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new ValidationError('That origin, destination and center already exist as a route', {
        appointmentCenter: ['This route already exists'],
      });
    }
    throw error;
  }
}

/**
 * Editing a fee affects future charges only. Charges store the amount they were created
 * with, so nothing already on a ledger moves when this runs.
 */
export async function updateRoute(actor: Actor, id: ObjectId, input: Partial<RouteInput>): Promise<RouteDetail> {
  assertAdmin(actor);
  const parsed = routeInputSchema.partial().safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Check the route details', parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const collection = await routes();
  const before = await collection.findOne(notDeleted({ _id: id }));
  if (!before) throw new NotFoundError();

  const merged = { ...before, ...parsed.data };
  const update: Partial<RouteDoc> = {
    ...parsed.data,
    centerNormalized: normalizeCenter(merged.appointmentCenter),
    displayLabel: buildDisplayLabel(merged.originCountry, merged.destinationCountry, merged.appointmentCenter),
    updatedAt: new Date(),
  };

  try {
    const after = await collection.findOneAndUpdate({ _id: id }, { $set: update }, { returnDocument: 'after' });
    if (!after) throw new NotFoundError();
    await writeAudit(actor, {
      action: 'route.update',
      entity: 'route',
      entityId: id,
      before: { label: before.displayLabel, feeMinor: before.feeMinor, feeCurrency: before.feeCurrency },
      after: { label: after.displayLabel, feeMinor: after.feeMinor, feeCurrency: after.feeCurrency },
      metadata: { appliesTo: 'future charges only' },
    });
    return toDetail(after);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new ValidationError('That origin, destination and center already exist as a route', {
        appointmentCenter: ['This route already exists'],
      });
    }
    throw error;
  }
}
