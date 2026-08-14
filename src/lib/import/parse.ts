/**
 * Reading a booking file.
 *
 * Real files are messier than a clean CSV: a title block above the data, a header split
 * across lines, merged cells, blank spacer rows, trailing totals, inconsistent column
 * names between one file and the next, and passport numbers with stray spaces. So the
 * parser locates things by content rather than by position, and — the important part —
 * **says clearly when a file does not look like what it expects instead of importing
 * whatever it managed to read.**
 *
 * Every problem it finds is reported with the row it came from. Nothing is guessed: an
 * unreadable date is a rejected row, not a date the parser picked.
 */

import ExcelJS from 'exceljs';

import { normalizePassportNumber } from '@/config/validation';
import { dateOnly } from '@/lib/dates';

import {
  DEFAULT_BOOKING_IMPORT_TEMPLATE,
  type BookingField,
  type BookingImportTemplate,
} from './mapping';

export interface ParsedBookingRow {
  /** 1-based row number in the source file, for tracing a value back to its cell. */
  rowNumber: number;
  passportNumber: string;
  passportNumberNormalized: string;
  appointmentAt: Date | null;
  appointmentDateText: string;
  appointmentTimeText: string;
  location: string;
  reference: string;
  name: string;
  /** The original row exactly as read, kept so anything can be traced back. */
  raw: Record<string, string>;
  problems: string[];
}

export interface ParseProblem {
  rowNumber: number | null;
  message: string;
}

export interface ParseResult {
  rows: ParsedBookingRow[];
  /** Rows that could not be used at all, with the reason. */
  rejected: ParsedBookingRow[];
  headerRow: number;
  sheetName: string | null;
  /** Header cells that were matched, and those we did not recognise. */
  recognisedColumns: { field: BookingField; header: string }[];
  unknownColumns: string[];
  problems: ParseProblem[];
  rowsInFile: number;
}

export class UnreadableFileError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = [],
  ) {
    super(message);
    this.name = 'UnreadableFileError';
  }
}

// ---------------------------------------------------------------------------
// Reading the raw grid out of a CSV or an XLSX
// ---------------------------------------------------------------------------

/** RFC-4180 CSV, tolerant of CRLF and quoted cells containing commas or newlines. */
export function parseCsvGrid(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += char;
      continue;
    }

    if (char === '"' && cell === '') inQuotes = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * XLSX via ExcelJS.
 *
 * Merged cells report their value only in the top-left cell, so the value is spread back
 * across the merged range — otherwise a merged appointment date reads as blank on every
 * row but the first, which is precisely the kind of silent hole this parser exists to stop.
 */
async function parseXlsxGrid(buffer: Buffer): Promise<{ grid: string[][]; sheetName: string }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new UnreadableFileError('That workbook has no sheets in it.');

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell);
    });
    grid[rowNumber - 1] = Array.from(cells, (value) => value ?? '');
  });

  for (let i = 0; i < grid.length; i += 1) grid[i] ??= [];

  // Spread merged values across their range.
  const merges = (sheet as unknown as { model?: { merges?: string[] } }).model?.merges ?? [];
  for (const range of merges) {
    const [start, end] = range.split(':');
    if (!start || !end) continue;
    const from = cellRef(start);
    const to = cellRef(end);
    const value = grid[from.row - 1]?.[from.col - 1] ?? '';
    if (value === '') continue;

    for (let r = from.row; r <= to.row; r += 1) {
      for (let c = from.col; c <= to.col; c += 1) {
        grid[r - 1] ??= [];
        grid[r - 1]![c - 1] = value;
      }
    }
  }

  return { grid, sheetName: sheet.name };
}

function cellRef(ref: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref.replace('$', ''));
  if (!match) return { row: 1, col: 1 };
  let col = 0;
  for (const char of match[1]!) col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]), col };
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel dates arrive as real dates; keep them unambiguous rather than re-formatting.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) return String((value as { result: unknown }).result ?? '');
    if ('richText' in value) {
      return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join('');
    }
    return '';
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Finding the header and mapping the columns
// ---------------------------------------------------------------------------

