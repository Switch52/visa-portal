import { getDisplayRate } from '@/lib/dal/settings';
import type { CurrencyBalance } from '@/lib/dal/ledger';
import { convertForDisplay, formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Balances, one per currency, side by side.
 *
 * There is deliberately no combined figure: if an agency owes 400 USD and 250 EUR that is
 * two balances, not one invented total, and the system never applies a rate it was not
 * given. The single exception is the EGP figure beside a USD amount — display only,
 * labelled as such, computed for reading and never stored or settled against.
 */
export async function BalanceSummary({
  balances,
  showBreakdown = true,
  className,
}: {
  balances: CurrencyBalance[];
  showBreakdown?: boolean;
  className?: string;
}) {
  const rate = await getDisplayRate();

  if (balances.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>Nothing charged yet.</p>;
  }

  return (
    <div className={cn('flex flex-wrap gap-6', className)}>
      {balances.map((balance) => {
        const outstanding = { amountMinor: balance.outstandingMinor, currency: balance.currency };
        const indicative =
          balance.currency === rate.base
            ? convertForDisplay(outstanding, rate.rate, rate.quote)
            : null;

        return (
          <div key={balance.currency} className="min-w-48">
            <p className="text-xs text-muted-foreground">Outstanding, {balance.currency}</p>
            <p
              className={cn(
                'text-2xl font-semibold tabular-nums',
                balance.outstandingMinor > 0 ? 'text-foreground' : 'text-emerald-700 dark:text-emerald-400',
              )}
            >
              {formatMoney(outstanding)}
            </p>

            {indicative ? (
              <p className="text-xs text-muted-foreground">
                ≈ {formatMoney(indicative)} · indicative only, at {rate.rate} {rate.quote} per{' '}
                {rate.base}, rate last updated {rate.updatedAt}
              </p>
            ) : null}

            {showBreakdown ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {formatMoney({ amountMinor: balance.chargedMinor, currency: balance.currency })} charged ·{' '}
                {formatMoney({ amountMinor: balance.paidMinor, currency: balance.currency })} paid
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
