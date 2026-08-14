/**
 * The grid's columns, in the order they are typed and pasted.
 *
 * The order matches the agency sheets people are pasting from, so a straight copy of
 * their existing columns lands in the right cells. Keeping this as data means a new
 * column is one entry here rather than an edit to the grid, the parser and the save path.
 */

export type GridField =
  | 'applicationType'
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
  | 'notes';

export interface GridColumn {
  field: GridField;
  label: string;
  /** Width class for the cell. Keeps the grid readable without a layout pass per screen. */
  width: string;
  placeholder?: string;
  hint?: string;
  required: boolean;
  /** Header spellings seen in the real sheets, matched case-insensitively on paste. */
  aliases: string[];
}

export const GRID_COLUMNS: readonly GridColumn[] = [
  {
    // First, because it decides whether the rows below belong together as one family.
    field: 'applicationType',
    label: 'Application',
    width: 'w-28',
    hint: 'Single or family',
    required: false,
    aliases: ['application', 'application type', 'type', 'applicationtype'],
  },
  {
    field: 'firstName',
    label: 'First name',
    width: 'w-36',
    required: true,
    aliases: ['first name', 'firstname', 'given name', 'first'],
  },
  {
    field: 'lastName',
    label: 'Last name',
    width: 'w-36',
    required: true,
    aliases: ['last name', 'lastname', 'surname', 'family name', 'last'],
  },
  {
    field: 'passportNumber',
    label: 'Passport number',
    width: 'w-36',
    required: true,
    aliases: ['passport number', 'passport no', 'passport', 'passportnumber'],
  },
  {
    field: 'passportExpiryDate',
    label: 'Expiry',
    width: 'w-32',
    placeholder: 'DD/MM/YYYY',
    hint: 'Day first',
    required: true,
    aliases: ['passport expiry date', 'expiry', 'expiry date', 'passport expiry', 'exp'],
  },
  {
    field: 'dateOfBirth',
    label: 'Date of birth',
    width: 'w-32',
    placeholder: 'DD/MM/YYYY',
    hint: 'Day first',
    required: true,
    aliases: ['date of birth', 'dob', 'birth date', 'birthdate'],
  },
  {
    field: 'nationality',
    label: 'Nationality',
    width: 'w-32',
    placeholder: 'Egypt',
    hint: 'Country name or code',
    required: true,
    aliases: ['nationality', 'country', 'citizenship'],
  },
  {
    field: 'gender',
    label: 'Gender',
    width: 'w-24',
    placeholder: 'Male',
    required: true,
    aliases: ['gender', 'sex'],
  },
  {
    field: 'contactNumber',
    label: 'Phone',
    width: 'w-32',
    required: false,
    aliases: ['contact number', 'phone', 'mobile', 'telephone'],
  },
  {
    field: 'contactNumberDialCode',
    label: 'Dial code',
    width: 'w-24',
    placeholder: '20',
    hint: 'Digits, no +',
    required: false,
    aliases: ['contact number dial code', 'dial code', 'country code', 'dialcode'],
  },
  {
    field: 'contactEmail',
    label: 'Email',
    width: 'w-44',
    required: false,
    aliases: ['contact email', 'email', 'e-mail'],
  },
  {
    field: 'notes',
    label: 'Notes',
    width: 'w-48',
    hint: 'Arabic or English',
    required: false,
    aliases: ['notes', 'note', 'comments', 'remarks'],
  },
];

export const GRID_FIELDS: readonly GridField[] = GRID_COLUMNS.map((column) => column.field);

/** Columns the sheets carry that this portal deliberately does not model. */
export const IGNORED_PASTE_COLUMNS = [
  'address line 1',
  'address line 2',
  'city',
  'state / province',
  'state/province',
  'postal code',
  'added?',
  'added',
  '#',
  'a',
  'index',
  'no',
];