const clean = (value: string) => value.trim().replace(/\s+/g, ' ');

interface HeaderMatch {
  rowIndex: number;
  fields: (BookingField | null)[];
  recognised: { field: BookingField; header: string }[];
  unknown: string[];
}

/**
 * Locate the header by content, never by row number: files carry title blocks,
 * explanatory paragraphs and blank rows above the data, and those shift between files.
 */
function findHeader(grid: string[][], template: BookingImportTemplate): HeaderMatch | null {
  const limit = Math.min(grid.length, template.headerSearchRows);

  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const cells = grid[rowIndex] ?? [];
    const fields: (BookingField | null)[] = [];
    const recognised: { field: BookingField; header: string }[] = [];
    const unknown: string[] = [];

    for (const cell of cells) {
      // Header cells sometimes contain embedded newlines; treat them as one label.
      const label = clean(cell).toLowerCase();
      if (label === '') {
        fields.push(null);
        continue;
      }
      const rule = template.columns.find((column) => column.aliases.includes(label));
      if (rule && !recognised.some((entry) => entry.field === rule.field)) {
        fields.push(rule.field);
        recognised.push({ field: rule.field, header: clean(cell) });
      } else if (rule) {
        // A second column claiming the same meaning is left unmapped rather than
        // silently overwriting the first.
        fields.push(null);
        unknown.push(clean(cell));
      } else {
        fields.push(null);
        unknown.push(clean(cell));
      }
    }

    // A header must at least identify the passport number: it is what rows match on.
    if (recognised.some((entry) => entry.field === 'passportNumber')) {
      return { rowIndex, fields, recognised, unknown };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Parse an appointment date without guessing.
 *
 * ISO is taken as ISO. A slash or dash date is read in the configured order — day-first by
 * default, matching everything else in this data — and a value that contradicts that order
 * (a "month" above 12) is rejected and reported rather than quietly swapped.
 */
export function parseAppointmentDate(
  text: string,
  order: BookingImportTemplate['dateOrder'],
): { date: Date | null; problem?: string } {
  const value = clean(text);
  if (value === '') return { date: null, problem: 'No appointment date' };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) {
    return safeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), value);
  }

  const parts = /^(\d{1,2})[/\\.-](\d{1,2})[/\\.-](\d{2,4})$/.exec(value);
  if (parts) {
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    let year = Number(parts[3]);
    if (year < 100) year += 2000;

    const day = order === 'day-first' ? first : second;
    const month = order === 'day-first' ? second : first;

    if (month > 12) {
      return {
        date: null,
        problem: `"${value}" is not a ${order} date — its month reads as ${month}. Check the file's date order.`,
      };
    }
    return safeDate(year, month, day, value);
  }

  return { date: null, problem: `Could not read "${value}" as a date` };
}

function safeDate(year: number, month: number, day: number, original: string) {
  try {
    return { date: dateOnly(year, month, day) };
  } catch {
    return { date: null, problem: `"${original}" is not a real date` };
  }
}

