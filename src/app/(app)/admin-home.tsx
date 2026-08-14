import Link from 'next/link';

import { BalanceSummary } from '@/components/balance-summary';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Actor } from '@/lib/dal/actor';
import { getAdminDashboard } from '@/lib/dal/dashboard';
import { formatDateTimeForDisplay } from '@/lib/dates';
import { cn } from '@/lib/utils';

/**
 * The admin's morning screen: what is waiting, what is stuck, what came in, and what is
 * owed — each tile linking to the place the work is done.
 */
export async function AdminHome({ actor }: { actor: Actor }) {
  const dashboard = await getAdminDashboard(actor);

  const tiles = [
    {
      label: 'Ready to hand off',
      value: dashboard.readyToHandOff,
      href: '/admin/handoff',
      hint: 'Export them, then mark them added',
    },
    {
      label: 'Added, not yet booked',
      value: dashboard.addedAwaitingBooking,
      href: '/admin/passports?status=added',
      hint: 'In the main dashboard, awaiting a booking file',
      tone: dashboard.addedAwaitingBooking > 0 ? 'text-violet-700 dark:text-violet-400' : undefined,
    },
    {
      label: 'Submitted today',
      value: dashboard.submittedToday,
      href: '/admin/passports',
      hint: `${dashboard.submittedThisWeek} this week`,
    },
    {
      label: 'On hold',
      value: dashboard.onHold,
      href: '/admin/passports?status=on_hold',
      hint:
        dashboard.holdsDueToday > 0
          ? `${dashboard.holdsDueToday} whose date has passed`
          : 'None due yet',
      tone: dashboard.holdsDueToday > 0 ? 'text-amber-700 dark:text-amber-400' : undefined,
    },
    {
      label: 'Duplicates blocked',
      value: dashboard.blockedDuplicates,
      href: '/admin/audit?action=passport.duplicate_blocked',
      hint:
        dashboard.crossAgencyDuplicates > 0
          ? `${dashboard.crossAgencyDuplicates} across different agencies`
          : 'Last 7 days',
      tone: dashboard.crossAgencyDuplicates > 0 ? 'text-destructive' : undefined,
    },
    {
      label: 'Booked this week',
      value: dashboard.bookedThisWeek,
      href: '/admin/passports?status=booked',
      hint: 'From imported booking files',
      tone: 'text-emerald-700 dark:text-emerald-400',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Everything, across every agency</h1>
        <p className="text-sm text-muted-foreground">Signed in as {actor.name ?? actor.email} · administrator</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="block">
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardHeader className="pb-2">
                <CardDescription>{tile.label}</CardDescription>
                <CardTitle className={cn('text-3xl tabular-nums', tile.tone)}>{tile.value}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">{tile.hint}</CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outstanding</CardTitle>
            <CardDescription>
              Per currency, worked out from charges minus payments.{' '}
              <Link href="/admin/balances" className="underline">
                By agency
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BalanceSummary balances={dashboard.balances} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>
              From the audit log.{' '}
              <Link href="/admin/audit" className="underline">
                See all of it
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {dashboard.activity.slice(0, 12).map((entry) => (
                  <li key={entry.id} className="flex justify-between gap-4">
                    <span>{entry.summary}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTimeForDisplay(entry.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
