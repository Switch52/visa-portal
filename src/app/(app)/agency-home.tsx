import Link from 'next/link';

import { BalanceSummary } from '@/components/balance-summary';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PASSPORT_STATUSES, STATUS_LABELS } from '@/config/statuses';
import type { Actor } from '@/lib/dal/actor';
import { getOwnAgency } from '@/lib/dal/agencies';
import { getAgencyDashboard } from '@/lib/dal/dashboard';

/**
 * The agency's own screen: where their passports stand, what they owe, and anything
 * waiting on them. Nothing here can reference another agency, because every number comes
 * from a scoped call that cannot see one.
 */
export async function AgencyHome({ actor }: { actor: Actor }) {
  const [agency, dashboard] = await Promise.all([getOwnAgency(actor), getAgencyDashboard(actor)]);

  const shown = PASSPORT_STATUSES.filter(
    (status) => (dashboard.byStatus[status] ?? 0) > 0 || ['submitted', 'ready', 'added', 'booked'].includes(status),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{agency?.name ?? 'Your passports'}</h1>
          <p className="text-sm text-muted-foreground">
            {dashboard.submittedThisWeek} submitted this week · {dashboard.booked} booked in total
          </p>
        </div>
        {actor.viewingAsAgencyId ? null : (
          <Link href="/passports/new" className={buttonVariants()}>
            Add passports
          </Link>
        )}
      </div>

      {dashboard.attention.length > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">Waiting on something</CardTitle>
            <CardDescription>The things worth looking at first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {dashboard.attention.map((item) => (
                <li key={item.label}>
                  <Link href={item.href} className="underline">
                    {item.count} {item.label.toLowerCase()}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((status) => (
          <Link key={status} href={`/passports?status=${status}`} className="block">
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardHeader className="pb-2">
                <CardDescription>{STATUS_LABELS[status]}</CardDescription>
                <CardTitle className="text-3xl tabular-nums">{dashboard.byStatus[status] ?? 0}</CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What you owe</CardTitle>
          <CardDescription>
            One charge per booked passport, per currency.{' '}
            <Link href="/balance" className="underline">
              See the detail
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BalanceSummary balances={dashboard.balances} />
        </CardContent>
      </Card>
    </div>
  );
}
