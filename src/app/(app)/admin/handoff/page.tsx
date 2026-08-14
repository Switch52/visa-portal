import Link from 'next/link';

import { HandoffQueue } from '@/components/handoff-queue';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getHandoffQueue, getHandoffSummary } from '@/lib/dal/handoff';

/**
 * The handoff queue — the screen used every week for years, not a temporary bridge.
 * The main dashboard stays; this feeds it.
 */
export default async function HandoffPage() {
  const actor = await requireAdmin();
  const [groups, summary] = await Promise.all([getHandoffQueue(actor), getHandoffSummary(actor)]);

  const tiles = [
    { label: 'Ready to hand off', value: summary.readyCount },
    { label: 'Added, not yet booked', value: summary.addedAwaitingBooking },
    { label: 'On hold', value: summary.onHold },
    { label: 'Holds due today', value: summary.holdsDueToday },
    { label: 'Oldest wait', value: `${summary.oldestWaitingDays}d` },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Handoff queue</h1>
        <p className="text-sm text-muted-foreground">
          Everything ready to go into the main booking dashboard, a route at a time. Export a batch,
          enter it over there, then mark it added — exporting on its own changes nothing.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <CardHeader className="pb-2">
              <CardDescription>{tile.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{tile.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      {summary.addedAwaitingBooking > 0 ? (
        <p className="rounded-md border bg-background px-4 py-3 text-sm">
          {summary.addedAwaitingBooking} passport{summary.addedAwaitingBooking === 1 ? ' is' : 's are'} in the
          main dashboard but not yet confirmed booked.{' '}
          <Link href="/admin/passports?status=added" className="underline">
            See them
          </Link>
          . They become booked when a booking file is imported — nothing else sets that.
        </p>
      ) : null}

      <HandoffQueue groups={groups} />
    </div>
  );
}
