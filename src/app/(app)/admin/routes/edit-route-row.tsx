'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CURRENCIES } from '@/config/currencies';
import type { RouteDetail } from '@/lib/dal/routes';
import { formatMoney } from '@/lib/money';

import { updateRouteAction, type FormState } from '../actions';

/**
 * Editing a route in place.
 *
 * The fee warning is not decoration: a price change must never look like it rewrites what
 * agencies already owe. Charges keep the amount they were created with, and the row says
 * so at the moment of editing.
 */
export function EditRouteRow({ route }: { route: RouteDetail }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateRouteAction, {} as FormState);

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-end justify-end gap-2">
      <input type="hidden" name="routeId" value={route.id} />

      <div className="space-y-1">
        <label htmlFor={`center-${route.id}`} className="text-xs text-muted-foreground">
          Center
        </label>
        <Input
          id={`center-${route.id}`}
          name="appointmentCenter"
          defaultValue={route.appointmentCenter}
          className="w-40"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={`fee-${route.id}`} className="text-xs text-muted-foreground">
          Fee
        </label>
        <Input
          id={`fee-${route.id}`}
          name="fee"
          defaultValue={(route.feeMinor / 100).toFixed(2)}
          className="w-24"
          inputMode="decimal"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={`currency-${route.id}`} className="text-xs text-muted-foreground">
          Currency
        </label>
        <select
          id={`currency-${route.id}`}
          name="feeCurrency"
          defaultValue={route.feeCurrency}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          {CURRENCIES.filter((currency) => currency.active).map((currency) => (
            <option key={currency.code} value={currency.code}>
              {currency.code}
            </option>
          ))}
        </select>
      </div>

      <label className="flex h-9 items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={route.active} />
        Active
      </label>

      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>

      <p className="w-full text-right text-xs text-muted-foreground">
        Currently {formatMoney({ amountMinor: route.feeMinor, currency: route.feeCurrency })}. Changing
        it applies to passports booked from now on — charges already raised keep the amount they were
        created with, so no existing balance moves.
      </p>
      {state.error ? <p className="w-full text-right text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}
