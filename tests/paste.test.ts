/**
 * The paste parser, against payloads shaped like the ones Excel and Google Sheets really
 * put on the clipboard — including the column sets from the two real agency sheets.
 *
 * No database here: the parser is a pure function and is tested as one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectHeader, normalizeCell, parsePaste, splitClipboardGrid } from '@/lib/grid/paste';
import { validateRow } from '@/lib/grid/validate';
import { GRID_FIELDS } from '@/lib/grid/columns';

describe('splitting a clipboard payload', () => {
  it('splits tabs and newlines into a grid', () => {
    const grid = splitClipboardGrid('a\tb\tc\n1\t2\t3');
    assert.deepEqual(grid, [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF endings and a trailing newline', () => {
    const grid = splitClipboardGrid('a\tb\r\n1\t2\r\n');
    assert.deepEqual(grid, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a quoted cell that contains a tab, a newline or a quote', () => {
    const grid = splitClipboardGrid('"one\ttwo"\t"line1\nline2"\t"say ""hi"""');
    assert.deepEqual(grid, [['one\ttwo', 'line1\nline2', 'say "hi"']]);
  });

  it('drops rows that are entirely empty', () => {
    const grid = splitClipboardGrid('a\tb\n\t\n1\t2');
    assert.deepEqual(grid, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('header detection', () => {
  it("recognises Mando's column set", () => {
    const mapping = detectHeader(['A', 'First Name', 'Last Name', 'Nationality', 'Passport Number', 'Passport Expiry Date', 'Date of Birth', 'Gender', 'Added?', 'Notes']);

    assert.ok(mapping);
    assert.deepEqual(mapping.fields, [
      null, // the index column
      'firstName',
      'lastName',
      'nationality',
      'passportNumber',
      'passportExpiryDate',
      'dateOfBirth',
      'gender',
      null, // Added? is ours to track, not theirs to send
      'notes',
    ]);
    assert.equal(mapping.unknown.length, 0);
  });

  it("reads past the address columns in Karam's sheet", () => {
    const mapping = detectHeader([
      '#',
      'First Name',
      'Last Name',
      'Nationality',
      'Passport Number',
      'Passport Expiry Date',
      'Date of Birth',
      'Gender',
      'Address Line 1',
      'Address Line 2',
      'City',
      'State / Province',
      'Postal Code',
      'Added?',
      'Notes',
    ]);

    assert.ok(mapping);
    assert.ok(mapping.ignored.includes('Address Line 1'));
    assert.ok(mapping.ignored.includes('Postal Code'));
    // Seven core fields plus Notes; the index, address and Added? columns map to nothing.
    assert.equal(mapping.fields.filter((field) => field !== null).length, 8);
  });

  it('does not mistake a data row for a header', () => {
    assert.equal(detectHeader(['SALMA', 'SOLIMAN', 'Egypt', 'A42865745']), null);
  });
});

describe('parsing a paste', () => {
  it('fills rows from a headerless paste starting at the focused cell', () => {
    const result = parsePaste('SALMA\tSOLIMAN\nNOURHAN\tATTEIA', { startField: 'firstName' });

    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]!.firstName, 'SALMA');
    assert.equal(result.rows[0]!.lastName, 'SOLIMAN');
    assert.equal(result.rows[1]!.firstName, 'NOURHAN');
  });

  it('starts filling from whichever cell the paste began in', () => {
    const result = parsePaste('A42865745\t15/09/2032', { startField: 'passportNumber' });

    assert.equal(result.rows[0]!.passportNumber, 'A42865745');
    assert.equal(result.rows[0]!.passportExpiryDate, '15/09/2032');
    assert.equal(result.rows[0]!.firstName, '');
  });

  it('matches columns by name when the header comes with the paste, in any order', () => {
    const text = [
      'Passport Number\tFirst Name\tLast Name\tGender\tNationality\tDate of Birth\tPassport Expiry Date',
      'A42865745\tSALMA\tSOLIMAN\tFemale\tEgypt\t11/07/1995\t15/09/2032',
    ].join('\n');

    const result = parsePaste(text);
    const row = result.rows[0]!;

    assert.equal(result.rows.length, 1);
    assert.equal(row.firstName, 'SALMA');
    assert.equal(row.passportNumber, 'A42865745');
    assert.equal(row.nationality, 'EGY'); // resolved to alpha-3 on the way in
    assert.equal(row.dateOfBirth, '11/07/1995'); // left day-first for the strict parser
  });

  it('drops the address columns rather than shifting everything after them', () => {
    const text = [
      '#\tFirst Name\tLast Name\tNationality\tPassport Number\tPassport Expiry Date\tDate of Birth\tGender\tAddress Line 1\tCity\tAdded?\tNotes',
      '1\tABDALLA\tELREFAEY\tEgypt\tA38475533\t30/07/2031\t05/09/2002\tMale\t12 Some St\tCairo\tYes\tSINGEL',
    ].join('\n');

    const result = parsePaste(text);
    const row = result.rows[0]!;

    assert.equal(row.firstName, 'ABDALLA');
    assert.equal(row.gender, 'Male');
    assert.equal(row.notes, 'SINGEL');
    assert.ok(result.ignoredColumns.includes('Address Line 1'));
    // Nothing from the address columns ends up anywhere in the row.
    assert.equal(Object.values(row).includes('12 Some St'), false);
    assert.equal(Object.values(row).includes('Cairo'), false);
  });

  it('reports pasted values that fall past the last column', () => {
    const result = parsePaste('x\ty\tz', { startField: 'notes' });
    assert.equal(result.truncatedColumns, 2);
  });
});

describe('normalizing pasted values', () => {
  it('maps the gender spellings people actually type', () => {
    assert.equal(normalizeCell('gender', 'male'), 'Male');
    assert.equal(normalizeCell('gender', 'F'), 'Female');
    assert.equal(normalizeCell('gender', 'Female'), 'Female');
  });

  it('turns a country name into its alpha-3 code, and leaves an unknown one alone', () => {
    assert.equal(normalizeCell('nationality', 'Egypt'), 'EGY');
    assert.equal(normalizeCell('nationality', 'Syria'), 'SYR');
    // Left as typed so the cell shows an error rather than a silent guess.
    assert.equal(normalizeCell('nationality', 'Wakanda'), 'Wakanda');
  });

  it('strips a leading + from a dial code, since the template wants bare digits', () => {
    assert.equal(normalizeCell('contactNumberDialCode', '+20'), '20');
  });

  it('leaves a date exactly as typed — day-first is decided by the parser, not here', () => {
    assert.equal(normalizeCell('passportExpiryDate', '05/06/2028'), '05/06/2028');
  });
});

describe('row validation', () => {
  const routeId = '507f1f77bcf86cd799439011';

  const row = (overrides: Partial<Record<(typeof GRID_FIELDS)[number], string>> = {}) => ({
    applicationType: 'single',
    firstName: 'SALMA',
    lastName: 'SOLIMAN',
    passportNumber: 'A42865745',
    passportExpiryDate: '15/09/2032',
    dateOfBirth: '11/07/1995',
    nationality: 'EGY',
    gender: 'Female',
    contactNumber: '',
    contactNumberDialCode: '',
    contactEmail: '',
    notes: '',
    ...overrides,
  });

  it('accepts a good row and hands back the API payload in ISO form', () => {
    const result = validateRow(row(), routeId);

    assert.equal(result.ok, true);
    assert.equal(result.input?.passportExpiryDate, '2032-09-15');
    assert.equal(result.input?.dateOfBirth, '1995-07-11');
  });

  it('reads a slash date day-first, never month-first', () => {
    // 05/06/2028 is 5 June. A permissive parser would call it 6 May half the time.
    const result = validateRow(row({ passportExpiryDate: '05/06/2028' }), routeId);
    assert.equal(result.input?.passportExpiryDate, '2028-06-05');
  });

  it('accepts an ISO date too, since that is what a date picker produces', () => {
    const result = validateRow(row({ passportExpiryDate: '2032-09-15' }), routeId);
    assert.equal(result.input?.passportExpiryDate, '2032-09-15');
  });

  it('flags an expired passport on the expiry cell', () => {
    const result = validateRow(row({ passportExpiryDate: '01/01/2020' }), routeId);
    assert.equal(result.ok, false);
    assert.match(result.errors.passportExpiryDate ?? '', /expired/i);
  });

  it('flags a nationality that is not a real country', () => {
    const result = validateRow(row({ nationality: 'Wakanda' }), routeId);
    assert.equal(result.ok, false);
    assert.ok(result.errors.nationality);
  });

  it('flags a missing required field on that cell, and not on the others', () => {
    const result = validateRow(row({ lastName: '' }), routeId);
    assert.equal(result.errors.lastName, 'Required');
    assert.equal(result.errors.firstName, undefined);
  });

  it('flags an unreadable date rather than guessing at it', () => {
    const result = validateRow(row({ dateOfBirth: '11 July 1995' }), routeId);
    assert.equal(result.ok, false);
    assert.match(result.errors.dateOfBirth ?? '', /DD\/MM\/YYYY/);
  });

  it('does not reject a passport number for having an unusual shape', () => {
    // Real numbers from the sheets: A9999999A, AA999999, and one all-numeric.
    for (const number of ['P0130496D', 'FA0722645', '761887529', 'S0383227']) {
      const result = validateRow(row({ passportNumber: number }), routeId);
      assert.equal(result.ok, true, `${number} should be accepted`);
    }
  });
});
