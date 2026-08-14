'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CURRENCIES } from '@/config/currencies';
import { formatDateOnly } from '@/lib/dates';

import { recordPaymentAction, type PaymentFormState } from '@/app/(app)/admin/payments/actions';

const selectClass = 'border-input bg-background h-9 w-full rounded-md border px-2 text-sm shadow-xs';

interface AgencyOption {
  id: string;
  name: string;
  defaultCurrency: string;
}

/**
 * The daily payments form.
 *
 * This is opened every single day, so it behaves like a till: the cursor starts in the
 * first field, the date defaults to today, the currency follows the agency's default, and
 * after a save it clears and puts the cursor back where it started rather than making
 * anyone reach for the mouse.
 */
export function PaymentForm({ agencies, initialKey }: { agencies: AgencyOption[]; initialKey: string }) {
  const [state, action, pending] = useActionState(recordPaymentAction, {} as PaymentFormState);
  const [agencyId, setAgencyId] = useState(agencies[0]?.id ?? '');
  const [currency, setCurrency] = useState(agencies[0]?.defaultCurrency ?? 'USD');

  const formRef = useRef<HTMLFormElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);

  // Open with the cursor already in the first field.
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  // The key for the next submission is derived, not stored: a successful save hands back
  // a fresh one, so the same key can never be submitted twice.
  const idempotencyKey = state.ok ? (state.nextKey ?? initialKey) : initialKey;

  // After a save: clear the form and start again at the top, without reaching for a mouse.
  useEffect(() => {
    if (!state.ok) return;
    formRef.current?.reset();
    firstField.current?.focus();
  }, [state]);

  const onAgencyChange = (id: string) => {
    setAgencyId(id);
    const agency = agencies.find((entry) => entry.id === id);
    // Pre-filled from the agency, still overridable on any individual payment.
    if (agency) setCurrency(agency.defaultCurrency);
  };

  if (agencies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No agencies yet</CardTitle>
          <CardDescription>Add an agency before recording payments against one.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record a payment</CardTitle>
        <CardDescription>
          Money that arrived outside the portal. Nothing here moves money — it only records what
          came in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {/* Carries the submission's identity: the same key twice is one payment. */}
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <div className="space-y-2 lg:col-span-2">
            <Label htmlFor="agencyId">Agency</Label>
            <select
              id="agencyId"
              name="agencyId"
              ref={firstField}
              className={selectClass}
              value={agencyId}
              onChange={(event) => onAgencyChange(event.target.value)}
            >
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" name="amount" inputMode="decimal" placeholder="1,000.00" required />
            {state.fieldErrors?.amount ? (
              <p className="text-xs text-destructive">{state.fieldErrors.amount.join(', ')}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <select
              id="currency"
              name="currency"
              className={selectClass}
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.filter((entry) => entry.active).map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="receivedAt">Received</Label>
            <Input id="receivedAt" name="receivedAt" type="date" defaultValue={formatDateOnly(new Date())} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="method">Method</Label>
            <Input id="method" name="method" placeholder="Cash, transfer…" />
          </div>

          <div className="space-y-2 lg:col-span-3">
            <Label htmlFor="reference">Reference</Label>
            <Input id="reference" name="reference" placeholder="Transfer or receipt number" />
          </div>

          <div className="space-y-2 lg:col-span-3">
            <Label htmlFor="note">Note</Label>
            <Input id="note" name="note" dir="auto" />
          </div>

          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-6">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Record payment'}
            </Button>
            {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
