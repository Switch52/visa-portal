/**
 * Turning URL search params into DAL filters.
 *
 * Shared by the admin and agency list screens so both read a filtered URL the same way —
 * and so the export in milestone 3 can honour exactly what is on screen by parsing the
 * same params.
 */

import { ObjectId } from 'mongodb';

import { PASSPORT_STATUSES, type PassportStatus } from '@/config/statuses';
import { isCountryCode } from '@/config/countries';
import { parseDateOnly } from '@/lib/dates';
import type { PassportFilters } from '@/lib/dal/passports';

export type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

/** Anything unrecognised is dropped rather than passed through to a query. */
export function parsePassportFilters(params: SearchParams): PassportFilters {
  const filters: PassportFilters = {};

  const status = single(params, 'status');
  if (status && (PASSPORT_STATUSES as readonly string[]).includes(status)) {
    filters.status = status as PassportStatus;
  }

  const agency = single(params, 'agency');
  if (agency && ObjectId.isValid(agency)) filters.agencyId = new ObjectId(agency);

  const route = single(params, 'route');
  if (route && ObjectId.isValid(route)) filters.routeId = new ObjectId(route);

  const nationality = single(params, 'nationality');
  if (nationality && isCountryCode(nationality)) filters.nationality = nationality.toUpperCase();

  const from = single(params, 'from');
  if (from) {
    try {
      filters.submittedFrom = parseDateOnly(from);
    } catch {
      // An unparseable date filters nothing rather than erroring the page.
    }
  }

  const to = single(params, 'to');
  if (to) {
    try {
      // Inclusive of the whole day the person picked.
      const day = parseDateOnly(to);
      filters.submittedTo = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
    } catch {
      // ignored, as above
    }
  }

  const search = single(params, 'q');
  if (search) filters.search = search;

  const page = Number(single(params, 'page') ?? '1');
  const limit = 100;
  if (Number.isFinite(page) && page > 1) filters.skip = (Math.floor(page) - 1) * limit;
  filters.limit = limit;

  return filters;
}
