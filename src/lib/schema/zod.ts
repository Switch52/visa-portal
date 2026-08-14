/**
 * Validation level one: Zod at every API boundary.
 *
 * Level two is the `$jsonSchema` validators in `jsonSchema.ts`, which the database
 * enforces itself — the only thing standing between a malformed record and the data when
 * the write comes from a migration script, a bulk import, or the Atlas console.
 */

import { z } from 'zod';

import { isCountryCode } from '@/config/countries';
import { CURRENCY_CODES } from '@/config/currencies';
import { PASSPORT_STATUSES } from '@/config/statuses';
import {
  APPLICATION_TYPES,
  CONTACT_NUMBER,
  DATE_LIMITS,
  DIAL_CODE,
  GENDERS,
  NAME,
  PASSPORT_NUMBER,
  PRIORITIES,
  normalizeEmail,
} from '@/config/validation';
import { parseDateOnly, todayDateOnly, yearsBetween } from '@/lib/dates';

export const objectIdString = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Not a valid id');

export const emailSchema = z
  .email('Enter a valid email address')
  .max(254)
  .transform(normalizeEmail);

export const currencySchema = z
  .string()
  .toUpperCase()
  .refine((code) => CURRENCY_CODES.includes(code), 'Unsupported currency');

export const amountMinorSchema = z
  .int('Amounts are whole numbers of minor units')
  .nonnegative('Amount cannot be negative');

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((value, ctx) => {
    try {
      return parseDateOnly(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: `${value} is not a real date` });
      return z.NEVER;
    }
  });

export const nationalitySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, 'Use a valid ISO 3166-1 alpha-3 country code');

export const nameSchema = z.string().trim().min(NAME.minLength, 'Required').max(NAME.maxLength);

export const passportNumberSchema = z
  .string()
  .trim()
  .min(PASSPORT_NUMBER.minLength, 'Passport number looks too short')
  .max(PASSPORT_NUMBER.maxLength, 'Passport number looks too long')
  .regex(PASSPORT_NUMBER.allowed, 'Passport number has characters we do not recognise');

export const genderSchema = z.enum(GENDERS);
export const applicationTypeSchema = z.enum(APPLICATION_TYPES);
export const prioritySchema = z.enum(PRIORITIES);
export const statusSchema = z.enum(PASSPORT_STATUSES);
export const roleSchema = z.enum(['admin', 'agency']);

// ---------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------

export const agencyInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  contactName: z.string().trim().max(120).optional().nullable(),
  contactEmail: z.union([emailSchema, z.literal('')]).optional().nullable(),
  contactPhone: z.string().trim().max(40).optional().nullable(),
  defaultCurrency: currencySchema,
  internalNotes: z.string().trim().max(5000).optional().nullable(),
});

/**
 * The DAL takes what a caller can actually type: `z.input` is the shape before parsing —
 * dates as `YYYY-MM-DD` strings, defaults not yet applied. `z.output` is what the DAL has
 * after validation, and is what it writes.
 */
export type AgencyInput = z.input<typeof agencyInputSchema>;

// ---------------------------------------------------------------------------
// Users and invitations
// ---------------------------------------------------------------------------

export const inviteUserSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    role: roleSchema,
    agencyId: objectIdString.optional().nullable(),
  })
  .refine((value) => (value.role === 'agency' ? Boolean(value.agencyId) : true), {
    message: 'An agency user must be assigned to an agency',
    path: ['agencyId'],
  })
  .refine((value) => (value.role === 'admin' ? !value.agencyId : true), {
    message: 'An admin is not attached to an agency',
    path: ['agencyId'],
  });

export type InviteUserInput = z.input<typeof inviteUserSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const requestOtpSchema = z.object({ email: emailSchema });

export const verifyOtpSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routeInputSchema = z.object({
  originCountry: nationalitySchema,
  destinationCountry: nationalitySchema,
  appointmentCenter: z.string().trim().min(1, 'Required').max(120),
  feeMinor: amountMinorSchema,
  feeCurrency: currencySchema,
  active: z.boolean().default(true),
});

export type RouteInput = z.input<typeof routeInputSchema>;

// ---------------------------------------------------------------------------
// Passports
// ---------------------------------------------------------------------------

export const passportInputSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    passportNumber: passportNumberSchema,
    passportExpiryDate: dateOnlySchema,
    dateOfBirth: dateOnlySchema,
    nationality: nationalitySchema,
    gender: genderSchema,
    contactNumber: z.string().trim().max(CONTACT_NUMBER.maxLength).optional().nullable(),
    contactNumberDialCode: z
      .string()
      .trim()
      .regex(DIAL_CODE.pattern, 'Digits only, no +')
      .optional()
      .nullable(),
    contactEmail: z.union([emailSchema, z.literal('')]).optional().nullable(),
    routeId: objectIdString,
    applicationType: applicationTypeSchema.default('single'),
    priority: prioritySchema.default('normal'),
    holdUntil: dateOnlySchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const today = todayDateOnly();
    if (DATE_LIMITS.expiryMustBeFuture && value.passportExpiryDate <= today) {
      ctx.addIssue({
        code: 'custom',
        path: ['passportExpiryDate'],
        message: 'This passport has expired',
      });
    }
    if (value.dateOfBirth > today) {
      ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Date of birth is in the future' });
    }
    if (yearsBetween(value.dateOfBirth, today) > DATE_LIMITS.maxAgeYears) {
      ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Date of birth is not plausible' });
    }
  });

export type PassportInput = z.input<typeof passportInputSchema>;
export type PassportRecord = z.output<typeof passportInputSchema>;
