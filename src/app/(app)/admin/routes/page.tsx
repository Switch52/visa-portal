import { Badge } from '@/components/ui/badge';
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
import { listRoutes } from '@/lib/dal/routes';
import { formatMoney } from '@/lib/money';

import { EditRouteRow } from './edit-route-row';
import { NewRouteForm } from './new-route-form';

/**
 * Routes carry the pricing, so this whole screen is admin-only — and so is the DAL behind
 * it, which refuses an agency actor regardless of how the request was made.
 */
export default async function RoutesPage() {
  const actor = await requireAdmin();
  const routes = await listRoutes(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Routes</h1>
        <p className="text-sm text-muted-foreground">
          A route is an origin, a destination and an appointment center together — the same pair at
          two centers is two routes, and each carries its own fee. Agencies see the label, never
          the price.
        </p>
      </div>

      <NewRouteForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All routes</CardTitle>
          <CardDescription>
            Editing a fee affects future charges only. Charges keep the amount they were created
            with, so nothing already on a ledger moves.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Route</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Center</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    No routes yet. Add the one you are running today.
                  </TableCell>
                </TableRow>
              ) : (
                routes.map((route) => (
                  <TableRow key={route.id}>
                    <TableCell className="font-medium">{route.displayLabel}</TableCell>
                    <TableCell>{route.originCountry}</TableCell>
                    <TableCell>{route.destinationCountry}</TableCell>
                    <TableCell>{route.appointmentCenter}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatMoney({ amountMinor: route.feeMinor, currency: route.feeCurrency })}
                    </TableCell>
                    <TableCell>
                      <Badge variant={route.active ? 'default' : 'secondary'}>
                        {route.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <EditRouteRow route={route} />
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
