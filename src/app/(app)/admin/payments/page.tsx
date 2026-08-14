import { PaymentForm } from '@/components/payment-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { listAgencies } from '@/lib/dal/agencies';
import { listPayments, newIdempotencyKey } from '@/lib/dal/ledger';
import { formatDateForDisplay } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

/** The page used every day: log what came in, and see what has been logged. */
export default async function PaymentsPage() {
  const actor = await requireAdmin();
  const [agencies, recent] = await Promise.all([listAgencies(actor), listPayments(actor, { limit: 50 })]);
  const agencyName = new Map(agencies.map((agency) => [agency.id, agency.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="text-sm text-muted-foreground">
          A record of money received, nothing more — no processor, no card details, no bank details.
        </p>
      </div>

      <PaymentForm
        agencies={agencies
          .filter((agency) => agency.active)
          .map((agency) => ({
            id: agency.id,
            name: agency.name,
            defaultCurrency: agency.defaultCurrency,
          }))}
        initialKey={newIdempotencyKey()}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent payments</CardTitle>
          <CardDescription>{recent.length} most recent, newest first</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Received</th>
                <th className="py-2">Agency</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2">Method</th>
                <th className="py-2">Reference</th>
                <th className="py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-muted-foreground">
                    Nothing recorded yet.
                  </td>
                </tr>
              ) : (
                recent.map((payment) => (
                  <tr key={payment.id} className="border-b last:border-0">
                    <td className="py-2">{formatDateForDisplay(payment.receivedAt)}</td>
                    <td className="py-2">{agencyName.get(payment.agencyId) ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums">
                      {payment.voided ? (
                        <span className="text-muted-foreground line-through">
                          {formatMoney({ amountMinor: payment.amountMinor, currency: payment.currency })}
                        </span>
                      ) : (
                        formatMoney({ amountMinor: payment.amountMinor, currency: payment.currency })
                      )}
                    </td>
                    <td className="py-2 text-muted-foreground">{payment.method ?? '—'}</td>
                    <td className="py-2 text-muted-foreground">{payment.reference ?? '—'}</td>
                    <td className="py-2 text-muted-foreground" dir="auto">
                      {payment.voided ? `Reversed: ${payment.voidReason}` : (payment.note ?? '—')}
                    </td>
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
