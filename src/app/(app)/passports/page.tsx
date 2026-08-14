import Link from 'next/link';

import { PassportFilters as FilterBar } from '@/components/passport-filters';
import { PassportTable } from '@/components/passport-table';
import { buttonVariants } from '@/components/ui/button';
import { STATUS_LABELS, type PassportStatus } from '@/config/statuses';
import { requireUser } from '@/lib/auth/current-user';
import { countByStatus, countPassports, listPassports } from '@/lib/dal/passports';
import { parsePassportFilters } from '@/lib/list-params';

/**
 * The agency's own list — the same `listPassports` call the admin screen makes, scoped by
 * the actor rather than by a second query kept in step by hand.
 */
export default async function AgencyPassportsPage(props: PageProps<'/passports'>) {
  const actor = await requireUser();
  const searchParams = await props.searchParams;
  const filters = parsePassportFilters(searchParams);

  const [passports, total, byStatus] = await Promise.all([
    listPassports(actor, filters),
    countPassports(actor, filters),
    countByStatus(actor),
  ]);

  const nationalities = [...new Set(passports.map((passport) => passport.nationality))].sort();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Your passports</h1>
          <p className="text-sm text-muted-foreground">
            {total} matching · {Object.entries(byStatus)
              .map(([status, count]) => `${count} ${STATUS_LABELS[status as PassportStatus].toLowerCase()}`)
              .join(' · ') || 'nothing submitted yet'}
          </p>
        </div>
        {actor.viewingAsAgencyId ? null : (
          <Link href="/passports/new" className={buttonVariants()}>
            Add passports
          </Link>
        )}
      </div>

      <FilterBar nationalities={nationalities} />

      <PassportTable passports={passports} />
    </div>
  );
}
