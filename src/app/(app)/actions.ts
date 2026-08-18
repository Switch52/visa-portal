'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getActor } from '@/lib/auth/current-user';
import { VIEW_AS_COOKIE, encodeViewAs, viewAsCookieOptions } from '@/lib/auth/view-as';
import { writeAudit } from '@/lib/dal/audit';
import { ForbiddenError } from '@/lib/dal/errors';

/**
 * Entering and leaving a view-as session is written to the audit log, both ways — it is
 * the admin looking at a client's data, and that should always be traceable.
 *
 * The state lives in a cookie of ours rather than in Clerk's session, so signing out or
 * a token refresh cannot strand an admin inside another agency's data.
 */
export async function startViewAsAction(formData: FormData): Promise<void> {
  const actor = await getActor();
  if (!actor || actor.role !== 'admin') throw new ForbiddenError();

  const agencyId = new ObjectId(String(formData.get('agencyId')));

  const store = await cookies();
  store.set(VIEW_AS_COOKIE, encodeViewAs(agencyId), viewAsCookieOptions());

  await writeAudit(actor, {
    action: 'viewas.start',
    entity: 'agency',
    entityId: agencyId,
    agencyId,
  });

  redirect('/');
}

export async function endViewAsAction(): Promise<void> {
  const actor = await getActor();
  if (!actor || actor.role !== 'admin') throw new ForbiddenError();

  const store = await cookies();
  store.delete(VIEW_AS_COOKIE);

  await writeAudit(
    { ...actor, viewingAsAgencyId: null },
    {
      action: 'viewas.end',
      entity: 'agency',
      entityId: actor.viewingAsAgencyId ?? null,
      agencyId: actor.viewingAsAgencyId ?? null,
    },
  );

  revalidatePath('/', 'layout');
  redirect('/');
}
