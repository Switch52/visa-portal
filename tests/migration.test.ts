/**
 * The migration transform.
 *
 * These use rows shaped like the real sheets but with invented passport numbers and names —
 * the structure is what is being tested, and real personal data has no business in a
 * committed test file.
 *
 * What matters here is that nothing is guessed and nothing is lost: a date that is not
 * day-first stops its row, a country name that does not resolve stops its row, and any note
 * text the importer does not understand survives verbatim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findCrossAgencyDuplicates, readNote, transformSheet, type SheetMapping } from '@/lib/migration/transform';

const mando: SheetMapping = {
  agency: 'mando',
  agencyName: 'Mando',
  file: 'mando-client-details.csv',
  sheet: 'Client Details',
  defaultCurrency: 'USD',
  dateFormat: 'DD/MM/YYYY',
  defaultApplicationType: 'single',
  columns: {
    firstName: 'First Name',
    lastName: 'Last Name',
    nationality: 'Nationality',
    passportNumber: 'Passport Number',
    passportExpiryDate: 'Passport Expiry Date',
    dateOfBirth: 'Date of Birth',
    gender: 'Gender',
    added: 'Added?',
    notes: 'Notes',
  },
  ignoredColumns: ['A'],
  appendToNotesColumns: [],
};

const MANDO_HEADER = [
  'A',
  'First Name',
  'Last Name',
  'Nationality',
  'Passport Number',
  'Passport Expiry Date',
  'Date of Birth',
  'Gender',
  'Added?',
  'Notes',
];

/** Karam's sheet: address columns in the middle, an unnamed column at the end. */
const karam: SheetMapping = {
  ...mando,
  agency: 'karam',
  agencyName: 'Karam',
  file: 'karam-client-details.csv',
  ignoredColumns: ['#', 'Address Line 1', 'City'],
  appendToNotesColumns: ['(unnamed 12)'],
};

const KARAM_HEADER = [
  '#',
  'First Name',
  'Last Name',
  'Nationality',
  'Passport Number',
  'Passport Expiry Date',
  'Date of Birth',
  'Gender',
  'Address Line 1',
  'City',
  'Added?',
  'Notes',
  '',
];

function mandoRow(overrides: string[] = []): string[] {
  const base = ['1', 'SALMA', 'SOLIMAN', 'Egypt', 'A11111111', '15/09/2032', '11/07/1995', 'Female', 'Yes', ''];
  overrides.forEach((value, index) => {
    if (value !== '') base[index] = value;
  });
  return base;
}

describe('reading the notes column', () => {
  it('reads the misspellings as one application type', () => {
    for (const spelling of ['SINGEL', 'SENGEL', 'SNGEL', 'singel']) {
      assert.equal(readNote(spelling).applicationType, 'single');
    }
  });

  it('reads CANCEL as a cancellation', () => {
    assert.equal(readNote('CANCEL').cancelled, true);
    assert.equal(readNote('SINGEL').cancelled, false);
  });

  it('reads a hold date, with either separator', () => {
    assert.equal(readNote('SINGEL AFTER 27/8').holdUntil, '2026-08-27');
    assert.equal(readNote('SINGEL AFETER 15\\9').holdUntil, '2026-09-15');
    assert.equal(readNote('SINGEL  AFTER 22/8').holdUntil, '2026-08-22');
  });

  it('reads the Arabic urgency marker as a priority', () => {
    assert.equal(readNote('مهم جدا يتحجز').priority, 'urgent');
    assert.equal(readNote('SINGEL').priority, 'normal');
  });

  it('keeps everything it does not understand, exactly as written', () => {
    assert.equal(readNote('SINGEL GO NEW YES').residual, 'GO NEW YES');
    assert.equal(readNote('OK GO NOW').residual, 'OK GO NOW');
    // An Arabic note that is not the urgency marker is a working note, and survives whole.
    assert.equal(
      readNote('شغله عادي مفيش مشكله هيعمل جواز جديد').residual,
      'شغله عادي مفيش مشكله هيعمل جواز جديد',
    );
  });

  it('reports what it read, so the interpretation can be checked', () => {
    const reading = readNote('SINGEL AFTER 27/8');
    assert.deepEqual(reading.extracted, ['applicationType: single', 'holdUntil: 2026-08-27']);
  });
});

