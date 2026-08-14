'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { DisplayRate } from '@/lib/dal/settings';

import { saveDisplayRateAction, type FormState } from '../../actions';

export function RateForm({ rate }: { rate: DisplayRate }) {
  const [state, action, pending] = useActionState(saveDisplayRateAction, {} as FormState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {rate.quote} per 1 {rate.base}
        </CardTitle>
        <CardDescription>
          Currently {rate.rate}, last updated {rate.updatedAt}. The date shown beside every converted
          figure is this one, so it is always obvious how stale a number is.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="rate">Rate</Label>
            <Input
              id="rate"
              name="rate"
              inputMode="decimal"
              defaultValue={String(rate.rate)}
              className="w-32"
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Update rate'}
          </Button>
          {state.ok ? <p className="text-sm text-muted-foreground">Updated.</p> : null}
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}
