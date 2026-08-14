import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getDisplayRate, getExportTemplate } from '@/lib/dal/settings';
import { getNotificationSettings } from '@/lib/notifications';

/** The things that change without a deploy. */
export default async function SettingsPage() {
  await requireAdmin();
  const [template, rate, notifications] = await Promise.all([
    getExportTemplate(),
    getDisplayRate(),
    getNotificationSettings(),
  ]);
  const emailsOn = [notifications['user.invited'], notifications['passports.booked']].filter(Boolean).length;

  const settings = [
    {
      href: '/admin/settings/export',
      title: 'Export format',
      description: `The columns the handoff CSV is written with — ${template.columns.length} at the moment. Change these when the main dashboard changes what it accepts.`,
    },
    {
      href: '/admin/settings/rate',
      title: 'Display exchange rate',
      description: `${rate.rate} ${rate.quote} per ${rate.base}, last updated ${rate.updatedAt}. Used only to show an indicative figure beside a real amount.`,
    },
    {
      href: '/admin/settings/notifications',
      title: 'Notifications',
      description: `${emailsOn} of 2 emails switched on. Sending happens after the work it describes has committed, so it can never undo anything.`,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Admin-only, and changeable without a deploy.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {settings.map((setting) => (
          <Card key={setting.href}>
            <CardHeader>
              <CardTitle className="text-base">
                <Link href={setting.href} className="hover:underline">
                  {setting.title}
                </Link>
              </CardTitle>
              <CardDescription>{setting.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={setting.href} className="text-sm underline">
                Open
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
