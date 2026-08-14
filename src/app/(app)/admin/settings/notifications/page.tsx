import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getNotificationSettings } from '@/lib/notifications';

import { NotificationsForm } from './notifications-form';

/**
 * Which emails the portal sends.
 *
 * Everything here is off-switchable, and nothing here can affect the data: a send happens
 * after the work it describes has already committed, and a failure is recorded rather than
 * thrown.
 */
export default async function NotificationSettingsPage() {
  await requireAdmin();
  const settings = await getNotificationSettings();
  const configured = Boolean(process.env.RESEND_API_KEY);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          {configured
            ? 'Emails are being sent through Resend.'
            : 'No email key is set, so nothing is actually sent — messages are logged to the server console instead.'}
        </p>
      </div>

      <NotificationsForm settings={settings} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What an agency&apos;s email contains</CardTitle>
          <CardDescription>
            A count and a link, and nothing else. Passport numbers, names and dates of birth are
            never put in an email — it is the least controlled place this data could end up — and no
            message can hint that another agency exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Sign-in codes are separate from these settings and are always sent: without one, nobody
          could log in.
        </CardContent>
      </Card>
    </div>
  );
}
