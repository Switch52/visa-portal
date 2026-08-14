'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CURRENCIES } from '@/config/currencies';

import { createAgencyAction, type FormState } from '../actions';

export function NewAgencyForm() {
  const [state, action, pending] = useActionState(createAgencyAction, {} as FormState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add an agency</CardTitle>
        <CardDescription>
          The default currency pre-fills the payments form. Fees live on routes, not here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Name" name="name" required error={state.fieldErrors?.name} />
          <Field label="Contact name" name="contactName" />
          <Field label="Contact email" name="contactEmail" type="email" error={state.fieldErrors?.contactEmail} />
          <Field label="Contact phone" name="contactPhone" />

          <div className="space-y-2">
            <Label htmlFor="defaultCurrency">Default currency</Label>
            <select
              id="defaultCurrency"
              name="defaultCurrency"
              defaultValue="USD"
              className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs"
            >
              {CURRENCIES.filter((c) => c.active).map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </div>

          <Field label="Internal notes" name="internalNotes" placeholder="Only you can see these" />

          <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Add agency'}
            </Button>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-sm text-muted-foreground">Agency added.</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  placeholder,
  error,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  error?: string[];
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} required={required} placeholder={placeholder} />
      {error ? <p className="text-xs text-destructive">{error.join(', ')}</p> : null}
    </div>
  );
}
