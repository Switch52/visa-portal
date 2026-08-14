/**
 * Nationality handling: ISO 3166-1 alpha-3 only, validated against a real country list
 * (`i18n-iso-countries`) rather than free text.
 *
 * The migration also needs to turn the English country names typed into the agency
 * sheets into codes. That mapping is explicit and deliberately incomplete: an unmapped
 * value stops the import so it can be looked at, rather than being guessed at.
 */

import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';

countries.registerLocale(en);

const ALPHA3 = countries.getAlpha3Codes();

export const COUNTRY_CODES: readonly string[] = Object.keys(ALPHA3).sort();

export function isCountryCode(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALPHA3, value.toUpperCase());
}

export function countryName(alpha3: string): string | undefined {
  return countries.getName(alpha3.toUpperCase(), 'en');
}

export function countryOptions(): { code: string; name: string }[] {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Names seen in the real sheets that the ISO list does not resolve on its own.
 * Add to this table when a new sheet brings a new spelling; never loosen the lookup.
 */
export const COUNTRY_NAME_ALIASES: Readonly<Record<string, string>> = {
  syria: 'SYR',
  'syrian arab republic': 'SYR',
  russia: 'RUS',
  turkey: 'TUR',
  uae: 'ARE',
  'south korea': 'KOR',
  'north korea': 'PRK',
  'ivory coast': 'CIV',
  palestine: 'PSE',
};

/**
 * Resolve an English country name to alpha-3. Returns null rather than guessing, so the
 * caller can stop and report the value.
 */
export function resolveCountryName(input: string): string | null {
  const value = input.trim();
  if (value === '') return null;

  if (/^[A-Za-z]{3}$/.test(value) && isCountryCode(value)) return value.toUpperCase();

  const alias = COUNTRY_NAME_ALIASES[value.toLowerCase()];
  if (alias) return alias;

  const code = countries.getAlpha3Code(value, 'en');
  return code ?? null;
}
