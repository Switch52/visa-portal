'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/current-user';
import { endViewAs, startViewAs } from '@/lib/auth/session';
import { writeAudit } from '@/lib/dal/audit';
import { ForbiddenError } from '@/lib/dal/errors';

/**
 * Entering and leaving a view-as session is written to the audit log, both ways — it is
 * the admin looking at a client's data, and that should always be traceable.
 */
export async function startViewAsAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session || session.actor.role !== 'admin') throw new ForbiddenError();

  const agencyId = new ObjectId(String(formData.get('agencyId')));
  await startViewAs(session.sessionId, agencyId);
  await writeAudit(session.actor, {
    action: 'viewas.start',
    entity: 'agency',
    entityId: agencyId,
    agencyId,
  });

  redirect('/');
}

export async function endViewAsAction(): Promise<void> {
  const session = await getSession();
  if (!session || session.actor.role !== 'admin') throw new ForbiddenError();

  await endViewAs(session.sessionId);
  await writeAudit(
    { ...session.actor, viewingAsAgencyId: null },
    {
      action: 'viewas.end',
      entity: 'agency',
      entityId: session.actor.viewingAsAgencyId ?? null,
      agencyId: session.actor.viewingAsAgencyId ?? null,
    },
  );

  revalidatePath('/', 'layout');
  redirect('/');
}
