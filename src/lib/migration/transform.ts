/**
 * Turning a row of an agency's sheet into a passport.
 *
 * Two principles, and everything here follows from them:
 *
 *   1. **Nothing is guessed.** A date that is not `DD/MM/YYYY`, a country name that does not
 *      resolve, a gender that is not one of two values — each stops that row and is
 *      reported, rather than being coerced into something plausible. A wrong guess here
 *      puts the wrong details on a visa application.
 *   2. **Nothing is lost.** The notes column is doing four jobs at once; what is understood
 *      becomes a real field, and everything else stays in `notes` exactly as written. When
 *      in doubt, preserve.
 */

import { resolveCountryName } from '@/config/countries';
import { normalizePassportNumber, type ApplicationType, type Priority } from '@/config/validation';
import type { PassportStatus } from '@/config/statuses';
import { formatDateOnly, parseDayFirstDate } from '@/lib/dates';

export interface SheetMapping {
  agency: string;
  agencyName: string;
  file: string;
  sheet: string;
  defaultCurrency: string;
  dateFormat: 'DD/MM/YYYY';
  defaultApplicationType: ApplicationType;
  columns: Partial<Record<'firstName' | 'lastName' | 'nationality' | 'passportNumber' | 'passportExpiryDate' | 'dateOfBirth' | 'gender' | 'added' | 'notes', string>>;
  ignoredColumns: string[];
  appendToNotesColumns: string[];
  notes?: string;
}

export interface TransformedRow {
  /** 1-based row number in the source file — the index column is not trustworthy. */
  sourceRow: number;
  passportNumber: string;
  normalized: string;
  input: {
    firstName: string;
    lastName: string;
    passportNumber: string;
    passportExpiryDate: string;
    dateOfBirth: string;
    nationality: string;
    gender: 'Male' | 'Female';
    applicationType: ApplicationType;
    priority: Priority;
    holdUntil?: string | null;
    notes?: string | null;
  };
  /** The status this row lands in, worked out from `Added?` and the note together. */
  status: PassportStatus;
  /** What the notes column was read as, so the interpretation can be checked. */
  extracted: string[];
  /** The note text left after extraction, kept verbatim. */
  residualNote: string;
  raw: Record<string, string>;
}

export interface RejectedRow {
  sourceRow: number;
  passportNumber: string;
  reasons: string[];
  raw: Record<string, string>;
}

export interface JunkRow {
  sourceRow: number;
  nonEmpty: Record<string, string>;
}

export interface TransformResult {
  rows: TransformedRow[];
  rejected: RejectedRow[];
  junk: JunkRow[];
  /** Values the mapping could not translate — an unmapped country, mostly. */
  unmapped: { sourceRow: number; field: string; value: string }[];
}

/** Hold dates in the sheets carry no year: `AFTER 27/8`. */
export const HOLD_YEAR = 2026;

/**
 * Held as source strings, not as `RegExp` objects.
 *
 * A shared regex carrying the `g` flag keeps its `lastIndex` between calls, so testing the
 * same pattern against successive rows silently alternates between matching and not. Every
 * use below builds a fresh regex, which is the only way this stays correct row after row.
 */
const NOTE_PATTERNS = {
  single: '\\b(SINGEL|SENGEL|SNGEL|SINGLE)\\b',
  cancel: '\\b(CANCEL|CANCELLED|CANCELED)\\b',
  hold: '\\b(?:AFTER|AFETER|AFTR)\\b\\s*(\\d{1,2})\\s*[/\\\\.-]\\s*(\\d{1,2})(?:\\s*[/\\\\.-]\\s*(\\d{2,4}))?',
  urgent: 'مهم\\s*جدا\\s*يتحجز',
} as const;

const pattern = (key: keyof typeof NOTE_PATTERNS, flags = 'gi') => new RegExp(NOTE_PATTERNS[key], flags);

export interface NoteReading {
  applicationType: ApplicationType | null;
  cancelled: boolean;
  holdUntil: string | null;
  priority: Priority;
  residual: string;
  extracted: string[];
}

/**
 * Read the notes column.
 *
 * The misspellings are matched deliberately — `SINGEL`, `SENGEL` and `SNGEL` are all the
 * same word typed in a hurry — and both `27/8` and `15\9` separators appear, so both are
 * handled. Whatever is left over is the admin's own working marker and is kept.
 */
