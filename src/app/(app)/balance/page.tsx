import { ObjectId } from 'mongodb';

import { BalanceSummary } from '@/components/balance-summary';
import { LedgerTable } from '@/components/ledger-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/current-user';
import { getOwnAgency } from '@/lib/dal/agencies';
import { getAgencyBalance, getLedger, listPayments } from '@/lib/dal/ledger';
import { formatDateForDisplay } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

/**
 * The agency's own balance — read-only, and only ever their own.
 *
 * Agencies never record their own payments, so there is nothing to submit here: what they
 * get is what they owe, what it is made of, and their payment history.
 */
export default async function BalancePage() {
  const actor = await requireUser();
  const agency = await getOwnAgency(actor);

  if (!agency) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No balance to show</CardTitle>
          <CardDescription>
            This account is not attached to an agency. Admins can see every agency&apos;s balance
            under Balances.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const agencyId = new ObjectId(agency.id);
  const [balances, ledger, payments] = await Promise.all([
    getAgencyBalance(actor, agencyId),
    getLedger(actor, agencyId),
    listPayments(actor, { agencyId }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your balance</h1>
        <p className="text-sm text-muted-foreground">
          One line per booked passport, and every payment we have recorded from you.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outstanding</CardTitle>
          <CardDescription>Shown per currency. Nothing is converted or combined.</CardDescription>
        </CardHeader>
        <CardContent>
          <BalanceSummary balances={balances} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What it is made of</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* No passport links: this list is theirs, and its charges are their own. */}
          <LedgerTable lines={ledger} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your payments</CardTitle>
          <CardDescription>
            As recorded by us. If something is missing here, tell us — payments are entered on our
            side.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Received</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2">Method</th>
                <th className="py-2">Reference</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-muted-foreground">
                    No payments recorded yet.
                  </td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} className="border-b last:border-0">
                    <td className="py-2">{formatDateForDisplay(payment.receivedAt)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney({ amountMinor: payment.amountMinor, currency: payment.currency })}
                      {payment.voided ? ' (reversed)' : ''}
                    </td>
                    <td className="py-2 text-muted-foreground">{payment.method ?? '—'}</td>
                    <td className="py-2 text-muted-foreground">{payment.reference ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
