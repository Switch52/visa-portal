import Link from 'next/link';

import { PassportGrid } from '@/components/passport-grid';
import { requireUser } from '@/lib/auth/current-user';
import { getOwnAgency } from '@/lib/dal/agencies';
import { listRouteOptions } from '@/lib/dal/routes';
import { ReadOnlySessionError } from '@/lib/dal/errors';

/**
 * Grid entry for an agency's own passports.
 *
 * The route list here is the label-only view — an agency never sees what a route costs.
 */
export default async function NewPassportsPage() {
  const actor = await requireUser();

  // A view-as session can look at everything an agency sees and change nothing, so the
  // entry screen says so rather than letting someone type thirty rows that cannot save.
  if (actor.viewingAsAgencyId) {
    return (
      <div className="rounded-md border bg-background p-6">
        <h1 className="text-lg font-semibold">Read-only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {new ReadOnlySessionError().message}
        </p>
      </div>
    );
  }

  const [routes, agency] = await Promise.all([listRouteOptions(actor), getOwnAgency(actor)]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Add passports</h1>
          <p className="text-sm text-muted-foreground">
            A passport number can exist once in the system. Anything already registered is blocked
            here before you save, with the reason.
          </p>
        </div>
        <Link href="/passports" className="text-sm underline">
          Back to your passports
        </Link>
      </div>

      <PassportGrid routes={routes} agencyName={agency?.name} />
    </div>
  );
}