describe('turning a row into a passport', () => {
  it('takes a good row across whole', () => {
    const result = transformSheet(mando, MANDO_HEADER, [mandoRow()]);

    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.input.firstName, 'SALMA');
    assert.equal(row.input.nationality, 'EGY');
    assert.equal(row.input.passportExpiryDate, '2032-09-15');
    assert.equal(row.input.dateOfBirth, '1995-07-11');
    assert.equal(row.status, 'added');
  });

  it('reads dates day-first, and rejects anything that is not', () => {
    const dayFirst = transformSheet(mando, MANDO_HEADER, [mandoRow(['', '', '', '', '', '05/06/2028'])]);
    assert.equal(dayFirst.rows[0]!.input.passportExpiryDate, '2028-06-05');

    const wrong = transformSheet(mando, MANDO_HEADER, [mandoRow(['', '', '', '', '', 'June 2028'])]);
    assert.equal(wrong.rows.length, 0);
    assert.match(wrong.rejected[0]!.reasons.join(' '), /not a DD\/MM\/YYYY date/);
  });

  it('rejects a country name it cannot map rather than guessing', () => {
    const result = transformSheet(mando, MANDO_HEADER, [mandoRow(['', '', '', 'Wakanda'])]);

    assert.equal(result.rows.length, 0);
    assert.match(result.rejected[0]!.reasons.join(' '), /does not map to a country code/);
    assert.deepEqual(result.unmapped[0], { sourceRow: 2, field: 'nationality', value: 'Wakanda' });
  });

  it('maps every country the real sheets contain', () => {
    const countries = ['Egypt', 'Philippines', 'Libya', 'Russia', 'Turkey', 'Uzbekistan', 'Armenia', 'Jordan', 'Syria', 'Saudi Arabia'];
    const rows = countries.map((country, index) =>
      mandoRow(['', '', '', country, `A1000000${index}`]),
    );

    const result = transformSheet(mando, MANDO_HEADER, rows);
    assert.equal(result.rows.length, countries.length);
    assert.deepEqual(
      result.rows.map((row) => row.input.nationality),
      ['EGY', 'PHL', 'LBY', 'RUS', 'TUR', 'UZB', 'ARM', 'JOR', 'SYR', 'SAU'],
    );
  });

  it('skips a row with no passport number, and says what was in it', () => {
    const junk = ['', '', '', 'Egypt', '', '', '', 'Female', 'Yes', ''];
    const result = transformSheet(mando, MANDO_HEADER, [junk]);

    assert.equal(result.rows.length, 0);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.junk.length, 1);
    assert.deepEqual(result.junk[0]!.nonEmpty, { Nationality: 'Egypt', Gender: 'Female', 'Added?': 'Yes' });
  });

  it('rejects a half-filled row and lists everything missing at once', () => {
    const result = transformSheet(mando, MANDO_HEADER, [
      ['153', 'ABDALLAH', 'KENSOWA', 'Egypt', 'A99999999', '', '', '', '', ''],
    ]);

    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.rejected[0]!.reasons, [
      'No gender',
      'No passport expiry date',
      'No date of birth',
    ]);
  });
});

describe('what status a row lands in', () => {
  const statusOf = (added: string, note: string) =>
    transformSheet(mando, MANDO_HEADER, [mandoRow(['', '', '', '', '', '', '', '', added || ' ', note])]).rows[0]
      ?.status;

  it('takes Added? = Yes as handed off, not booked', () => {
    assert.equal(statusOf('Yes', 'SINGEL'), 'added');
  });

  it('takes No and blank the same way', () => {
    assert.equal(statusOf('No', ''), 'submitted');
    assert.equal(statusOf(' ', ''), 'submitted');
  });

  it('lets CANCEL in the note override Added? = Yes', () => {
    assert.equal(statusOf('Yes', 'CANCEL'), 'cancelled');
  });

  it('puts a row with a hold date on hold, whatever Added? says', () => {
    assert.equal(statusOf('No', 'SINGEL AFTER 27/8'), 'on_hold');
    const row = transformSheet(mando, MANDO_HEADER, [
      mandoRow(['', '', '', '', '', '', '', '', 'No', 'SINGEL AFTER 27/8']),
    ]).rows[0]!;
    assert.equal(row.input.holdUntil, '2026-08-27');
  });

  it('never produces booked, because the sheets cannot say', () => {
    const statuses = ['Yes', 'No', ''].flatMap((added) =>
      ['', 'SINGEL', 'CANCEL', 'SINGEL AFTER 27/8'].map((note) => statusOf(added, note)),
    );
    assert.equal(statuses.includes('booked'), false);
  });
});

