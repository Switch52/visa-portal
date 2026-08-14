import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATUS_LABELS } from '@/config/statuses';
import { requireAdmin } from '@/lib/auth/current-user';
import { listAgencies } from '@/lib/dal/agencies';
import { listPassports } from '@/lib/dal/passports';
import { formatDateForDisplay } from '@/lib/dates';

/**
 * The admin's cross-agency list. Filters, search and bulk actions arrive with milestone 2;
 * this is the read that proves the scoped layer returns everything for an admin and only
 * their own rows for an agency.
 */
export default async function AdminPassportsPage() {
  const actor = await requireAdmin();
  const [passports, agencies] = await Promise.all([
    listPassports(actor, { limit: 100 }),
    listAgencies(actor),
  ]);
  const agencyName = new Map(agencies.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Passports</h1>
        <p className="text-sm text-muted-foreground">Every passport, across every agency.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Most recent</CardTitle>
          <CardDescription>
            {passports.length === 0
              ? 'Nothing submitted yet — grid entry lands in milestone 2.'
              : `${passports.length} shown`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Passport</TableHead>
                <TableHead>Nationality</TableHead>
                <TableHead>Agency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {passports.map((passport) => (
                <TableRow key={passport.id}>
                  <TableCell className="font-medium">
                    {passport.firstName} {passport.lastName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{passport.passportNumber}</TableCell>
                  <TableCell>{passport.nationality}</TableCell>
                  <TableCell>
                    {passport.agencyId ? (agencyName.get(passport.agencyId) ?? '—') : '—'}
                  </TableCell>
                  <TableCell>{STATUS_LABELS[passport.status]}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateForDisplay(passport.submittedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
