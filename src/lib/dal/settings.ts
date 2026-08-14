/**
 * Admin-editable settings, stored one document per key.
 *
 * Only two things live here so far: the export column template, and the hand-maintained
 * display exchange rate. Both are things the admin changes without a deploy.
 */

import { settings } from '@/lib/db/collections';
import {
  DEFAULT_EXPORT_TEMPLATE,
  EXPORT_TEMPLATE_KEY,
  validateTemplate,
  type ExportTemplate,
} from '@/lib/export/template';
import { DEFAULT_DISPLAY_RATE } from '@/config/currencies';

import { assertAdmin, type Actor } from './actor';
import { writeAudit } from './audit';
import { ValidationError } from './errors';

/**
 * The export template. Falls back to the shipped default until it has been edited, so a
 * fresh install exports the right format without anyone configuring anything.
 */
export async function getExportTemplate(): Promise<ExportTemplate> {
  const collection = await settings();
  const doc = await collection.findOne({ _id: EXPORT_TEMPLATE_KEY });
  if (!doc) return DEFAULT_EXPORT_TEMPLATE;

  try {
    return validateTemplate(doc.value);
  } catch {
    // A stored template that no longer parses must not stop the export; the default is
    // always a working format.
    return DEFAULT_EXPORT_TEMPLATE;
  }
}

export async function saveExportTemplate(actor: Actor, template: unknown): Promise<ExportTemplate> {
  assertAdmin(actor);

  let validated: ExportTemplate;
  try {
    validated = validateTemplate(template);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'That template is not valid');
  }

  const before = await getExportTemplate();
  const collection = await settings();
  await collection.updateOne(
    { _id: EXPORT_TEMPLATE_KEY },
    { $set: { value: validated, updatedAt: new Date(), updatedBy: actor.userId } },
    { upsert: true },
  );

  await writeAudit(actor, {
    action: 'route.update',
    entity: 'settings',
    metadata: {
      key: EXPORT_TEMPLATE_KEY,
      beforeHeaders: before.columns.map((column) => column.header),
      afterHeaders: validated.columns.map((column) => column.header),
    },
  });

  return validated;
}

export async function resetExportTemplate(actor: Actor): Promise<ExportTemplate> {
  assertAdmin(actor);
  return saveExportTemplate(actor, DEFAULT_EXPORT_TEMPLATE);
}

export interface DisplayRate {
  base: string;
  quote: string;
  rate: number;
  updatedAt: string;
}

/**
 * The single display-only conversion rate, maintained by hand.
 *
 * Figures computed from it are indicative and labelled as such — never stored on a charge
 * or a payment, never used to settle anything, never the basis of a balance.
 */
export async function getDisplayRate(): Promise<DisplayRate> {
  const collection = await settings();
  const doc = await collection.findOne({ _id: 'display_rate' });
  return (doc?.value as DisplayRate) ?? { ...DEFAULT_DISPLAY_RATE };
}

export async function saveDisplayRate(actor: Actor, rate: number): Promise<DisplayRate> {
  assertAdmin(actor);
  if (!Number.isFinite(rate) || rate <= 0) throw new ValidationError('Enter a rate above zero');

  const current = await getDisplayRate();
  const value: DisplayRate = {
    ...current,
    rate,
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  const collection = await settings();
  await collection.updateOne(
    { _id: 'display_rate' },
    { $set: { value, updatedAt: new Date(), updatedBy: actor.userId } },
    { upsert: true },
  );

  await writeAudit(actor, {
    action: 'route.update',
    entity: 'settings',
    metadata: { key: 'display_rate', before: current.rate, after: rate },
  });

  return value;
}
