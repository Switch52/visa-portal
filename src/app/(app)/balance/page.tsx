import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/current-user';
import { getOwnAgency } from '@/lib/dal/agencies';

/**
 * Placeholder until milestone 5. Balances are derived from charges minus payments, per
 * currency, and are never stored — so there is nothing to show until charges exist.
 */
export default async function BalancePage() {
  const actor = await requireUser();
  const agency = await getOwnAgency(actor);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Balance</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{agency?.name ?? 'Your account'}</CardTitle>
          <CardDescription>
            Your balance, what it is made of, and your payment history arrive in milestone 5.
            Balances are worked out from charges and payments in each currency separately.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Default currency: {agency?.defaultCurrency ?? '—'}
        </CardContent>
      </Card>
    </div>
  );
}
