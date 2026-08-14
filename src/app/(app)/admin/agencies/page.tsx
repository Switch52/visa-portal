import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdmin } from '@/lib/auth/current-user';
import { getAgencyRows } from '@/lib/dal/dashboard';
import { formatMoney } from '@/lib/money';

import { startViewAsAction } from '../../actions';
import { setAgencyActiveAction } from '../actions';
import { NewAgencyForm } from './new-agency-form';

/** One row per agency: what they have sent, what is booked, and what they owe. */
export default async function AgenciesPage() {
  const actor = await requireAdmin();
  const agencies = await getAgencyRows(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agencies</h1>
        <p className="text-sm text-muted-foreground">
          Each agency sees only their own passports and balance, and never learns that any other
          agency exists.
        </p>
      </div>

      <NewAgencyForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All agencies</CardTitle>
          <CardDescription>{agencies.length} on record</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Passports</TableHead>
                <TableHead className="text-right">Booked</TableHead>
                <TableHead className="text-right">On hold</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agencies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    No agencies yet.
                  </TableCell>
                </TableRow>
              ) : (
                agencies.map((agency) => (
                  <TableRow key={agency.id}>
                    <TableCell className="font-medium">
                      <Link href={`/admin/agencies/${agency.id}`} className="hover:underline">
                        {agency.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{agency.submitted}</TableCell>
                    <TableCell className="text-right tabular-nums">{agency.booked}</TableCell>
                    <TableCell className="text-right tabular-nums">{agency.onHold}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {agency.balances.length === 0
                        ? '—'
                        : agency.balances
                            .map((balance) =>
                              formatMoney({
                                amountMinor: balance.outstandingMinor,
                                currency: balance.currency,
                              }),
                            )
                            .join(' · ')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={agency.active ? 'default' : 'secondary'}>
                        {agency.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="flex justify-end gap-2">
                      {/* Read-only look at exactly what this agency sees. */}
                      <form action={startViewAsAction}>
                        <input type="hidden" name="agencyId" value={agency.id} />
                        <Button type="submit" size="sm" variant="outline">
                          View as
                        </Button>
                      </form>
                      <form action={setAgencyActiveAction}>
                        <input type="hidden" name="agencyId" value={agency.id} />
                        <input type="hidden" name="active" value={String(!agency.active)} />
                        <Button type="submit" size="sm" variant="ghost">
                          {agency.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </form>
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
