/**
 * Money is always an integer in minor units plus a currency code. Never a float:
 * `0.1 + 0.2` problems in a payments ledger destroy trust in the whole system.
 * Formatting happens at the edge, for display only.
 */

import { getCurrency } from '@/config/currencies';

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Cannot combine ${left} and ${right}. Amounts in different currencies are never summed.`);
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`Amount must be an integer in minor units, got ${amountMinor}.`);
  }
  const code = currency.toUpperCase();
  if (!getCurrency(code)) throw new Error(`Unsupported currency: ${currency}`);
  return { amountMinor, currency: code };
}

/** Parse a typed decimal ("4,698.00", "$1,010.00", "180") into minor units. */
export function parseMoneyInput(input: string, currency: string): Money {
  const def = getCurrency(currency);
  if (!def) throw new Error(`Unsupported currency: ${currency}`);

  const cleaned = input.replace(/[^\d.-]/g, '');
  if (cleaned === '' || !/^-?\d*(\.\d+)?$/.test(cleaned)) {
    throw new Error(`"${input}" is not an amount.`);
  }
  const [whole, fraction = ''] = cleaned.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  const digits = whole.replace('-', '') || '0';

  if (fraction.length > def.minorUnits) {
    throw new Error(`${def.code} amounts cannot have more than ${def.minorUnits} decimal places.`);
  }
  const padded = fraction.padEnd(def.minorUnits, '0');
  return money(sign * Number(`${digits}${padded}`), def.code);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

/** Sum amounts, grouped per currency. Never produces a cross-currency total. */
export function sumByCurrency(amounts: readonly Money[]): Money[] {
  const totals = new Map<string, number>();
  for (const { amountMinor, currency } of amounts) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  return [...totals.entries()]
    .map(([currency, amountMinor]) => ({ amountMinor, currency }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export function formatMoney({ amountMinor, currency }: Money): string {
  const def = getCurrency(currency);
  const minorUnits = def?.minorUnits ?? 2;
  const value = amountMinor / 10 ** minorUnits;
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  })} ${currency}`;
}

/**
 * Indicative conversion for display only — labelled as such wherever it is shown,
 * never stored, never used to settle a charge, never the basis of a balance.
 */
export function convertForDisplay(amount: Money, rate: number, quoteCurrency: string): Money {
  const def = getCurrency(quoteCurrency);
  if (!def) throw new Error(`Unsupported currency: ${quoteCurrency}`);
  return { amountMinor: Math.round(amount.amountMinor * rate), currency: def.code };
}