export function readNote(note: string, defaultType: ApplicationType = 'single'): NoteReading {
  const extracted: string[] = [];
  let residual = note.trim().replace(/\s+/g, ' ');

  let applicationType: ApplicationType | null = null;
  if (pattern('single').test(note)) {
    applicationType = 'single';
    extracted.push('applicationType: single');
    residual = residual.replace(pattern('single'), ' ');
  }

  const cancelled = pattern('cancel').test(note);
  if (cancelled) {
    extracted.push('status: cancelled');
    residual = residual.replace(pattern('cancel'), ' ');
  }

  let holdUntil: string | null = null;
  const holdMatch = pattern('hold').exec(note);
  if (holdMatch) {
    const day = Number(holdMatch[1]);
    const month = Number(holdMatch[2]);
    // No year is written in these notes; they are all this season's.
    const year = holdMatch[3] ? Number(holdMatch[3].length === 2 ? `20${holdMatch[3]}` : holdMatch[3]) : HOLD_YEAR;
    try {
      holdUntil = formatDateOnly(new Date(Date.UTC(year, month - 1, day)));
      extracted.push(`holdUntil: ${holdUntil}`);
      residual = residual.replace(pattern('hold'), ' ');
    } catch {
      // An unreadable hold date stays in the note rather than being invented.
    }
  }

  let priority: Priority = 'normal';
  if (pattern('urgent', 'g').test(note)) {
    priority = 'urgent';
    extracted.push('priority: urgent');
    residual = residual.replace(pattern('urgent', 'g'), ' ');
  }

  residual = residual.replace(/\s+/g, ' ').replace(/^[|\s-]+|[|\s-]+$/g, '').trim();

  return {
    applicationType: applicationType ?? (note.trim() === '' ? defaultType : null),
    cancelled,
    holdUntil,
    priority,
    residual,
    extracted,
  };
}

export interface TransformOptions {
  /** Cross-agency duplicates the admin has assigned, by normalized number → agency key. */
  duplicateOwners?: Record<string, string>;
  /** Corrections keyed by `<agency>:<sourceRow>`, merged over the sheet's own values. */
  corrections?: Record<string, Partial<Record<string, string>>>;
}

/**
 * Apply one sheet's mapping to its rows.
 *
 * `header` and `rows` come straight from the CSV reader, so the row numbers reported here
 * are the ones in the file — which is what someone will be looking at when they check.
 */
