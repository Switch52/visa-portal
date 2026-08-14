'use server';

import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import { DalError } from '@/lib/dal/errors';
import { recordCredit, recordPayment, voidPayment } from '@/lib/dal/ledger';
import { parseMoneyInput } from '@/lib/money';

export interface PaymentFormState {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  /** Handed back so the next submission carries a fresh key. */
  nextKey?: string;
}

/**
 * Record a payment that arrived outside the portal.
 *
 * The form carries an idempotency key, so the same submission arriving twice — a
 * double-click, an impatient retry — records the money once and says so.
 */
export async function recordPaymentAction(
  _prev: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const actor = await requireUser();

  const currency = String(formData.get('currency') ?? 'USD');
  const rawAmount = String(formData.get('amount') ?? '');

  try {
    const amount = parseMoneyInput(rawAmount, currency);

    const result = await recordPayment(actor, {
      agencyId: String(formData.get('agencyId') ?? ''),
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      receivedAt: String(formData.get('receivedAt') ?? '') || undefined,
      method: String(formData.get('method') ?? '') || null,
      reference: String(formData.get('reference') ?? '') || null,
      note: String(formData.get('note') ?? '') || null,
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
    });

    revalidatePath('/admin/payments');
    revalidatePath('/admin/balances');

    return {
      ok: true,
      message: result.duplicate
        ? 'That payment was already recorded — nothing was added a second time.'
        : 'Payment recorded.',
      nextKey: crypto.randomUUID(),
    };
  } catch (error) {
    if (error instanceof DalError) {
      const fieldErrors = 'fieldErrors' in error ? (error.fieldErrors as Record<string, string[]>) : undefined;
      return { error: error.message, fieldErrors };
    }
    if (error instanceof Error) return { error: error.message };
    throw error;
  }
}

export async function voidPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireUser();
  await voidPayment(actor, new ObjectId(String(formData.get('paymentId'))), String(formData.get('reason') ?? ''));
  revalidatePath('/admin/payments');
  revalidatePath('/admin/balances');
}

export async function recordCreditAction(
  _prev: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const actor = await requireUser();
  const currency = String(formData.get('currency') ?? 'USD');

  try {
    const amount = parseMoneyInput(String(formData.get('amount') ?? ''), currency);
    await recordCredit(actor, {
      agencyId: String(formData.get('agencyId') ?? ''),
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      description: String(formData.get('description') ?? ''),
      at: String(formData.get('at') ?? '') || undefined,
    });

    revalidatePath('/admin/balances');
    return { ok: true, message: 'Credit recorded.' };
  } catch (error) {
    if (error instanceof DalError) return { error: error.message };
    if (error instanceof Error) return { error: error.message };
    throw error;
  }
}