describe("Karam's sheet in particular", () => {
  const row = (notes: string, trailing: string) => [
    '66',
    'MOHAMED',
    'ABOUELKHEIR',
    'Egypt',
    'A22222222',
    '18/12/2030',
    '15/02/1970',
    'Male',
    '12 Some Street',
    'Cairo',
    'No',
    notes,
    trailing,
  ];

  it('reads past the address columns without storing them', () => {
    const result = transformSheet(karam, KARAM_HEADER, [row('SINGEL', '')]);

    const stored = JSON.stringify(result.rows[0]!.input);
    assert.equal(stored.includes('12 Some Street'), false);
    assert.equal(stored.includes('Cairo'), false);
  });

  it('keeps the unnamed trailing column by appending it to the notes', () => {
    const result = transformSheet(karam, KARAM_HEADER, [row('SINGEL AFTER 27/8', 'OK GO NOW')]);
    const passport = result.rows[0]!;

    assert.equal(passport.input.notes, 'OK GO NOW');
    assert.equal(passport.input.holdUntil, '2026-08-27');
    assert.equal(passport.status, 'on_hold');
  });

  it('keeps the raw row for provenance, addresses and all', () => {
    const result = transformSheet(karam, KARAM_HEADER, [row('SINGEL', 'OK GO NOW')]);

    // The record can always be traced back to the exact cells it came from.
    assert.equal(result.rows[0]!.raw['Address Line 1'], '12 Some Street');
    assert.equal(result.rows[0]!.sourceRow, 2);
  });
});

describe('corrections', () => {
  it('lets a rejected row be fixed without touching the original sheet', () => {
    const broken = ['153', 'ABDALLAH', 'KENSOWA', 'Egypt', 'A99999999', '', '', '', '', ''];

    const before = transformSheet(mando, MANDO_HEADER, [broken]);
    assert.equal(before.rejected.length, 1);

    const after = transformSheet(mando, MANDO_HEADER, [broken], {
      corrections: {
        'mando:2': {
          gender: 'Male',
          passportExpiryDate: '30/06/2033',
          dateOfBirth: '01/01/1990',
        },
      },
    });

    assert.equal(after.rejected.length, 0);
    assert.equal(after.rows[0]!.input.passportExpiryDate, '2033-06-30');
  });
});

describe('cross-agency duplicates', () => {
  it('finds a passport that appears under two agencies', () => {
    const one = transformSheet(mando, MANDO_HEADER, [mandoRow(['', '', '', '', 'A33333333'])]);
    const two = transformSheet(karam, MANDO_HEADER, [mandoRow(['', '', '', '', 'A33333333'])]);

    const duplicates = findCrossAgencyDuplicates([
      { agency: 'mando', rows: one.rows },
      { agency: 'karam', rows: two.rows },
    ]);

    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]!.normalized, 'A33333333');
    assert.deepEqual(duplicates[0]!.occurrences.map((entry) => entry.agency).sort(), ['karam', 'mando']);
  });

  it('does not flag the same number twice within one agency as a cross-agency clash', () => {
    const result = transformSheet(mando, MANDO_HEADER, [
      mandoRow(['', '', '', '', 'A44444444']),
      mandoRow(['', '', '', '', 'A44444444']),
    ]);

    assert.deepEqual(findCrossAgencyDuplicates([{ agency: 'mando', rows: result.rows }]), []);
  });
});
