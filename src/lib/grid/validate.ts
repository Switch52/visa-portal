/**
 * Row validation, shared by the grid in the browser and the save path on the server.
 *
 * One implementation, used in both places: the inline errors an agency sees while typing
 * are the same rules that decide whether the row saves, so a row can never look fine in
 * the grid and then be refused on submit for a reason nobody mentioned.
 *
 * The one check that cannot happen here is the duplicate rule — that needs the database,
 * and is enforced by a unique index at insert time.
 */

import { formatDateOnly, parseTypedDate } from '@/lib/dates';
import { passportInputSchema, type PassportInput } from '@/lib/schema/zod';

import { GRID_COLUMNS, type GridField } from './columns';
import type { GridRow } from './paste';

export type RowErrors = Partial<Record<GridField, string>>;

export interface RowValidation {
  ok: boolean;
  errors: RowErrors;
  /** Present when the row is valid: the payload the API takes. */
  input?: PassportInput;
}

export function isRowEmpty(row: GridRow): boolean {
  return Object.values(row).every((value) => value.trim() === '');
}

/** Build the API payload from typed cells, converting the date columns to ISO. */
export function toPassportInput(row: GridRow, routeId: string): PassportInput | null {
  const expiry = parseTypedDate(row.passportExpiryDate);
  const dob = parseTypedDate(row.dateOfBirth);
  if (!expiry || !dob) return null;

  return {
    firstName: row.firstName.trim(),
    lastName: row.lastName.trim(),
    passportNumber: row.passportNumber.trim(),
    passportExpiryDate: formatDateOnly(expiry),
    dateOfBirth: formatDateOnly(dob),
    nationality: row.nationality.trim().toUpperCase(),
    gender: row.gender.trim() as 'Male' | 'Female',
    contactNumber: row.contactNumber.trim() || null,
    contactNumberDialCode: row.contactNumberDialCode.trim() || null,
    contactEmail: row.contactEmail.trim() || null,
    notes: row.notes.trim() || null,
    routeId,
  };
}

export function validateRow(row: GridRow, routeId: string | null): RowValidation {
  const errors: RowErrors = {};

  for (const column of GRID_COLUMNS) {
    if (column.required && row[column.field].trim() === '') {
      errors[column.field] = 'Required';
    }
  }

  // Dates are checked first: without them there is no payload to validate at all.
  if (row.passportExpiryDate.trim() !== '' && !parseTypedDate(row.passportExpiryDate)) {
    errors.passportExpiryDate = 'Use DD/MM/YYYY';
  }
  if (row.dateOfBirth.trim() !== '' && !parseTypedDate(row.dateOfBirth)) {
    errors.dateOfBirth = 'Use DD/MM/YYYY';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (!routeId) {
    return { ok: false, errors: { firstName: 'Choose a route for this batch' } };
  }

  const input = toPassportInput(row, routeId);
  if (!input) return { ok: false, errors: { passportExpiryDate: 'Use DD/MM/YYYY' } };

  const parsed = passportInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as GridField | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }

  return { ok: true, errors: {}, input };
}
