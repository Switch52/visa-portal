'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { NotificationSettings } from '@/lib/notifications';

import { saveNotificationsAction, type FormState } from '../../actions';

export function NotificationsForm({ settings }: { settings: NotificationSettings }) {
  const [state, action, pending] = useActionState(saveNotificationsAction, {} as FormState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Emails the portal sends</CardTitle>
        <CardDescription>Each one can be turned off without affecting anything else.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="userInvited" defaultChecked={settings['user.invited']} className="mt-1" />
            <span>
              Welcome an invited user
              <span className="block text-xs text-muted-foreground">
                Sent when you add someone, so their first contact is not an unexplained code. Tells
                them there is no password and where to sign in.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="passportsBooked"
              defaultChecked={settings['passports.booked']}
              className="mt-1"
            />
            <span>
              Tell an agency their passports are booked
              <span className="block text-xs text-muted-foreground">
                One email per agency after a booking import, carrying how many of theirs were booked
                and a link. Never names, never numbers.
              </span>
            </span>
          </label>

          <div className="space-y-2">
            <Label htmlFor="appUrl">Portal address</Label>
            <Input id="appUrl" name="appUrl" defaultValue={settings.appUrl} className="max-w-md" />
            <p className="text-xs text-muted-foreground">Used for the links in those emails.</p>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            {state.ok ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
