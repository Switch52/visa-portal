'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CURRENCIES } from '@/config/currencies';
import { countryOptions } from '@/config/countries';

import { createRouteAction, type FormState } from '../actions';

const selectClass =
  'border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs';

export function NewRouteForm() {
  const [state, action, pending] = useActionState(createRouteAction, {} as FormState);
  const countries = countryOptions();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a route</CardTitle>
        <CardDescription>
          An amount never exists without a currency, so pick both. Different routes can be priced
          in different currencies.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="originCountry">Applying from</Label>
            <select id="originCountry" name="originCountry" className={selectClass} required defaultValue="EGY">
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="destinationCountry">Applying to</Label>
            <select id="destinationCountry" name="destinationCountry" className={selectClass} required>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="appointmentCenter">Appointment center</Label>
            <Input id="appointmentCenter" name="appointmentCenter" placeholder="VFS Cairo" required />
            {state.fieldErrors?.appointmentCenter ? (
              <p className="text-xs text-destructive">{state.fieldErrors.appointmentCenter.join(', ')}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="fee">Fee</Label>
            <Input id="fee" name="fee" inputMode="decimal" placeholder="120.00" required />
          </div>

          <div className="space-y-2">
            <Label htmlFor="feeCurrency">Currency</Label>
            <select id="feeCurrency" name="feeCurrency" className={selectClass} defaultValue="USD">
              {CURRENCIES.filter((c) => c.active).map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2 lg:col-span-5 flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Add route'}
            </Button>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-sm text-muted-foreground">Route added.</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
