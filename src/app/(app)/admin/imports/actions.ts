'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import { commitImport, previewImport, undoImport, type CommitResult, type ImportPreview } from '@/lib/dal/bookings';
import { DalError } from '@/lib/dal/errors';
import { UnreadableFileError } from '@/lib/import/parse';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'ready'; preview: ImportPreview; fileName: string; fileBase64: string }
  | { status: 'unreadable'; message: string; detail: string[] }
  | { status: 'error'; message: string };

/**
 * Step one: read the file and show what committing it would do. Writes nothing.
 *
 * The file itself is handed back to the browser as base64 so the confirm step re-reads the
 * exact same bytes — the hash has to match for the "already imported" check to mean
 * anything, and re-uploading is how a stale preview is caught.
 */
export async function previewImportAction(_prev: PreviewState, formData: FormData): Promise<PreviewState> {
  const actor = await requireUser();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a booking file first.' };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { status: 'error', message: 'That file is larger than 10 MB — is it the right one?' };
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const preview = await previewImport(actor, { buffer, filename: file.name });
    return {
      status: 'ready',
      preview,
      fileName: file.name,
      fileBase64: buffer.toString('base64'),
    };
  } catch (error) {
    if (error instanceof UnreadableFileError) {
      // Say plainly that the file is not what we expect, rather than importing garbage.
      return { status: 'unreadable', message: error.message, detail: error.detail };
    }
    if (error instanceof DalError) return { status: 'error', message: error.message };
    throw error;
  }
}

/** Step two: commit, only on an explicit confirmation. */
export async function commitImportAction(payload: {
  fileName: string;
  fileBase64: string;
  only?: string[];
}): Promise<CommitResult | { error: string }> {
  const actor = await requireUser();

  try {
    const result = await commitImport(
      actor,
      { buffer: Buffer.from(payload.fileBase64, 'base64'), filename: payload.fileName },
      { only: payload.only },
    );
    revalidatePath('/admin/imports');
    revalidatePath('/admin/passports');
    revalidatePath('/admin/handoff');
    return result;
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    if (error instanceof UnreadableFileError) return { error: error.message };
    throw error;
  }
}

export async function undoImportAction(batchId: string): Promise<{ ok: true; reverted: number } | { error: string }> {
  const actor = await requireUser();

  try {
    const result = await undoImport(actor, new ObjectId(batchId));
    revalidatePath('/admin/imports');
    revalidatePath('/admin/passports');
    return { ok: true, reverted: result.passportsReverted };
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    throw error;
  }
}
