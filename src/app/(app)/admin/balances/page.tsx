import Link from 'next/link';

import { BalanceSummary } from '@/components/balance-summary';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getBalanceOverview } from '@/lib/dal/ledger';
import { getDisplayRate } from '@/lib/dal/settings';
import { convertForDisplay, formatMoney } from '@/lib/money';

/**
 * Every agency's balance on one screen, sorted by who owes most.
 *
 * Totals are per currency. There is no grand total across currencies, because there is no
 * honest way to produce one without a rate nobody agreed to.
 */
export default async function BalancesPage() {
  const actor = await requireAdmin();
  const [{ rows, totals }, rate] = await Promise.all([getBalanceOverview(actor), getDisplayRate()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Balances</h1>
        <p className="text-sm text-muted-foreground">
          Worked out from charges minus payments, in each currency separately. Never stored, so it
          cannot drift from the ledger behind it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outstanding in total</CardTitle>
          <CardDescription>Per currency — nothing is summed across them.</CardDescription>
        </CardHeader>
        <CardContent>
          <BalanceSummary balances={totals} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By agency</CardTitle>
          <CardDescription>Most owed first.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Agency</th>
                <th className="py-2">Currency</th>
                <th className="py-2 text-right">Charged</th>
                <th className="py-2 text-right">Paid</th>
                <th className="py-2 text-right">Outstanding</th>
                <th className="py-2 text-right">EGP (indicative)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-muted-foreground">
                    Nothing charged yet. Charges appear when passports are booked.
                  </td>
                </tr>
              ) : (
                rows.flatMap((row) =>
                  row.balances.map((balance, index) => (
                    <tr key={`${row.agencyId}-${balance.currency}`} className="border-b last:border-0">
                      <td className="py-2 font-medium">
                        {index === 0 ? (
                          <Link href={`/admin/agencies/${row.agencyId}`} className="hover:underline">
                            {row.agencyName}
                          </Link>
                        ) : (
                          ''
                        )}
                      </td>
                      <td className="py-2">{balance.currency}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney({ amountMinor: balance.chargedMinor, currency: balance.currency })}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney({ amountMinor: balance.paidMinor, currency: balance.currency })}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {formatMoney({ amountMinor: balance.outstandingMinor, currency: balance.currency })}
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {balance.currency === rate.base
                          ? formatMoney(
                              convertForDisplay(
                                { amountMinor: balance.outstandingMinor, currency: balance.currency },
                                rate.rate,
                                rate.quote,
                              ),
                            )
                          : '—'}
                      </td>
                    </tr>
                  )),
                )
              )}
            </tbody>
          </table>

          <p className="mt-3 text-xs text-muted-foreground">
            EGP figures are indicative, converted at {rate.rate} per {rate.base} — rate last updated{' '}
            {rate.updatedAt}.{' '}
            <Link href="/admin/settings/rate" className="underline">
              Update the rate
            </Link>
            . They are never stored, never settle anything, and are never the basis of a balance.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
