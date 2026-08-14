import Link from 'next/link';

import type { LedgerLine } from '@/lib/dal/ledger';
import { formatDateForDisplay } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<LedgerLine['kind'], string> = {
  charge: 'Booking fee',
  opening_balance: 'Opening balance',
  credit: 'Credit',
  payment: 'Payment',
};

/**
 * The line-by-line history behind a balance.
 *
 * Every number ties back to something: a charge to its passport and the fee it was created
 * with, a payment to its reference, an opening balance to the sheet it came from. No
 * unexplained figures.
 */
export function LedgerTable({ lines, showPassportLinks }: { lines: LedgerLine[]; showPassportLinks?: boolean }) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing on this ledger yet.</p>;
  }

  // A running balance, oldest first, so the newest line shows where things stand now.
  const oldestFirst = [...lines].sort((a, b) => a.at.getTime() - b.at.getTime());
  const running = new Map<string, number>();
  const withRunning = oldestFirst.map((line) => {
    if (line.voided) return { line, balanceMinor: running.get(line.currency) ?? 0 };
    const next = (running.get(line.currency) ?? 0) + line.deltaMinor;
    running.set(line.currency, next);
    return { line, balanceMinor: next };
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2">Date</th>
            <th className="py-2">Entry</th>
            <th className="py-2">Detail</th>
            <th className="py-2 text-right">Amount</th>
            <th className="py-2 text-right">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {withRunning.reverse().map(({ line, balanceMinor }) => (
            <tr key={line.id} className={cn('border-b last:border-0', line.voided && 'text-muted-foreground')}>
              <td className="py-2">{formatDateForDisplay(line.at)}</td>
              <td className="py-2">
                {KIND_LABEL[line.kind]}
                {line.voided ? ' (reversed)' : ''}
              </td>
              <td className="py-2 text-muted-foreground" dir="auto">
                {line.voided ? line.voidReason : line.description}
                {line.reference ? ` · ${line.reference}` : ''}
                {line.method ? ` · ${line.method}` : ''}
                {showPassportLinks && line.passportId ? (
                  <>
                    {' · '}
                    <Link href={`/passports/${line.passportId}`} className="underline">
                      passport
                    </Link>
                  </>
                ) : null}
              </td>
              <td
                className={cn(
                  'py-2 text-right tabular-nums',
                  line.voided && 'line-through',
                  !line.voided && line.deltaMinor < 0 && 'text-emerald-700 dark:text-emerald-400',
                )}
              >
                {formatMoney({ amountMinor: line.deltaMinor, currency: line.currency })}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {formatMoney({ amountMinor: balanceMinor, currency: line.currency })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
