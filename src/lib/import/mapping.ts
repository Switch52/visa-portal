/**
 * How a booking file's columns are recognised.
 *
 * **This mapping is a starting point, not a specification.** The real booking files have
 * not been seen yet, so nothing here is a guess dressed up as a fact: the aliases are the
 * spellings such files usually carry, the mapping is stored in settings and editable, and
 * the parser refuses a file it cannot read rather than importing something it half
 * recognises. When real examples arrive, they get profiled and this table gets corrected.
 */

export type BookingField = 'passportNumber' | 'appointmentDate' | 'appointmentTime' | 'location' | 'reference' | 'name';

export interface BookingColumnRule {
  field: BookingField;
  /** Matched case-insensitively, after collapsing whitespace. */
  aliases: string[];
  required: boolean;
}

export interface BookingImportTemplate {
  columns: BookingColumnRule[];
  /**
   * Day-first, like everything else in this data. Only switch this if a real file proves
   * otherwise — and a file whose dates are ambiguous should be reported, never guessed at.
   */
  dateOrder: 'day-first' | 'month-first';
  /** The centre's timezone, so an appointment instant can be read back locally. */
  timezone: string;
  /**
   * Carry a value down into the blank rows beneath it — the trick the payments sheet
   * needs, and the shape merged cells arrive in. Off unless a real file needs it.
   */
  fillDown: BookingField[];
  /** Rows to scan for a header before giving up. Files often carry a title block first. */
  headerSearchRows: number;
}

export const BOOKING_IMPORT_TEMPLATE_KEY = 'booking_import_template';

export const DEFAULT_BOOKING_IMPORT_TEMPLATE: BookingImportTemplate = {
  columns: [
    {
      field: 'passportNumber',
      aliases: [
        'passport number',
        'passport no',
        'passport no.',
        'passport',
        'passportnumber',
        'document number',
        'doc no',
      ],
      required: true,
    },
    {
      field: 'appointmentDate',
      aliases: [
        'appointment date',
        'appointment',
        'date',
        'appt date',
        'interview date',
        'visit date',
        'booking date',
      ],
      required: true,
    },
    {
      field: 'appointmentTime',
      aliases: ['appointment time', 'time', 'appt time', 'slot', 'time slot'],
      required: false,
    },
    {
      field: 'location',
      aliases: ['location', 'center', 'centre', 'appointment center', 'appointment centre', 'vac', 'office'],
      required: false,
    },
    {
      field: 'reference',
      aliases: [
        'reference',
        'reference number',
        'confirmation number',
        'confirmation',
        'booking reference',
        'ref',
        'grn',
      ],
      required: false,
    },
    {
      field: 'name',
      aliases: ['name', 'full name', 'applicant name', 'applicant', 'first name'],
      required: false,
    },
  ],
  dateOrder: 'day-first',
  timezone: 'Africa/Cairo',
  fillDown: [],
  headerSearchRows: 25,
};

export function validateBookingTemplate(input: unknown): BookingImportTemplate {
  if (typeof input !== 'object' || input === null) throw new Error('That import mapping is not readable.');
  const candidate = input as Partial<BookingImportTemplate>;

  const columns = Array.isArray(candidate.columns) ? candidate.columns : [];
  if (!columns.some((column) => column.field === 'passportNumber')) {
    throw new Error('The mapping needs a passport number column — it is what rows are matched on.');
  }

  return {
    columns: columns.map((column) => ({
      field: column.field,
      aliases: (column.aliases ?? []).map((alias) => String(alias).toLowerCase()),
      required: Boolean(column.required),
    })),
    dateOrder: candidate.dateOrder === 'month-first' ? 'month-first' : 'day-first',
    timezone: candidate.timezone || DEFAULT_BOOKING_IMPORT_TEMPLATE.timezone,
    fillDown: candidate.fillDown ?? [],
    headerSearchRows: candidate.headerSearchRows ?? DEFAULT_BOOKING_IMPORT_TEMPLATE.headerSearchRows,
  };
}
