/**
 * Turning a clipboard payload from Excel or Google Sheets into grid rows.
 *
 * This is the feature that decides whether anyone actually leaves their spreadsheet, so it
 * has to cope with what those applications really put on the clipboard: tab-separated
 * cells, quoted values when a cell contains a tab or a newline, CRLF endings, a trailing
 * newline, and — often — the header row along with the data.
 *
 * Pure functions, no DOM: the parser is unit-tested on its own.
 */

import { resolveCountryName } from '@/config/countries';
import { APPLICATION_TYPES, type ApplicationType } from '@/config/validation';
import { GRID_COLUMNS, GRID_FIELDS, IGNORED_PASTE_COLUMNS, type GridField } from './columns';

export type GridRow = Record<GridField, string>;

export function emptyRow(): GridRow {
  return Object.fromEntries(GRID_FIELDS.map((field) => [field, ''])) as GridRow;
}

/**
 * Split a clipboard string into a grid of cells.
 *
 * Spreadsheets quote a cell whenever it contains a tab, a newline or a quote, and escape
 * an inner quote by doubling it — the same convention as CSV, with tabs for commas.
 */
export function splitClipboardGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += char;
      i += 1;
      continue;
    }

    if (char === '"' && cell === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === '\t') {
      endCell();
      i += 1;
      continue;
    }
    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }

    cell += char;
    i += 1;
  }

  if (cell !== '' || row.length > 0) endRow();

  // A trailing newline should not produce an empty final row.
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

export interface HeaderMapping {
  /** Grid field for each pasted column, or null for a column we ignore. */
  fields: (GridField | null)[];
  recognised: string[];
  ignored: string[];
  unknown: string[];
}

/**
 * Decide whether the first pasted row is a header, and what its columns mean.
 *
 * People paste with and without headers, so this is detected rather than configured: a row
 * counts as a header when most of its cells match known column names and none of them look
 * like data.
 */
export function detectHeader(row: string[]): HeaderMapping | null {
  const fields: (GridField | null)[] = [];
  const recognised: string[] = [];
  const ignored: string[] = [];
  const unknown: string[] = [];

  for (const raw of row) {
    const value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (value === '') {
      fields.push(null);
      continue;
    }

    const column = GRID_COLUMNS.find((c) => c.aliases.includes(value) || c.field.toLowerCase() === value);
    if (column) {
      fields.push(column.field);
      recognised.push(raw.trim());
      continue;
    }
    if (IGNORED_PASTE_COLUMNS.includes(value)) {
      fields.push(null);
      ignored.push(raw.trim());
      continue;
    }
    fields.push(null);
    unknown.push(raw.trim());
  }

  // Two recognised names is enough to call it a header; one could be a person named "Last".
  if (recognised.length < 2) return null;
  return { fields, recognised, ignored, unknown };
}

export interface PasteResult {
  rows: GridRow[];
  /** Set when the first line was consumed as a header. */
  mapping: HeaderMapping | null;
  /** Columns present in the paste that this portal does not store, e.g. addresses. */
  ignoredColumns: string[];
  unknownColumns: string[];
  truncatedColumns: number;
}

export interface PasteOptions {
  /** Where in the grid the paste started; columns fill from there when there is no header. */
  startField?: GridField;
  /** Values are normalized on the way in, the same way the importer normalizes them. */
  normalize?: boolean;
}

/**
 * Parse a clipboard payload into grid rows.
 *
 * With a header row, columns are matched by name in any order, and the address columns the
 * sheets carry are read past rather than stored. Without one, cells fill left to right
 * from wherever the paste started, which is what a partial-column paste needs.
 */
export function parsePaste(text: string, options: PasteOptions = {}): PasteResult {
  const grid = splitClipboardGrid(text);
  if (grid.length === 0) {
    return { rows: [], mapping: null, ignoredColumns: [], unknownColumns: [], truncatedColumns: 0 };
  }

  const mapping = detectHeader(grid[0]!);
  const body = mapping ? grid.slice(1) : grid;

  const startIndex = options.startField ? GRID_FIELDS.indexOf(options.startField) : 0;
  let truncatedColumns = 0;

  const rows = body.map((cells) => {
    const row = emptyRow();

    cells.forEach((value, columnIndex) => {
      const field = mapping
        ? (mapping.fields[columnIndex] ?? null)
        : (GRID_FIELDS[startIndex + columnIndex] ?? null);

      if (!field) {
        if (!mapping && value.trim() !== '') truncatedColumns += 1;
        return;
      }
      row[field] = options.normalize === false ? value.trim() : normalizeCell(field, value);
    });

    return row;
  });

  return {
    rows,
    mapping,
    ignoredColumns: mapping?.ignored ?? [],
    unknownColumns: mapping?.unknown ?? [],
    truncatedColumns,
  };
}

/**
 * Tidy a pasted value into the form the grid expects, without ever guessing at meaning.
 *
 * Nationality is the only field that is translated (a country name becomes its code, and
 * only when the name resolves). A date is reformatted only when its shape is unambiguous —
 * nothing here decides that `05/06/2028` is June rather than May; that is the parser's job
 * downstream, where day-first is applied strictly.
 */
export function normalizeCell(field: GridField, raw: string): string {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value === '') return '';

  switch (field) {
    case 'applicationType': {
      // People write this several ways; anything unrecognised is left alone so the cell
      // shows an error rather than silently becoming "single".
      const lower = value.toLowerCase().replace(/\s+/g, ' ');
      if (['single', '1', 'singel', 'sengel', 'sngel'].includes(lower)) return 'single';
      if (['family of 2', 'family 2', 'family_2', '2', 'couple', 'double'].includes(lower)) return 'family_2';
      if (['family of 4', 'family 4', 'family_4', '4'].includes(lower)) return 'family_4';
      return (APPLICATION_TYPES as readonly string[]).includes(lower) ? (lower as ApplicationType) : value;
    }
    case 'gender': {
      const lower = value.toLowerCase();
      if (['m', 'male', 'ذكر'].includes(lower)) return 'Male';
      if (['f', 'female', 'أنثى', 'انثى'].includes(lower)) return 'Female';
      return value;
    }
    case 'nationality': {
      // A name that does not resolve is left exactly as typed, so the cell shows an error
      // rather than a silent guess.
      return resolveCountryName(value) ?? value;
    }
    case 'passportNumber':
      return value.toUpperCase();
    case 'contactNumberDialCode':
      return value.replace(/^\+/, '').replace(/\s|-/g, '');
    case 'contactEmail':
      return value.toLowerCase();
    default:
      return value;
  }
}
