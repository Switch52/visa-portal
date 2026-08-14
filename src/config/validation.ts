/**
 * Validation rules that the profile of the real sheets told us we need, kept as editable
 * configuration rather than inlined in components.
 */

/**
 * Passport numbers are validated loosely and on purpose. The real data holds
 * `A99999999`, `A9999999A`, `AA999999`, `AA9999999` and one all-numeric value — a real
 * passport that does not match a made-up pattern must never be rejected.
 */
export const PASSPORT_NUMBER = {
  minLength: 5,
  maxLength: 20,
  /** Character set only: letters, digits, and the separators we normalize away. */
  allowed: /^[A-Za-z0-9][A-Za-z0-9\s-]*[A-Za-z0-9]$/,
} as const;

/** Applied once at write time; the result is stored beside the original as typed. */
export function normalizePassportNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export const NAME = { minLength: 1, maxLength: 100 } as const;

export const DIAL_CODE = {
  /** Bare digits, no `+` — the main dashboard's template shows `1` and `44`. */
  pattern: /^\d{1,6}$/,
} as const;

export const CONTACT_NUMBER = { maxLength: 32 } as const;

export const DATE_LIMITS = {
  /** A DOB older than this is a data-entry error, not a person. */
  maxAgeYears: 110,
  /** Expiry must be in the future at submission time. */
  expiryMustBeFuture: true,
} as const;

export const APPLICATION_TYPES = ['single'] as const;
export type ApplicationType = (typeof APPLICATION_TYPES)[number];

export const PRIORITIES = ['normal', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const GENDERS = ['Male', 'Female'] as const;
export type Gender = (typeof GENDERS)[number];

export const OTP = {
  length: 6,
  expiryMinutes: 10,
  maxAttempts: 5,
  /** Rate limits are per window, counted separately for the email and the client IP. */
  perEmail: { max: 5, windowMinutes: 15 },
  perIp: { max: 20, windowMinutes: 15 },
  /** How long a session cookie lives before the user has to sign in again. */
  sessionDays: 14,
} as const;