export function transformSheet(
  mapping: SheetMapping,
  header: string[],
  rows: string[][],
  options: TransformOptions = {},
): TransformResult {
  const result: TransformResult = { rows: [], rejected: [], junk: [], unmapped: [] };

  const indexOf = (column?: string): number => (column ? header.indexOf(column) : -1);
  const columnIndex = {
    firstName: indexOf(mapping.columns.firstName),
    lastName: indexOf(mapping.columns.lastName),
    nationality: indexOf(mapping.columns.nationality),
    passportNumber: indexOf(mapping.columns.passportNumber),
    passportExpiryDate: indexOf(mapping.columns.passportExpiryDate),
    dateOfBirth: indexOf(mapping.columns.dateOfBirth),
    gender: indexOf(mapping.columns.gender),
    added: indexOf(mapping.columns.added),
    notes: indexOf(mapping.columns.notes),
  };

  // Unnamed columns are addressed positionally, the way the profiler reported them.
  const appendIndexes = mapping.appendToNotesColumns.map((name) => {
    const unnamed = /^\(unnamed (\d+)\)$/.exec(name);
    return unnamed ? Number(unnamed[1]) : header.indexOf(name);
  });

  rows.forEach((cells, offset) => {
    const sourceRow = offset + 2; // 1-based, and the header is row 1
    const cell = (index: number): string => (index === -1 ? '' : (cells[index] ?? '').trim());

    const raw: Record<string, string> = {};
    header.forEach((name, index) => {
      const value = (cells[index] ?? '').trim();
      if (value !== '') raw[name || `(unnamed ${index})`] = value;
    });
    appendIndexes.forEach((index) => {
      const value = (cells[index] ?? '').trim();
      if (value !== '') raw[`(unnamed ${index})`] = value;
    });

    const corrections = options.corrections?.[`${mapping.agency}:${sourceRow}`] ?? {};
    const read = (field: keyof typeof columnIndex): string =>
      corrections[field] ?? cell(columnIndex[field]);

    const passportNumber = read('passportNumber');

    // A row with no passport number is not a person; it is a leftover from editing.
    if (passportNumber === '') {
      if (Object.keys(raw).length > 0) result.junk.push({ sourceRow, nonEmpty: raw });
      return;
    }

    const reasons: string[] = [];

    const firstName = read('firstName');
    const lastName = read('lastName');
    if (firstName === '') reasons.push('No first name');
    if (lastName === '') reasons.push('No last name');

    const genderRaw = read('gender');
    const gender = genderRaw === 'Male' || genderRaw === 'Female' ? genderRaw : null;
    if (!gender) reasons.push(genderRaw === '' ? 'No gender' : `Gender "${genderRaw}" is not Male or Female`);

    const nationalityRaw = read('nationality');
    const nationality = nationalityRaw === '' ? null : resolveCountryName(nationalityRaw);
    if (nationalityRaw === '') reasons.push('No nationality');
    else if (!nationality) {
      reasons.push(`Nationality "${nationalityRaw}" does not map to a country code`);
      result.unmapped.push({ sourceRow, field: 'nationality', value: nationalityRaw });
    }

    const expiryRaw = read('passportExpiryDate');
    const dobRaw = read('dateOfBirth');
    let expiry: string | null = null;
    let dob: string | null = null;

    // Strict, day-first, always. Never a permissive parser.
    try {
      expiry = expiryRaw === '' ? null : formatDateOnly(parseDayFirstDate(expiryRaw));
    } catch {
      reasons.push(`Expiry "${expiryRaw}" is not a ${mapping.dateFormat} date`);
    }
    if (expiryRaw === '') reasons.push('No passport expiry date');

    try {
      dob = dobRaw === '' ? null : formatDateOnly(parseDayFirstDate(dobRaw));
    } catch {
      reasons.push(`Date of birth "${dobRaw}" is not a ${mapping.dateFormat} date`);
    }
    if (dobRaw === '') reasons.push('No date of birth');

    // Notes, plus anything from a trailing column that belongs with them.
    const noteParts = [read('notes'), ...appendIndexes.map((index) => cell(index))].filter((part) => part !== '');
    const noteText = noteParts.join(' | ');
    const note = readNote(noteText, mapping.defaultApplicationType);

    const added = read('added').toLowerCase();
    let status: PassportStatus;
    if (note.cancelled) status = 'cancelled';
    else if (note.holdUntil) status = 'on_hold';
    else if (added === 'yes') status = 'added';
    else status = 'submitted';

    if (reasons.length > 0) {
      result.rejected.push({ sourceRow, passportNumber, reasons, raw });
      return;
    }

    result.rows.push({
      sourceRow,
      passportNumber,
      normalized: normalizePassportNumber(passportNumber),
      input: {
        firstName,
        lastName,
        passportNumber,
        passportExpiryDate: expiry!,
        dateOfBirth: dob!,
        nationality: nationality!,
        gender: gender!,
        applicationType: note.applicationType ?? mapping.defaultApplicationType,
        priority: note.priority,
        holdUntil: note.holdUntil,
        notes: note.residual || null,
      },
      status,
      extracted: note.extracted,
      residualNote: note.residual,
      raw,
    });
  });

  return result;
}

/** Passport numbers appearing under more than one agency. Reported, never resolved here. */
export function findCrossAgencyDuplicates(
  sheets: { agency: string; rows: TransformedRow[] }[],
): { normalized: string; occurrences: { agency: string; sourceRow: number; status: string }[] }[] {
  const seen = new Map<string, { agency: string; sourceRow: number; status: string }[]>();

  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const list = seen.get(row.normalized) ?? [];
      list.push({ agency: sheet.agency, sourceRow: row.sourceRow, status: row.status });
      seen.set(row.normalized, list);
    }
  }

  return [...seen.entries()]
    .filter(([, occurrences]) => new Set(occurrences.map((entry) => entry.agency)).size > 1)
    .map(([normalized, occurrences]) => ({ normalized, occurrences }));
}
