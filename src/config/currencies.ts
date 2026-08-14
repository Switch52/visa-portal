/**
 * The currencies the portal will accept, and how many minor units each one has.
 *
 * Every amount in the system is an integer in minor units plus one of these codes.
 * There is no such thing as a bare number, and nothing sums across currencies.
 */

export interface CurrencyDefinition {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  /** 2 => cents/piastres. Kept explicit so a 0- or 3-decimal currency can be added later. */
  readonly minorUnits: number;
  readonly active: boolean;
}

export const CURRENCIES: readonly CurrencyDefinition[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2, active: true },
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', minorUnits: 2, active: true },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2, active: true },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', minorUnits: 2, active: true },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', minorUnits: 2, active: true },
  { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', minorUnits: 2, active: true },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

export function getCurrency(code: string): CurrencyDefinition | undefined {
  return CURRENCIES.find((c) => c.code === code.toUpperCase());
}

export function isSupportedCurrency(code: string): boolean {
  return getCurrency(code) !== undefined;
}

/**
 * The one display-only conversion in the system: the hand-maintained EGP rate.
 * The live value lives in the `settings` collection; this is only the seed for it.
 * EGP figures computed from it are indicative, never stored on a charge or payment,
 * and never used to settle anything.
 */
export const DEFAULT_DISPLAY_RATE = {
  base: 'USD',
  quote: 'EGP',
  rate: 51.08,
  updatedAt: '2026-07-27',
} as const;
