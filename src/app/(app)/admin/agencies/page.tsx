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
import { listAgencies } from '@/lib/dal/agencies';

import { startViewAsAction } from '../../actions';
import { setAgencyActiveAction } from '../actions';
import { NewAgencyForm } from './new-agency-form';

export default async function AgenciesPage() {
  const actor = await requireAdmin();
  const agencies = await listAgencies(actor);

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
                <TableHead>Contact</TableHead>
                <TableHead>Default currency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agencies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No agencies yet.
                  </TableCell>
                </TableRow>
              ) : (
                agencies.map((agency) => (
                  <TableRow key={agency.id}>
                    <TableCell className="font-medium">{agency.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {agency.contactName ?? '—'}
                      {agency.contactEmail ? ` · ${agency.contactEmail}` : ''}
                    </TableCell>
                    <TableCell>{agency.defaultCurrency}</TableCell>
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
