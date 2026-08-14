'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import { createAgency, setAgencyActive } from '@/lib/dal/agencies';
import { DalError } from '@/lib/dal/errors';
import { inviteUser, setUserActive } from '@/lib/dal/users';
import { createRoute } from '@/lib/dal/routes';

export interface FormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

/**
 * Every admin action re-reads the actor server-side and hands it to the DAL, which does
 * the permission check itself. Nothing trusts the form, the URL, or the fact that the
 * button was only rendered for admins.
 */
async function run(work: (actor: Awaited<ReturnType<typeof requireUser>>) => Promise<void>): Promise<FormState> {
  const actor = await requireUser();
  try {
    await work(actor);
    return { ok: true };
  } catch (error) {
    if (error instanceof DalError) {
      const fieldErrors = 'fieldErrors' in error ? (error.fieldErrors as Record<string, string[]>) : undefined;
      return { error: error.message, fieldErrors };
    }
    throw error;
  }
}

export async function createAgencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await run(async (actor) => {
    await createAgency(actor, {
      name: String(formData.get('name') ?? ''),
      contactName: String(formData.get('contactName') ?? ''),
      contactEmail: String(formData.get('contactEmail') ?? ''),
      contactPhone: String(formData.get('contactPhone') ?? ''),
      defaultCurrency: String(formData.get('defaultCurrency') ?? 'USD'),
      internalNotes: String(formData.get('internalNotes') ?? ''),
    });
  });
  revalidatePath('/admin/agencies');
  return state;
}

export async function setAgencyActiveAction(formData: FormData): Promise<void> {
  await run(async (actor) => {
    await setAgencyActive(
      actor,
      new ObjectId(String(formData.get('agencyId'))),
      formData.get('active') === 'true',
    );
  });
  revalidatePath('/admin/agencies');
}

export async function inviteUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const role = String(formData.get('role') ?? 'agency') as 'admin' | 'agency';
  const agencyId = String(formData.get('agencyId') ?? '');

  const state = await run(async (actor) => {
    await inviteUser(actor, {
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      role,
      agencyId: role === 'agency' ? agencyId : null,
    });
  });
  revalidatePath('/admin/users');
  return state;
}

export async function setUserActiveAction(formData: FormData): Promise<void> {
  await run(async (actor) => {
    await setUserActive(
      actor,
      new ObjectId(String(formData.get('userId'))),
      formData.get('active') === 'true',
    );
  });
  revalidatePath('/admin/users');
}

/**
 * Editing a route's fee affects future charges only: a charge stores the amount it was
 * created with, so nothing already on a ledger moves. The screen says so, and the audit
 * entry records it too.
 */
export async function updateRouteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await run(async (actor) => {
    const { updateRoute } = await import('@/lib/dal/routes');
    const { parseMoneyInput } = await import('@/lib/money');

    const currency = String(formData.get('feeCurrency') ?? 'USD');
    const fee = parseMoneyInput(String(formData.get('fee') ?? '0'), currency);

    await updateRoute(actor, new ObjectId(String(formData.get('routeId'))), {
      appointmentCenter: String(formData.get('appointmentCenter') ?? ''),
      feeMinor: fee.amountMinor,
      feeCurrency: fee.currency,
      active: formData.get('active') === 'on',
    });
  });
  revalidatePath('/admin/routes');
  return state;
}

export async function saveExportTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await run(async (actor) => {
    const { saveExportTemplate } = await import('@/lib/dal/settings');

    const headers = formData.getAll('header').map(String);
    const sources = formData.getAll('source').map(String);
    const transforms = formData.getAll('transform').map(String);

    await saveExportTemplate(actor, {
      columns: headers.map((header, index) => ({
        header,
        source: sources[index],
        transform: transforms[index],
      })),
      includeBom: formData.get('includeBom') === 'on',
      excelTextFormulas: formData.get('excelTextFormulas') === 'on',
    });
  });
  revalidatePath('/admin/settings/export');
  return state;
}

export async function resetExportTemplateAction(): Promise<void> {
  await run(async (actor) => {
    const { resetExportTemplate } = await import('@/lib/dal/settings');
    await resetExportTemplate(actor);
  });
  revalidatePath('/admin/settings/export');
}

export async function createRouteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await run(async (actor) => {
    const { parseMoneyInput } = await import('@/lib/money');
    const currency = String(formData.get('feeCurrency') ?? 'USD');
    const fee = parseMoneyInput(String(formData.get('fee') ?? '0'), currency);

    await createRoute(actor, {
      originCountry: String(formData.get('originCountry') ?? ''),
      destinationCountry: String(formData.get('destinationCountry') ?? ''),
      appointmentCenter: String(formData.get('appointmentCenter') ?? ''),
      feeMinor: fee.amountMinor,
      feeCurrency: fee.currency,
      active: true,
    });
  });
  revalidatePath('/admin/routes');
  return state;
}
