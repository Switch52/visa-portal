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

/**
 * How an application is submitted.
 *
 * `single` is one person on their own. A family goes in as one application covering
 * several people, and each member is still a passport in their own right — they are linked
 * by a shared group reference so they stay together through the queue, the handoff export
 * and the booking file, rather than being scattered by whatever the sort order happens to
 * be that day.
 *
 * Adding another size later is one entry here plus a migration for the validator.
 */
export const APPLICATION_TYPES = ['single', 'family_2', 'family_4'] as const;
export type ApplicationType = (typeof APPLICATION_TYPES)[number];

export const APPLICATION_TYPE_LABELS: Record<ApplicationType, string> = {
  single: 'Single',
  family_2: 'Family of 2',
  family_4: 'Family of 4',
};

/** How many people one application of this type covers. */
export const APPLICATION_TYPE_SIZE: Record<ApplicationType, number> = {
  single: 1,
  family_2: 2,
  family_4: 4,
};

export function isFamilyType(type: ApplicationType): boolean {
  return APPLICATION_TYPE_SIZE[type] > 1;
}

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
