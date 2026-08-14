import { ObjectId } from 'mongodb';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PassportGrid } from '@/components/passport-grid';
import { requireUser } from '@/lib/auth/current-user';
import { getOwnAgency } from '@/lib/dal/agencies';
import { listRouteOptions } from '@/lib/dal/routes';
import { ReadOnlySessionError } from '@/lib/dal/errors';

/**
 * One route's entry page.
 *
 * The route is fixed by the URL rather than chosen in the grid, so a batch cannot be filed
 * against the wrong centre by a mis-click, and the two centres are two bookmarkable places
 * to work. A route that is not active has no page — passports cannot be filed into
 * something that is not running.
 *
 * The route list here is the label-only view: an agency never sees what a route costs.
 */
export default async function RouteEntryPage(props: PageProps<'/passports/new/[routeId]'>) {
  const actor = await requireUser();
  const { routeId } = await props.params;

  if (actor.viewingAsAgencyId) {
    return (
      <div className="rounded-md border bg-background p-6">
        <h1 className="text-lg font-semibold">Read-only</h1>
        <p className="mt-2 text-sm text-muted-foreground">{new ReadOnlySessionError().message}</p>
      </div>
    );
  }

  if (!ObjectId.isValid(routeId)) notFound();

  const [routes, agency] = await Promise.all([listRouteOptions(actor), getOwnAgency(actor)]);
  const route = routes.find((option) => option.id === routeId);
  if (!route) notFound();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{route.displayLabel}</h1>
          <p className="text-sm text-muted-foreground">
            A passport number can exist once in the system. Anything already registered is blocked
            here before you save, with the reason.
          </p>
        </div>
        <div className="flex gap-4 text-sm">
          <Link href="/passports/new" className="underline">
            Another route
          </Link>
          <Link href="/passports" className="underline">
            Your passports
          </Link>
        </div>
      </div>

      <PassportGrid routes={routes} fixedRouteId={route.id} agencyName={agency?.name} />
    </div>
  );
}
