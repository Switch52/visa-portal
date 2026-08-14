/**
 * The export template: which columns leave this portal, under what headings, in what form.
 *
 * This is the bridge to the main booking dashboard, so the shape is dictated by that
 * system's importer rather than by what would be tidy here. It lives as data — seeded from
 * the constant below, then editable in a settings screen — so when that system changes its
 * format it is a settings change, not a code change and a deploy.
 */

import { formatDateOnly } from '@/lib/dates';

export type ExportSource =
  | 'firstName'
  | 'lastName'
  | 'passportNumber'
  | 'passportExpiryDate'
  | 'dateOfBirth'
  | 'nationality'
  | 'gender'
  | 'contactNumber'
  | 'contactNumberDialCode'
  | 'contactEmail'
  | 'empty';

export type ExportTransform = 'none' | 'date' | 'upper' | 'digits';

export interface ExportColumn {
  /**
   * The heading written to the file, byte for byte.
   *
   * Three of them end in a literal " (optional)" — spaces and parentheses included. They
   * look like documentation and they are not: they are the column names that importer
   * matches on. Do not tidy them, camel-case them, or strip them.
   */
  header: string;
  source: ExportSource;
  transform: ExportTransform;
}

export interface ExportTemplate {
  columns: ExportColumn[];
  /** Excel mangles a bare CSV without one: Arabic and accented names arrive as mojibake. */
  includeBom: boolean;
  /**
   * Wrap passport numbers as `="A0441…"` so Excel treats them as text.
   *
   * Off by default, and it should stay off while the file's job is to be read by the main
   * dashboard's importer — that formula syntax is for Excel's benefit and the importer may
   * not accept it. Turn it on only if these files are opened in Excel and edited by hand.
   */
  excelTextFormulas: boolean;
}

/** The format in `samples/main-dashboard-import-template.csv`, reproduced exactly. */
export const DEFAULT_EXPORT_TEMPLATE: ExportTemplate = {
  columns: [
    { header: 'firstName', source: 'firstName', transform: 'none' },
    { header: 'lastName', source: 'lastName', transform: 'none' },
    { header: 'passportNumber', source: 'passportNumber', transform: 'none' },
    { header: 'passportExpiryDate', source: 'passportExpiryDate', transform: 'date' },
    { header: 'dateOfBirth', source: 'dateOfBirth', transform: 'date' },
    { header: 'nationality', source: 'nationality', transform: 'upper' },
    { header: 'gender', source: 'gender', transform: 'none' },
    { header: 'contactNumber (optional)', source: 'contactNumber', transform: 'none' },
    { header: 'contactNumberDialCode (optional)', source: 'contactNumberDialCode', transform: 'digits' },
    { header: 'contactEmail (optional)', source: 'contactEmail', transform: 'none' },
  ],
  includeBom: true,
  excelTextFormulas: false,
};

export const EXPORT_TEMPLATE_KEY = 'export_template';

/** The record shape the export reads from. Nothing of ours leaves in the file. */
export interface ExportableRecord {
  firstName: string;
  lastName: string;
  passportNumber: string;
  passportExpiryDate: Date;
  dateOfBirth: Date;
  nationality: string;
  gender: string;
  contactNumber?: string | null;
  contactNumberDialCode?: string | null;
  contactEmail?: string | null;
}

function valueFor(record: ExportableRecord, column: ExportColumn): string {
  if (column.source === 'empty') return '';

  const raw = record[column.source];
  if (raw === null || raw === undefined) return '';

  switch (column.transform) {
    case 'date':
      // Always YYYY-MM-DD, never locale-formatted. The difference between 03/04 and 04/03
      // is a booking on the wrong day, so nothing locale-dependent goes near this file.
      return raw instanceof Date ? formatDateOnly(raw) : String(raw);
    case 'upper':
      return String(raw).toUpperCase();
    case 'digits':
      // Bare digits, no `+` — the template shows `1` and `44`.
      return String(raw).replace(/\D/g, '');
    default:
      return raw instanceof Date ? formatDateOnly(raw) : String(raw);
  }
}

/**
 * RFC-4180 quoting.
 *
 * Every value is quoted, not just the ones that need it: a comma or a quote inside a name
 * would otherwise shift every column after it by one, and an unquoted long digit string is
 * what Excel turns into scientific notation.
 */
export function quoteCsvValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function renderCsv(records: readonly ExportableRecord[], template: ExportTemplate): string {
  const header = template.columns.map((column) => quoteCsvValue(column.header)).join(',');

  const lines = records.map((record) =>
    template.columns
      .map((column) => {
        const value = valueFor(record, column);
        if (template.excelTextFormulas && column.source === 'passportNumber' && value !== '') {
          return `"=""${value.replace(/"/g, '""')}"""`;
        }
        return quoteCsvValue(value);
      })
      .join(','),
  );

  // CRLF per RFC-4180, and a trailing newline so the last row is terminated.
  const body = [header, ...lines].join('\r\n') + '\r\n';
  return template.includeBom ? `﻿${body}` : body;
}

/**
 * A filename that still means something in six months, sitting in a folder of its
 * siblings: the date, the route, and how many records are in it.
 */
export function exportFilename({
  date,
  routeLabel,
  count,
  prefix = 'handoff',
}: {
  date: Date;
  routeLabel?: string | null;
  count: number;
  prefix?: string;
}): string {
  const slug = (routeLabel ?? 'all-routes')
    .replace(/[→·]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${prefix}_${formatDateOnly(date)}_${slug}_${count}.csv`;
}

/** Validation for a template coming back from the settings screen. */
export function validateTemplate(input: unknown): ExportTemplate {
  if (typeof input !== 'object' || input === null) throw new Error('The export template is not readable.');

  const candidate = input as Partial<ExportTemplate>;
  if (!Array.isArray(candidate.columns) || candidate.columns.length === 0) {
    throw new Error('An export template needs at least one column.');
  }

  const columns = candidate.columns.map((column, index) => {
    if (typeof column?.header !== 'string' || column.header === '') {
      throw new Error(`Column ${index + 1} needs a heading.`);
    }
    return {
      header: column.header,
      source: (column.source ?? 'empty') as ExportSource,
      transform: (column.transform ?? 'none') as ExportTransform,
    };
  });

  return {
    columns,
    includeBom: candidate.includeBom ?? true,
    excelTextFormulas: candidate.excelTextFormulas ?? false,
  };
}
