/**
 * Dates are real `Date` objects in UTC, never strings and never locale-formatted.
 *
 * Passport expiry and date of birth are *date-only*. They are stored as midnight UTC and
 * only ever read back in UTC, so no timezone shift can move someone's birthday by a day.
 * Anything that formats a date for a human does it here, explicitly.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DD_MM_YYYY = /^(\d{1,2})[/\\.-](\d{1,2})[/\\.-](\d{4})$/;

export class DateParseError extends Error {
  constructor(value: string, expected: string) {
    super(`"${value}" is not a valid ${expected} date.`);
    this.name = 'DateParseError';
  }
}

/** Build a date-only value from Y/M/D, validating the calendar (rejects 31 Feb). */
export function dateOnly(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new DateParseError(`${year}-${month}-${day}`, 'calendar');
  }
  return date;
}

/** Parse `YYYY-MM-DD` — the form the CSV template uses, and the only form the API accepts. */
export function parseDateOnly(value: string): Date {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) throw new DateParseError(value, 'YYYY-MM-DD');
  return dateOnly(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Parse `DD/MM/YYYY` strictly — day first, always. The agency sheets are day-first
 * (proven by 129 expiry and 107 birth dates with a day above 12), and the difference
 * between `03/04` and `04/03` is a booking on the wrong day. Never use a permissive
 * parser here, and never call this on a value that might be ISO.
 */
export function parseDayFirstDate(value: string): Date {
  const match = DD_MM_YYYY.exec(value.trim());
  if (!match) throw new DateParseError(value, 'DD/MM/YYYY');
  const [, day, month, year] = match;
  return dateOnly(Number(year), Number(month), Number(day));
}

/**
 * Parse a date as a person types it into the grid, and return it in ISO form.
 *
 * Two shapes are accepted: `YYYY-MM-DD`, and day-first `DD/MM/YYYY` with any of `/ \ - .`
 * as the separator, because both `27/8` and `15\9` appear in the real sheets. Day-first is
 * applied strictly and never inferred from the values — `05/06/2028` is 5 June, always.
 * Anything else returns null so the cell can show an error instead of a guess.
 */
export function parseTypedDate(input: string): Date | null {
  const value = input.trim();
  if (value === '') return null;

  if (DATE_ONLY.test(value)) {
    try {
      return parseDateOnly(value);
    } catch {
      return null;
    }
  }
  try {
    return parseDayFirstDate(value);
  } catch {
    return null;
  }
}

/** Format for the export file and the API. Never locale-formatted. */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Human-readable, unambiguous, locale-independent: "12 Mar 2026". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDateForDisplay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatDateTimeForDisplay(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${formatDateForDisplay(date)}, ${hh}:${mm} UTC`;
}

/** Today as a date-only value, for expiry and hold comparisons. */
export function todayDateOnly(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function isDateOnly(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export function yearsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}