/** `14:30`, `2:30 PM`, `1430`. Anything else leaves the appointment at midnight. */
export function parseAppointmentTime(text: string): { hours: number; minutes: number } | null {
  const value = clean(text).toLowerCase();
  if (value === '') return null;

  const match = /^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/.exec(value);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

export async function parseBookingFile(
  file: { buffer: Buffer; filename: string },
  template: BookingImportTemplate = DEFAULT_BOOKING_IMPORT_TEMPLATE,
): Promise<ParseResult> {
  const isCsv = /\.csv$/i.test(file.filename);
  const isExcel = /\.xlsx?$/i.test(file.filename);

  if (!isCsv && !isExcel) {
    throw new UnreadableFileError(
      'That file type is not one I can read.',
      ['Booking files should be .csv, .xls or .xlsx.'],
    );
  }

  let grid: string[][];
  let sheetName: string | null = null;

  try {
    if (isCsv) {
      grid = parseCsvGrid(file.buffer.toString('utf8'));
    } else {
      const parsed = await parseXlsxGrid(file.buffer);
      grid = parsed.grid;
      sheetName = parsed.sheetName;
    }
  } catch (error) {
    if (error instanceof UnreadableFileError) throw error;
    throw new UnreadableFileError('That file could not be opened.', [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (grid.length === 0) throw new UnreadableFileError('That file is empty.');

  const header = findHeader(grid, template);
  if (!header) {
    throw new UnreadableFileError('This does not look like a booking file.', [
      `Looked at the first ${template.headerSearchRows} rows and found no column naming the passport number.`,
      `Expected one of: ${template.columns.find((c) => c.field === 'passportNumber')?.aliases.join(', ')}.`,
      'If the real files use a different heading, add it to the import mapping in settings.',
    ]);
  }

  const problems: ParseProblem[] = [];
  const missingRequired = template.columns.filter(
    (column) => column.required && !header.recognised.some((entry) => entry.field === column.field),
  );
  for (const column of missingRequired) {
    problems.push({
      rowNumber: header.rowIndex + 1,
      message: `No ${column.field} column found. Rows will be rejected without it.`,
    });
  }
  if (header.unknown.length > 0) {
    problems.push({
      rowNumber: header.rowIndex + 1,
      message: `Columns not used: ${header.unknown.join(', ')}.`,
    });
  }

  const valueOf = (cells: string[], field: BookingField): string => {
    const index = header.fields.indexOf(field);
    return index === -1 ? '' : clean(cells[index] ?? '');
  };

  const rows: ParsedBookingRow[] = [];
  const rejected: ParsedBookingRow[] = [];
  const carried = new Map<BookingField, string>();
  let rowsInFile = 0;

  for (let i = header.rowIndex + 1; i < grid.length; i += 1) {
    const cells = grid[i] ?? [];
    if (cells.every((cell) => clean(cell) === '')) continue;
    rowsInFile += 1;

    const raw: Record<string, string> = {};
    header.fields.forEach((field, columnIndex) => {
      const label = clean(grid[header.rowIndex]?.[columnIndex] ?? `column ${columnIndex + 1}`);
      if (label !== '') raw[label] = clean(cells[columnIndex] ?? '');
    });

    const read = (field: BookingField): string => {
      let value = valueOf(cells, field);
      if (template.fillDown.includes(field)) {
        // Blank means "same as the row above" — the shape merged cells and sparse date
        // columns arrive in.
        if (value === '') value = carried.get(field) ?? '';
        else carried.set(field, value);
      }
      return value;
    };

    const passportNumber = read('passportNumber');
    const appointmentDateText = read('appointmentDate');
    const appointmentTimeText = read('appointmentTime');

    const rowProblems: string[] = [];
    let appointmentAt: Date | null = null;

    if (passportNumber === '') rowProblems.push('No passport number in this row');

    const parsedDate = parseAppointmentDate(appointmentDateText, template.dateOrder);
    if (parsedDate.problem) rowProblems.push(parsedDate.problem);
    if (parsedDate.date) {
      const time = parseAppointmentTime(appointmentTimeText);
      if (appointmentTimeText !== '' && !time) {
        rowProblems.push(`Could not read "${appointmentTimeText}" as a time`);
      }
      appointmentAt = new Date(parsedDate.date);
      if (time) appointmentAt.setUTCHours(time.hours, time.minutes, 0, 0);
    }

    const row: ParsedBookingRow = {
      rowNumber: i + 1,
      passportNumber,
      passportNumberNormalized: normalizePassportNumber(passportNumber),
      appointmentAt,
      appointmentDateText,
      appointmentTimeText,
      location: read('location'),
      reference: read('reference'),
      name: read('name'),
      raw,
      problems: rowProblems,
    };

    if (rowProblems.length > 0) rejected.push(row);
    else rows.push(row);
  }

  if (rows.length === 0 && rejected.length === 0) {
    throw new UnreadableFileError('That file has a header but no rows under it.', [
      `Header found on row ${header.rowIndex + 1}.`,
    ]);
  }

  return {
    rows,
    rejected,
    headerRow: header.rowIndex + 1,
    sheetName,
    recognisedColumns: header.recognised,
    unknownColumns: header.unknown,
    problems,
    rowsInFile,
  };
}
