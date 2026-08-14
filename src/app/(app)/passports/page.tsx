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
import { requireUser } from '@/lib/auth/current-user';
import { listPassports } from '@/lib/dal/passports';
import { formatDateForDisplay } from '@/lib/dates';

/**
 * The agency's own list. The same `listPassports` call the admin screen makes — the scope
 * comes from the actor, so there is no second query to keep in step.
 */
export default async function AgencyPassportsPage() {
  const actor = await requireUser();
  const passports = await listPassports(actor, { limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your passports</h1>
        <p className="text-sm text-muted-foreground">
          Grid entry, with paste straight from a spreadsheet, arrives in milestone 2.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submitted</CardTitle>
          <CardDescription>{passports.length} on record</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Passport</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {passports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    Nothing here yet.
                  </TableCell>
                </TableRow>
              ) : (
                passports.map((passport) => (
                  <TableRow key={passport.id}>
                    <TableCell className="font-medium">
                      {passport.firstName} {passport.lastName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{passport.passportNumber}</TableCell>
                    <TableCell>{STATUS_LABELS[passport.status]}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateForDisplay(passport.submittedAt)}
                    </TableCell>
                    {/* Notes are Arabic or English free text; let the browser lay it out. */}
                    <TableCell dir="auto" className="max-w-xs truncate">
                      {passport.notes ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
