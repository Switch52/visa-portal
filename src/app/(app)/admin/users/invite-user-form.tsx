'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { inviteUserAction, type FormState } from '../actions';

const selectClass =
  'border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs';

export function InviteUserForm({ agencies }: { agencies: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(inviteUserAction, {} as FormState);
  const [role, setRole] = useState<'admin' | 'agency'>('agency');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite someone</CardTitle>
        <CardDescription>
          Adding a person by name and email is what makes that email exist in the system. They sign
          in with an emailed code; there is no password to set.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
            {state.fieldErrors?.email ? (
              <p className="text-xs text-destructive">{state.fieldErrors.email.join(', ')}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <select
              id="role"
              name="role"
              className={selectClass}
              value={role}
              onChange={(event) => setRole(event.target.value as 'admin' | 'agency')}
            >
              <option value="agency">Agency</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agencyId">Agency</Label>
            <select
              id="agencyId"
              name="agencyId"
              className={selectClass}
              disabled={role === 'admin'}
              required={role === 'agency'}
            >
              <option value="">{role === 'admin' ? 'Not applicable' : 'Choose an agency'}</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
            {state.fieldErrors?.agencyId ? (
              <p className="text-xs text-destructive">{state.fieldErrors.agencyId.join(', ')}</p>
            ) : null}
          </div>

          <div className="sm:col-span-2 lg:col-span-4 flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Inviting…' : 'Send invite'}
            </Button>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-sm text-muted-foreground">Invited.</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
