'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import { markAsAdded, type MarkAddedResult } from '@/lib/dal/handoff';
import { DalError } from '@/lib/dal/errors';

/**
 * The deliberate second step: these rows are now in the main dashboard.
 *
 * Offered right after an export, but never done by the export itself — exporting a batch
 * is not the same as having entered it, and an interrupted handoff must not look finished.
 */
export async function markAddedAction(ids: string[]): Promise<MarkAddedResult | { error: string }> {
  const actor = await requireUser();

  try {
    const result = await markAsAdded(
      actor,
      ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)),
    );
    revalidatePath('/admin/handoff');
    revalidatePath('/admin/passports');
    return result;
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    throw error;
  }
}
