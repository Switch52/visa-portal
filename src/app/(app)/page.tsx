import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { STATUS_LABELS } from '@/config/statuses';
import { requireUser } from '@/lib/auth/current-user';
import { countPassports } from '@/lib/dal/passports';
import { getOwnAgency } from '@/lib/dal/agencies';

/**
 * Home. The admin sees the whole system; an agency sees only their own numbers, counted
 * through the same scoped calls — there is no separate "agency query" to get wrong.
 */
export default async function HomePage() {
  const actor = await requireUser();
  const agency = await getOwnAgency(actor);

  const [submitted, onHold, ready, added, booked] = await Promise.all([
    countPassports(actor, { status: 'submitted' }),
    countPassports(actor, { status: 'on_hold' }),
    countPassports(actor, { status: 'ready' }),
    countPassports(actor, { status: 'added' }),
    countPassports(actor, { status: 'booked' }),
  ]);

  const tiles = [
    { label: STATUS_LABELS.submitted, value: submitted },
    { label: STATUS_LABELS.on_hold, value: onHold },
    { label: STATUS_LABELS.ready, value: ready },
    { label: STATUS_LABELS.added, value: added },
    { label: STATUS_LABELS.booked, value: booked },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {agency ? agency.name : 'Everything, across every agency'}
        </h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {actor.name ?? actor.email}
          {actor.role === 'admin' && !actor.viewingAsAgencyId ? ' · administrator' : ''}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What is here so far</CardTitle>
          <CardDescription>
            Milestone 1: accounts, access control and the data layer. Passport entry, the handoff
            queue, booking imports and ledgers arrive in the milestones after this one.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {actor.role === 'admin' && !actor.viewingAsAgencyId ? (
            <p>
              Start by adding an agency under{' '}
              <Link className="underline" href="/admin/agencies">
                Agencies
              </Link>
              , then invite their staff under{' '}
              <Link className="underline" href="/admin/users">
                Users
              </Link>
              .
            </p>
          ) : (
            <p>Your passport list and balance will appear here as those milestones land.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
