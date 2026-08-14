'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import {
  changePassportStatuses,
  checkDuplicates,
  createPassports,
  describeDuplicate,
  updatePassport,
  type BatchResult,
  type PassportEdit,
} from '@/lib/dal/passports';
import { DalError } from '@/lib/dal/errors';
import type { PassportStatus } from '@/config/statuses';
import type { PassportInput } from '@/lib/schema/zod';

/**
 * Save a batch from the grid.
 *
 * The rows arrive as the payload the DAL validates, and the DAL re-validates every one of
 * them: the grid's inline checks are there to save people a round trip, never to be
 * trusted. Nothing saves silently, and the caller gets a per-row account of what happened.
 */
export async function savePassportBatchAction(payload: {
  rows: PassportInput[];
  agencyId?: string | null;
}): Promise<BatchResult | { error: string }> {
  const actor = await requireUser();

  try {
    const result = await createPassports(actor, payload.rows, {
      agencyId: payload.agencyId ? new ObjectId(payload.agencyId) : undefined,
    });
    revalidatePath('/passports');
    revalidatePath('/admin/passports');
    return result;
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    throw error;
  }
}

export interface DuplicateHit {
  normalized: string;
  message: string;
}

/**
 * Live duplicate check as rows are typed or pasted, so a blocked row is visible before
 * anyone reaches the save button. The message is built server-side, which is what keeps
 * the disclosure policy in one place.
 */
export async function checkDuplicatesAction(numbers: string[]): Promise<DuplicateHit[]> {
  const actor = await requireUser();
  const found = await checkDuplicates(actor, numbers);

  return Object.entries(found).map(([normalized, detail]) => ({
    normalized,
    message: describeDuplicate(detail),
  }));
}

export async function updatePassportAction(
  id: string,
  edit: PassportEdit,
): Promise<{ ok: true } | { error: string; fieldErrors?: Record<string, string[]> }> {
  const actor = await requireUser();

  try {
    await updatePassport(actor, new ObjectId(id), edit);
    revalidatePath(`/passports/${id}`);
    revalidatePath('/passports');
    revalidatePath('/admin/passports');
    return { ok: true };
  } catch (error) {
    if (error instanceof DalError) {
      const fieldErrors = 'fieldErrors' in error ? (error.fieldErrors as Record<string, string[]>) : undefined;
      return { error: error.message, fieldErrors };
    }
    throw error;
  }
}

/** Bulk status change from a list view. Each row is decided on its own. */
export async function changeStatusAction(
  ids: string[],
  to: PassportStatus,
): Promise<{ changed: number; failures: { id: string; reason: string }[] } | { error: string }> {
  const actor = await requireUser();

  try {
    const result = await changePassportStatuses(
      actor,
      ids.map((id) => new ObjectId(id)),
      to,
    );
    revalidatePath('/passports');
    revalidatePath('/admin/passports');
    return result;
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    throw error;
  }
}
