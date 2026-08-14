'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CURRENCIES } from '@/config/currencies';
import type { RouteDetail } from '@/lib/dal/routes';
import { formatMoney } from '@/lib/money';

import { repriceRoutesAction, type FormState } from '../actions';

/**
 * Changing a price across chosen routes.
 *
 * Prices are per route, so a rise can cover one centre, several, or all of them — pick the
 * ones it applies to. Nothing already charged moves: every charge keeps the amount it was
 * created with, and the panel says so at the moment of doing it rather than in a help page
 * nobody opens.
 */
export function RepriceForm({ routes }: { routes: RouteDetail[] }) {
  const [state, action, pending] = useActionState(repriceRoutesAction, {} as FormState);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (routes.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change a price</CardTitle>
        <CardDescription>
          Pick which routes the new price applies to. It takes effect for passports booked from now
          on — anything already booked keeps the fee it was booked at, so no existing balance moves.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {routes.map((route) => (
              <label
                key={route.id}
                className="flex items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  name="routeId"
                  value={route.id}
                  checked={selected.has(route.id)}
                  onChange={() => toggle(route.id)}
                  className="mt-1"
                />
                <span>
                  {route.displayLabel}
                  <span className="block text-xs text-muted-foreground">
                    now {formatMoney({ amountMinor: route.feeMinor, currency: route.feeCurrency })}
                    {route.active ? '' : ' · not active'}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="reprice-fee">New price</Label>
              <Input id="reprice-fee" name="fee" inputMode="decimal" placeholder="70.00" className="w-32" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reprice-currency">Currency</Label>
              <select
                id="reprice-currency"
                name="feeCurrency"
                defaultValue="USD"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              >
                {CURRENCIES.filter((currency) => currency.active).map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code}
                  </option>
                ))}
              </select>
            </div>

            <Button type="submit" disabled={pending || selected.size === 0}>
              {pending ? 'Applying…' : `Apply to ${selected.size} route${selected.size === 1 ? '' : 's'}`}
            </Button>

            {state.ok ? <p className="text-sm text-muted-foreground">Price updated.</p> : null}
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
