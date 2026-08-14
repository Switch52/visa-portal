import { ExportCurrentView } from '@/components/export-current-view';
import { PassportFilters as FilterBar } from '@/components/passport-filters';
import { PassportTable } from '@/components/passport-table';
import { STATUS_LABELS, type PassportStatus } from '@/config/statuses';
import { requireAdmin } from '@/lib/auth/current-user';
import { listAgencies } from '@/lib/dal/agencies';
import { countByStatus, countPassports, listPassports } from '@/lib/dal/passports';
import { parsePassportFilters } from '@/lib/list-params';

/**
 * Every passport across every agency, with the filters that make a specific one findable
 * in one go — and bulk status changes for working through a batch.
 */
export default async function AdminPassportsPage(props: PageProps<'/admin/passports'>) {
  const actor = await requireAdmin();
  const searchParams = await props.searchParams;
  const filters = parsePassportFilters(searchParams);

  const [passports, agencies, total, byStatus] = await Promise.all([
    listPassports(actor, filters),
    listAgencies(actor),
    countPassports(actor, filters),
    countByStatus(actor),
  ]);

  const agencyNames = Object.fromEntries(agencies.map((agency) => [agency.id, agency.name]));
  const nationalities = [...new Set(passports.map((passport) => passport.nationality))].sort();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Passports</h1>
          <p className="text-sm text-muted-foreground">
            {total} matching · {Object.entries(byStatus)
              .map(([status, count]) => `${count} ${STATUS_LABELS[status as PassportStatus].toLowerCase()}`)
              .join(' · ') || 'nothing submitted yet'}
          </p>
        </div>
        {/* Honours the filters currently applied: what you see is what lands in the file. */}
        <ExportCurrentView disabled={passports.length === 0} />
      </div>

      <FilterBar
        agencies={agencies.map((agency) => ({ id: agency.id, name: agency.name }))}
        nationalities={nationalities}
        showAgency
      />

      <PassportTable passports={passports} agencyNames={agencyNames} showAgency allowBulk />
    </div>
  );
}
