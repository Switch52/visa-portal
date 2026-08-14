/**
 * The export file is the bridge between this portal and the main booking dashboard, so
 * these tests check the bytes, not the idea.
 *
 * The header is compared against `samples/main-dashboard-import-template.csv` itself —
 * if that file ever changes, these fail rather than quietly producing a file the other
 * system rejects.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_EXPORT_TEMPLATE,
  exportFilename,
  quoteCsvValue,
  renderCsv,
  validateTemplate,
  type ExportableRecord,
} from '@/lib/export/template';

const TEMPLATE_FILE = join(process.cwd(), 'samples', 'main-dashboard-import-template.csv');

const record: ExportableRecord = {
  firstName: 'Salma',
  lastName: 'Soliman',
  passportNumber: 'A04415418',
  passportExpiryDate: new Date(Date.UTC(2032, 8, 15)),
  dateOfBirth: new Date(Date.UTC(1995, 6, 11)),
  nationality: 'EGY',
  gender: 'Female',
  contactNumber: '1234567890',
  contactNumberDialCode: '20',
  contactEmail: 'salma@example.com',
};

function lines(csv: string): string[] {
  return csv.replace(/^﻿/, '').trimEnd().split('\r\n');
}

describe('the header', () => {
  it('matches the real import template, column for column', () => {
    const expected = readFileSync(TEMPLATE_FILE, 'utf8').split(/\r?\n/)[0]!;
    const produced = lines(renderCsv([record], DEFAULT_EXPORT_TEMPLATE))[0]!;

    // Ours is quoted per RFC-4180; the names themselves must be identical.
    const unquote = (line: string) => line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    assert.deepEqual(unquote(produced), expected.split(','));
  });

  it('keeps the literal " (optional)" suffixes exactly', () => {
    const header = lines(renderCsv([record], DEFAULT_EXPORT_TEMPLATE))[0]!;

    // These look like documentation and are not: they are the names that importer matches
    // on. Spaces and brackets included, not camel-cased, not stripped.
    assert.ok(header.includes('"contactNumber (optional)"'));
    assert.ok(header.includes('"contactNumberDialCode (optional)"'));
    assert.ok(header.includes('"contactEmail (optional)"'));
  });

  it('has ten columns, in the template order', () => {
    assert.equal(DEFAULT_EXPORT_TEMPLATE.columns.length, 10);
    assert.deepEqual(
      DEFAULT_EXPORT_TEMPLATE.columns.map((column) => column.source),
      [
        'firstName',
        'lastName',
        'passportNumber',
        'passportExpiryDate',
        'dateOfBirth',
        'nationality',
        'gender',
        'contactNumber',
        'contactNumberDialCode',
        'contactEmail',
      ],
    );
  });
});

describe('the values', () => {
  it('writes dates as YYYY-MM-DD, never locale-formatted', () => {
    const row = lines(renderCsv([record], DEFAULT_EXPORT_TEMPLATE))[1]!;
    assert.ok(row.includes('"2032-09-15"'));
    assert.ok(row.includes('"1995-07-11"'));
    // The difference between 03/04 and 04/03 is a booking on the wrong day.
    assert.equal(row.includes('15/09/2032'), false);
  });

  it('writes gender as the literal Male / Female the dashboard expects', () => {
    const row = lines(renderCsv([{ ...record, gender: 'Female' }], DEFAULT_EXPORT_TEMPLATE))[1]!;
    assert.ok(row.includes('"Female"'));
  });

  it('writes a dial code as bare digits, with no +', () => {
    const row = lines(renderCsv([{ ...record, contactNumberDialCode: '+20' }], DEFAULT_EXPORT_TEMPLATE))[1]!;
    assert.ok(row.includes('"20"'));
    assert.equal(row.includes('+20'), false);
  });

  it('keeps optional columns present but empty when there is no value', () => {
    const bare: ExportableRecord = {
      ...record,
      contactNumber: null,
      contactNumberDialCode: null,
      contactEmail: null,
    };
    const row = lines(renderCsv([bare], DEFAULT_EXPORT_TEMPLATE))[1]!;

    // A missing column shifts everything after it, so they stay — just empty.
    assert.equal(row.split(',').length, 10);
    assert.ok(row.endsWith('"","",""'));
  });

  it('preserves a passport number with a leading zero, as text', () => {
    const row = lines(renderCsv([{ ...record, passportNumber: 'A04415418' }], DEFAULT_EXPORT_TEMPLATE))[1]!;
    assert.ok(row.includes('"A04415418"'));
  });

  it('can force passport numbers to Excel text when that option is on', () => {
    const csv = renderCsv([{ ...record, passportNumber: '0761887529' }], {
      ...DEFAULT_EXPORT_TEMPLATE,
      excelTextFormulas: true,
    });
    // ="0761887529" — Excel keeps the leading zero instead of reading a number.
    assert.ok(lines(csv)[1]!.includes('"=""0761887529"""'));
  });
});

describe('surviving the trip through Excel and back', () => {
  it('starts with a UTF-8 BOM so Arabic and accents are not mojibake', () => {
    const csv = renderCsv([record], DEFAULT_EXPORT_TEMPLATE);
    assert.equal(csv.charCodeAt(0), 0xfeff);

    const bytes = Buffer.from(csv, 'utf8');
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it('round-trips an Arabic name unchanged', () => {
    const csv = renderCsv([{ ...record, firstName: 'سلمى', lastName: 'سليمان' }], DEFAULT_EXPORT_TEMPLATE);
    const decoded = Buffer.from(csv, 'utf8').toString('utf8');
    assert.ok(decoded.includes('"سلمى"'));
    assert.ok(decoded.includes('"سليمان"'));
  });

  it('quotes a comma in a name so it cannot shift every column after it', () => {
    const row = lines(renderCsv([{ ...record, lastName: 'Soliman, Jr' }], DEFAULT_EXPORT_TEMPLATE))[1]!;

    assert.ok(row.includes('"Soliman, Jr"'));
    // Ten fields still, despite the comma inside one of them.
    assert.equal(parseCsvLine(row).length, 10);
  });

  it('escapes a quote inside a value by doubling it, per RFC 4180', () => {
    const row = lines(renderCsv([{ ...record, firstName: 'Sal"ma' }], DEFAULT_EXPORT_TEMPLATE))[1]!;
    assert.ok(row.includes('"Sal""ma"'));
    assert.equal(parseCsvLine(row)[0], 'Sal"ma');
  });

  it('uses CRLF line endings and terminates the last row', () => {
    const csv = renderCsv([record, record], DEFAULT_EXPORT_TEMPLATE);
    assert.ok(csv.endsWith('\r\n'));
    assert.equal(csv.replace(/^﻿/, '').split('\r\n').filter(Boolean).length, 3);
  });
});

describe('filenames', () => {
  it('carries the date, the route and the count', () => {
    const name = exportFilename({
      date: new Date(Date.UTC(2026, 7, 14)),
      routeLabel: 'Lebanon → France · VFS Beirut',
      count: 40,
    });
    assert.equal(name, 'handoff_2026-08-14_Lebanon-France-VFS-Beirut_40.csv');
  });

  it('says so when a batch spans several routes', () => {
    const name = exportFilename({ date: new Date(Date.UTC(2026, 7, 14)), routeLabel: null, count: 12 });
    assert.equal(name, 'handoff_2026-08-14_all-routes_12.csv');
  });
});

describe('template validation', () => {
  it('accepts the shipped default unchanged', () => {
    assert.deepEqual(validateTemplate(DEFAULT_EXPORT_TEMPLATE), DEFAULT_EXPORT_TEMPLATE);
  });

  it('refuses a template with no columns, or a column with no heading', () => {
    assert.throws(() => validateTemplate({ columns: [] }));
    assert.throws(() => validateTemplate({ columns: [{ header: '', source: 'firstName' }] }));
  });

  it('lets a column be added, renamed or left permanently empty', () => {
    const template = validateTemplate({
      columns: [
        { header: 'Given Name', source: 'firstName', transform: 'upper' },
        { header: 'reference', source: 'empty', transform: 'none' },
      ],
      includeBom: true,
      excelTextFormulas: false,
    });

    const row = lines(renderCsv([record], template))[1]!;
    assert.equal(lines(renderCsv([record], template))[0], '"Given Name","reference"');
    assert.equal(row, '"SALMA",""');
  });
});

/** A small RFC-4180 reader, so the tests parse the file the way a consumer would. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

describe('quoting helper', () => {
  it('quotes everything, so nothing depends on spotting the special cases', () => {
    assert.equal(quoteCsvValue('plain'), '"plain"');
    assert.equal(quoteCsvValue('with,comma'), '"with,comma"');
    assert.equal(quoteCsvValue('with"quote'), '"with""quote"');
    assert.equal(quoteCsvValue(''), '""');
  });
});
