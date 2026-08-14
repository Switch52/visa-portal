#!/usr/bin/env node
/**
 * Migration Phase 1 — profile the real sheets before any schema or importer exists.
 *
 * READ-ONLY over `private/`. It opens the exports, never writes to them, and emits a
 * report to `private/reports/` (gitignored, because the report necessarily quotes real
 * passport numbers so duplicates can be resolved by hand).
 *
 * Usage:  node scripts/profile-sheets.mjs [--in private] [--out private/reports]
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { parseCsv, isBlankRow } from './lib/csv.mjs';

// ---------------------------------------------------------------------------
// Config: what we know about the sheets, kept as data rather than buried in code.
// ---------------------------------------------------------------------------

/** Columns the agency sheets are expected to share. */
const CORE_COLUMNS = [
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

/** Columns present in some sheets that the portal deliberately does not model. */
const DROPPED_COLUMNS = [
  'Address Line 1',
  'Address Line 2',
  'City',
  'State / Province',
  'Postal Code',
];

/** Note patterns we believe carry structured meaning. Order matters: longest first. */
const NOTE_PATTERNS = [
  {
    id: 'hold_until',
    label: 'Hold until a date ("after <date>")',
    // AFTER / AFETER, then D/M or D\M, optionally with a year.
    regex: /\b(?:AFTER|AFETER|AFTR)\b\s*(\d{1,2})\s*[\/\\.-]\s*(\d{1,2})(?:\s*[\/\\.-]\s*(\d{2,4}))?/gi,
    target: 'holdUntil + status on_hold',
  },
  {
    id: 'application_type_single',
    label: 'Single-entry application type (misspelled)',
    regex: /\b(SINGEL|SENGEL|SNGEL|SINGLE)\b/gi,
    target: 'applicationType = single',
  },
  {
    id: 'cancelled',
    label: 'Cancelled application',
    regex: /\b(CANCEL|CANCELLED|CANCELED)\b/gi,
    target: 'status = cancelled',
  },
  {
    id: 'priority',
    label: 'Urgency marker (Arabic)',
    regex: /مهم\s*جدا\s*يتحجز/g,
    target: 'priority = urgent',
  },
];

const AR_RANGE = /[؀-ۿ]/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const trim = (s) => (s ?? '').trim();
const squash = (s) => trim(s).replace(/\s+/g, ' ');
const pct = (n, d) => (d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`);

/** Counts distinct values, preserving first-seen order for readability. */
function tally(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** "A38475533" -> "A99999999"; reveals passport-number shapes without inventing a regex. */
function shapeOf(value) {
  return value.replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9');
}

/** The normalization the portal will store alongside the original: upper, no space/dash. */
function normalizePassport(value) {
  return trim(value).toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Classify a date cell by literal shape. We never hand these to a permissive parser —
 * the point of this pass is to find out which format they are in, not to guess.
 */
function dateShape(value) {
  const v = trim(value);
  if (v === '') return 'blank';
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return 'D/M/YYYY or M/D/YYYY (slash, 4-digit year)';
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(v)) return 'D/M/YY (slash, 2-digit year)';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'YYYY-MM-DD (ISO)';
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(v)) return 'D-M-YYYY (dash)';
  if (/^\d{1,2}\\\d{1,2}\\\d{4}$/.test(v)) return 'D\\M\\YYYY (backslash)';
  return `other: ${v}`;
}

/** Strict DD/MM/YYYY parse. Returns null rather than a "best effort" date. */
function parseDdMmYyyy(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trim(value));
  if (!m) return null;
  const [, dd, mm, yyyy] = m.map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null; // e.g. 31/02/2030
  }
  return date;
}

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Parse a formatted money cell ("$4,698.00", "199,416.32 EGP", "1,010.00") into
 * integer minor units plus the formatting artefacts we had to strip, so the report can
 * show exactly which decorations exist in the source.
 */
function parseMoney(raw) {
  const value = trim(raw);
  if (value === '') return null;
  const artefacts = [];
  let s = value;
  if (s.includes('$')) artefacts.push('$ prefix');
  if (/\bEGP\b/i.test(s)) artefacts.push('EGP suffix');
  if (/\bUSD\b/i.test(s)) artefacts.push('USD suffix');
  if (s.includes(',')) artefacts.push('thousands separator');
  s = s.replace(/[$,]/g, '').replace(/\b(EGP|USD)\b/gi, '').trim();
  const negative = /^\(.*\)$/.test(s);
  if (negative) {
    artefacts.push('parenthesised negative');
    s = s.slice(1, -1);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, raw: value, artefacts };
  const minor = Math.round(Number(s) * 100) * (negative ? -1 : 1);
  return { ok: true, raw: value, minorUnits: minor, artefacts };
}

const money = (minor, currency) =>
  `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Agency passport sheets
// ---------------------------------------------------------------------------

function profileAgencySheet({ agency, file, rows }) {
  const header = rows[0].map(trim);
  const dataRows = rows.slice(1).filter((r) => !isBlankRow(r));

  const col = (name) => header.indexOf(name);
  const at = (row, name) => {
    const i = col(name);
    return i === -1 ? '' : trim(row[i] ?? '');
  };

  const unnamedColumns = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h === '')
    .map(({ i }) => ({
      index: i,
      filled: dataRows.filter((r) => trim(r[i] ?? '') !== '').length,
      values: tally(dataRows.map((r) => trim(r[i] ?? '')).filter((v) => v !== '')),
    }));

  const missingCore = CORE_COLUMNS.filter((c) => !header.includes(c));
  const droppedPresent = DROPPED_COLUMNS.filter((c) => header.includes(c));
  const indexColumn = header[0];

  // Junk rows: no passport number at all. Reported, never silently dropped.
  const junk = [];
  const records = [];
  dataRows.forEach((row, i) => {
    const sourceRow = i + 2; // 1-based, +1 for the header line
    const passport = at(row, 'Passport Number');
    if (passport === '') {
      junk.push({
        sourceRow,
        nonEmpty: header
          .map((h, ci) => [h || `(unnamed ${ci})`, trim(row[ci] ?? '')])
          .filter(([, v]) => v !== ''),
      });
      return;
    }
    records.push({ sourceRow, row });
  });

  // Blank rate per column, over non-junk records only.
  const blankRates = header.map((h, i) => ({
    column: h || `(unnamed ${i})`,
    blank: records.filter(({ row }) => trim(row[i] ?? '') === '').length,
  }));

  // The sheet's own index column — is it safe to use as a key or for traceability?
  const indexValues = records.map(({ sourceRow, row }) => ({ sourceRow, value: trim(row[0] ?? '') }));
  const indexCounts = new Map();
  for (const { value } of indexValues) indexCounts.set(value, (indexCounts.get(value) ?? 0) + 1);
  const indexIntegrity = {
    duplicated: [...indexCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([value]) => ({ value, rows: indexValues.filter((v) => v.value === value).map((v) => v.sourceRow) })),
    nonNumeric: indexValues.filter((v) => !/^\d+$/.test(v.value)),
    outOfOrder: indexValues.filter((v, i) => i > 0 && Number(v.value) <= Number(indexValues[i - 1].value)).length,
  };

  // Records that carry a passport number but are missing fields the export needs.
  const REQUIRED = ['First Name', 'Last Name', 'Nationality', 'Passport Expiry Date', 'Date of Birth', 'Gender'];
  const incomplete = records
    .map(({ sourceRow, row }) => ({
      sourceRow,
      passport: at(row, 'Passport Number'),
      missing: REQUIRED.filter((c) => at(row, c) === ''),
    }))
    .filter((r) => r.missing.length > 0);

  // Names
  const firstNames = records.map(({ row }) => at(row, 'First Name'));
  const lastNames = records.map(({ row }) => at(row, 'Last Name'));
  const multiTokenFirst = records
    .filter(({ row }) => at(row, 'First Name').split(/\s+/).length > 1)
    .map(({ sourceRow, row }) => ({
      sourceRow,
      firstName: at(row, 'First Name'),
      lastName: at(row, 'Last Name'),
    }));

  // Genders / nationalities
  const genders = tally(records.map(({ row }) => at(row, 'Gender')));
  const nationalities = tally(records.map(({ row }) => at(row, 'Nationality')));
  const addedValues = tally(records.map(({ row }) => at(row, 'Added?')));

  // Dates: shapes, ambiguity, strict parse, expiry check
  const dateColumns = ['Passport Expiry Date', 'Date of Birth'];
  const dateProfiles = dateColumns.map((column) => {
    const values = records.map(({ sourceRow, row }) => ({ sourceRow, value: at(row, column) }));
    const shapes = tally(values.map((v) => dateShape(v.value)));
    let firstGt12 = 0;
    let secondGt12 = 0;
    const unparseable = [];
    const parsed = [];
    for (const { sourceRow, value } of values) {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      if (m) {
        if (Number(m[1]) > 12) firstGt12 += 1;
        if (Number(m[2]) > 12) secondGt12 += 1;
      }
      const d = parseDdMmYyyy(value);
      if (!d) unparseable.push({ sourceRow, value });
      else parsed.push({ sourceRow, date: d });
    }
    return { column, shapes, firstGt12, secondGt12, unparseable, parsed };
  });

  const today = new Date();
  const expiryProfile = dateProfiles.find((d) => d.column === 'Passport Expiry Date');
  const expired = expiryProfile.parsed
    .filter(({ date }) => date < today)
    .map(({ sourceRow, date }) => ({ sourceRow, date: iso(date) }));
  const dobProfile = dateProfiles.find((d) => d.column === 'Date of Birth');
  const implausibleDob = dobProfile.parsed
    .filter(({ date }) => {
      const age = (today - date) / (365.25 * 24 * 3600 * 1000);
      return age < 0 || age > 110;
    })
    .map(({ sourceRow, date }) => ({ sourceRow, date: iso(date) }));

  // Passport numbers: shape census + normalization effects + within-sheet duplicates
  const passportShapes = tally(records.map(({ row }) => shapeOf(at(row, 'Passport Number'))));
  const lengths = tally(records.map(({ row }) => String(at(row, 'Passport Number').length)));
  const normalizationChanged = records
    .filter(({ row }) => {
      const original = at(row, 'Passport Number');
      return normalizePassport(original) !== original;
    })
    .map(({ sourceRow, row }) => ({
      sourceRow,
      original: at(row, 'Passport Number'),
      normalized: normalizePassport(at(row, 'Passport Number')),
    }));

  const byNormalized = new Map();
  for (const { sourceRow, row } of records) {
    const key = normalizePassport(at(row, 'Passport Number'));
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push({ sourceRow, original: at(row, 'Passport Number') });
  }
  const internalDuplicates = [...byNormalized.entries()]
    .filter(([, hits]) => hits.length > 1)
    .map(([key, hits]) => ({ normalized: key, hits }));

  // Notes: what is really structured data hiding in free text
  const noteAnalysis = records
    .map(({ sourceRow, row }) => {
      const parts = [at(row, 'Notes')];
      for (const u of unnamedColumns) parts.push(trim(row[u.index] ?? ''));
      const original = parts.filter((p) => p !== '').join(' | ');
      if (original === '') return null;

      const extracted = [];
      let residual = squash(original);
      for (const pattern of NOTE_PATTERNS) {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        const matches = [...original.matchAll(re)];
        if (matches.length === 0) continue;
        extracted.push({
          id: pattern.id,
          target: pattern.target,
          matched: matches.map((m) => m[0].trim()),
          ...(pattern.id === 'hold_until'
            ? { holdUntilParts: matches.map((m) => ({ day: m[1], month: m[2], year: m[3] ?? null })) }
            : {}),
        });
        residual = squash(residual.replace(re, ' '));
      }
      residual = squash(residual.replace(/^[|\s-]+|[|\s-]+$/g, ''));
      return {
        sourceRow,
        passport: at(row, 'Passport Number'),
        added: at(row, 'Added?'),
        original,
        extracted,
        residual,
        hasArabic: AR_RANGE.test(original),
      };
    })
    .filter(Boolean);

  const noteBuckets = tally(
    noteAnalysis.flatMap((n) => (n.extracted.length ? n.extracted.map((e) => e.id) : ['unrecognised (kept verbatim)'])),
  );
  const unrecognisedNotes = tally(noteAnalysis.filter((n) => n.residual !== '').map((n) => n.residual));

  // The Added? -> status mapping, refined by reading the note (per BUILD_PROMPT).
  // Where the two disagree — "Added? = Yes" beside a CANCEL or a hold — the row is
  // flagged rather than resolved, because that is a judgement call, not a parse.
  const conflicts = [];
  const statusPreview = records.map(({ sourceRow, row }) => {
    const rawAdded = at(row, 'Added?');
    const added = rawAdded.toLowerCase();
    const note = noteAnalysis.find((n) => n.sourceRow === sourceRow);
    const ids = new Set(note?.extracted.map((e) => e.id) ?? []);
    let status;
    if (ids.has('cancelled')) status = 'cancelled';
    else if (ids.has('hold_until')) status = 'on_hold';
    else if (added === 'yes') status = 'added';
    else status = 'submitted';
    if (added === 'yes' && (ids.has('cancelled') || ids.has('hold_until'))) {
      conflicts.push({
        sourceRow,
        passport: at(row, 'Passport Number'),
        added: rawAdded,
        note: note?.original ?? '',
        proposed: status,
        alternative: 'added',
      });
    }
    return { sourceRow, added: rawAdded, status };
  });

  const recordsWithNoNote = records.length - noteAnalysis.length;

  return {
    agency,
    file,
    header,
    indexColumn,
    missingCore,
    droppedPresent,
    unnamedColumns,
    counts: {
      lines: rows.length,
      dataRows: dataRows.length,
      records: records.length,
      junk: junk.length,
    },
    junk,
    blankRates,
    names: {
      splitIntoTwoFields: header.includes('First Name') && header.includes('Last Name'),
      blankFirst: firstNames.filter((v) => v === '').length,
      blankLast: lastNames.filter((v) => v === '').length,
      multiTokenFirst,
    },
    genders,
    nationalities,
    addedValues,
    dateProfiles,
    expired,
    implausibleDob,
    passports: { passportShapes, lengths, normalizationChanged, internalDuplicates },
    notes: { noteAnalysis, noteBuckets, unrecognisedNotes, recordsWithNoNote },
    indexIntegrity,
    incomplete,
    conflicts,
    statusPreview: tally(statusPreview.map((s) => s.status)),
    _records: records.map(({ sourceRow, row }) => ({
      sourceRow,
      normalized: normalizePassport(at(row, 'Passport Number')),
      original: at(row, 'Passport Number'),
      firstName: at(row, 'First Name'),
      lastName: at(row, 'Last Name'),
      added: at(row, 'Added?'),
      notes: at(row, 'Notes'),
    })),
  };
}

// ---------------------------------------------------------------------------
// Payments workbook — Client Tracker tab
// ---------------------------------------------------------------------------

function profileClientTracker({ file, rows }) {
  // Locate the header by content, never by row number.
  const headerIndex = rows.findIndex((r) => trim(r[0]) === 'Client' && r.some((c) => /Outstanding/i.test(c)));
  if (headerIndex === -1) {
    return { file, error: 'Could not locate a header row containing "Client" + "Outstanding".' };
  }
  const header = rows[headerIndex].map((c) => squash(c)); // header cells contain embedded newlines
  const rawHeader = rows[headerIndex];

  const idx = (re) => header.findIndex((h) => re.test(h));
  const cols = {
    client: 0,
    currency: idx(/Invoice Currency/i),
    owed: idx(/^Total Owed/i),
    owedEgp: idx(/Owed \(EGP\)/i),
    owedUsd: idx(/Owed \(USD\)/i),
    paidEgp: idx(/Paid \(EGP\)/i),
    paidUsd: idx(/Paid \(USD\)/i),
    outEgp: idx(/Outstanding \(EGP\)/i),
    outUsd: idx(/Outstanding \(USD\)/i),
    status: idx(/^Status$/i),
  };

  // Exchange rate block above the table.
  let rate = null;
  let rateUpdated = null;
  for (const row of rows.slice(0, headerIndex)) {
    const label = trim(row[0]);
    if (/Exchange Rate/i.test(label)) {
      const cell = row.find((c, i) => i > 0 && trim(c) !== '' && /^[\d.,]+$/.test(trim(c)));
      if (cell) rate = Number(trim(cell).replace(/,/g, ''));
    }
    if (/Rate last updated/i.test(label)) {
      const cell = row.find((c, i) => i > 0 && trim(c) !== '');
      if (cell) rateUpdated = trim(cell);
    }
  }

  const agencies = [];
  const skipped = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const name = trim(row[0]);
    if (name === '' || /^TOTALS?$/i.test(name)) {
      skipped.push({ sourceRow: i + 1, reason: name === '' ? 'blank client cell' : 'TOTALS row', name });
      continue;
    }
    const currency = trim(row[cols.currency]) || 'USD';
    agencies.push({
      sourceRow: i + 1,
      agency: name,
      currency,
      totalOwed: parseMoney(row[cols.owed]),
      paid: parseMoney(row[cols.paidUsd]),
      outstanding: parseMoney(row[cols.outUsd]),
      outstandingEgpDisplay: trim(row[cols.outEgp]),
      status: trim(row[cols.status]),
    });
  }

  // The TOTALS row is excluded from the data, but it is a useful cross-check.
  const totalsRow = rows.find((r) => /^TOTALS?$/i.test(trim(r[0])));
  const totals = totalsRow
    ? {
        owedUsd: parseMoney(totalsRow[cols.owedUsd]),
        paidUsd: parseMoney(totalsRow[cols.paidUsd]),
        outstandingUsd: parseMoney(totalsRow[cols.outUsd]),
      }
    : null;

  const sum = (pick) => agencies.reduce((acc, a) => acc + (pick(a)?.minorUnits ?? 0), 0);
  const computed = {
    owedUsd: sum((a) => a.totalOwed),
    paidUsd: sum((a) => a.paid),
    outstandingUsd: sum((a) => a.outstanding),
  };

  const artefacts = tally(
    agencies.flatMap((a) => [a.totalOwed, a.paid, a.outstanding].flatMap((m) => m?.artefacts ?? [])),
  );

  return {
    file,
    headerRow: headerIndex + 1,
    header,
    headerHasEmbeddedNewlines: rawHeader.some((c) => c.includes('\n')),
    rate,
    rateUpdated,
    agencies,
    skipped,
    totals,
    computed,
    artefacts,
    blankSpacerRows: rows.slice(headerIndex + 1).filter(isBlankRow).length,
  };
}

// ---------------------------------------------------------------------------
// Payments workbook — Payments Log tab
// ---------------------------------------------------------------------------

function profilePaymentsLog({ file, rows }) {
  const headerIndex = rows.findIndex(
    (r) => trim(r[0]) === 'Date' && r.some((c) => /Amount Paid/i.test(c)),
  );
  if (headerIndex === -1) {
    return { file, error: 'Could not locate a header row containing "Date" + "Amount Paid".' };
  }
  const header = rows[headerIndex].map(squash);
  const idx = (re) => header.findIndex((h) => re.test(h));
  const cols = {
    date: 0,
    client: idx(/^Client$/i),
    amount: idx(/Amount Paid/i),
    currency: idx(/Payment Currency/i),
    egp: idx(/Amount \(EGP\)/i),
    usd: idx(/Amount \(USD\)/i),
    notes: idx(/^Notes$/i),
  };

  const payments = [];
  let carriedDate = null;
  let blankDates = 0;
  const dateShapes = [];
  const unparseable = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const rawDate = trim(row[cols.date]);
    if (rawDate === '') blankDates += 1;
    else dateShapes.push(dateShape(rawDate));

    // THE dangerous one: blank date means "same as the row above".
    if (rawDate !== '') carriedDate = rawDate;
    const effectiveDate = carriedDate;

    const amount = parseMoney(row[cols.amount]);
    if (amount && !amount.ok) unparseable.push({ sourceRow: i + 1, raw: amount.raw });

    payments.push({
      sourceRow: i + 1,
      rawDate,
      effectiveDate,
      forwardFilled: rawDate === '',
      agency: trim(row[cols.client]),
      amount,
      currency: trim(row[cols.currency]) || null,
      egpDisplay: trim(row[cols.egp]),
      note: trim(row[cols.notes]),
    });
  }

  const missingDateEntirely = payments.filter((p) => p.effectiveDate === null);
  const currencies = tally(payments.map((p) => p.currency ?? '(blank)'));
  const byAgency = new Map();
  for (const p of payments) {
    const key = `${p.agency}::${p.currency ?? '(blank)'}`;
    byAgency.set(key, (byAgency.get(key) ?? 0) + (p.amount?.minorUnits ?? 0));
  }
  const totalsByAgency = [...byAgency.entries()]
    .map(([key, minor]) => {
      const [agency, currency] = key.split('::');
      return { agency, currency, minorUnits: minor };
    })
    .sort((a, b) => b.minorUnits - a.minorUnits);

  const artefacts = tally(payments.flatMap((p) => p.amount?.artefacts ?? []));
  const dates = payments.map((p) => p.effectiveDate).filter(Boolean).sort();

  return {
    file,
    headerRow: headerIndex + 1,
    header,
    counts: { payments: payments.length, blankDates, missingDateEntirely: missingDateEntirely.length },
    dateShapes: tally(dateShapes),
    dateRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    currencies,
    totalsByAgency,
    artefacts,
    unparseable,
    payments,
  };
}

// ---------------------------------------------------------------------------
// Cross-sheet duplicates — the reason the unique index exists
// ---------------------------------------------------------------------------

function crossSheetDuplicates(sheets) {
  const seen = new Map();
  for (const sheet of sheets) {
    for (const rec of sheet._records) {
      if (!seen.has(rec.normalized)) seen.set(rec.normalized, []);
      seen.get(rec.normalized).push({ agency: sheet.agency, ...rec });
    }
  }
  return [...seen.entries()]
    .filter(([, hits]) => new Set(hits.map((h) => h.agency)).size > 1)
    .map(([normalized, hits]) => ({ normalized, hits }));
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function table(headers, rows) {
  if (rows.length === 0) return '_none_\n';
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
    '',
  ].join('\n');
}

function renderMarkdown(report) {
  const out = [];
  const p = (...lines) => out.push(...lines);

  p(
    '# Migration Phase 1 — data profile',
    '',
    `Generated ${report.generatedAt} by \`scripts/profile-sheets.mjs\` (read-only).`,
    '',
    '> **This report is confidential.** It quotes real passport numbers so duplicates can be',
    '> resolved by hand. It lives in `private/`, which is gitignored — do not move it into the repo,',
    '> paste it into a ticket, or attach it to an email.',
    '',
    '## Files profiled',
    '',
    table(
      ['File', 'Bytes', 'Modified', 'SHA-256 (first 16)'],
      report.files.map((f) => [f.name, f.bytes, f.modified, f.sha]),
    ),
  );

  // --- agency sheets -------------------------------------------------------
  for (const s of report.sheets) {
    p(`## Agency sheet — ${s.agency}`, '', `Source: \`${s.file}\``, '');
    p(
      table(
        ['Measure', 'Value'],
        [
          ['Physical lines (incl. header)', s.counts.lines],
          ['Non-blank data rows', s.counts.dataRows],
          ['Usable records (have a passport number)', s.counts.records],
          ['Junk rows (no passport number)', s.counts.junk],
          ['Index column name', `\`${s.indexColumn}\``],
          ['Names split into two fields', s.names.splitIntoTwoFields ? 'yes' : 'NO — needs splitting'],
          ['Core columns missing', s.missingCore.length ? s.missingCore.join(', ') : 'none'],
          ['Address columns present (dropped on import)', s.droppedPresent.length ? s.droppedPresent.join(', ') : 'none'],
          ['Unnamed trailing columns', s.unnamedColumns.length],
        ],
      ),
    );

    p('**Columns, in file order**', '', '```', s.header.map((h, i) => `${i}: ${h || '(unnamed)'}`).join('\n'), '```', '');

    p('**Blank rate per column** (over usable records)', '');
    p(
      table(
        ['Column', 'Blank', 'Blank %'],
        s.blankRates.map((b) => [b.column, b.blank, pct(b.blank, s.counts.records)]),
      ),
    );

    p(
      `**Index column \`${s.indexColumn}\` integrity** — this decides whether it can be used for traceability.`,
      '',
      table(
        ['Check', 'Count', 'Detail'],
        [
          [
            'Duplicated index values',
            s.indexIntegrity.duplicated.length,
            s.indexIntegrity.duplicated.map((d) => `${d.value} on rows ${d.rows.join(' & ')}`).join('; ') || '—',
          ],
          [
            'Non-numeric index values',
            s.indexIntegrity.nonNumeric.length,
            s.indexIntegrity.nonNumeric.map((v) => `row ${v.sourceRow}: "${v.value}"`).join('; ') || '—',
          ],
          ['Index not strictly increasing at', s.indexIntegrity.outOfOrder, s.indexIntegrity.outOfOrder ? 'sequence breaks — do not treat as a key' : '—'],
        ],
      ),
    );

    p('**Records missing a field the export needs** (passport number present, something else absent)', '');
    p(
      table(
        ['Source row', 'Passport', 'Missing'],
        s.incomplete.map((r) => [r.sourceRow, r.passport, r.missing.join(', ')]),
      ),
    );

    if (s.unnamedColumns.length) {
      p('**Unnamed column contents** — these must not be discarded; they append to `notes`.', '');
      p(
        table(
          ['Column index', 'Filled rows', 'Values'],
          s.unnamedColumns.map((u) => [u.index, u.filled, u.values.map(([v, n]) => `"${v}" ×${n}`).join(', ')]),
        ),
      );
    }

    p('**Gender values found**', '', table(['Value', 'Count'], s.genders.map(([v, n]) => [v === '' ? '(blank)' : v, n])));
    p(
      '**Nationality values found** — free-text English names; every one needs an ISO alpha-3 mapping.',
      '',
      table(['Value', 'Count', 'Needs mapping'], s.nationalities.map(([v, n]) => [v === '' ? '(blank)' : v, n, 'yes'])),
    );
    p('**`Added?` values found**', '', table(['Value', 'Count'], s.addedValues.map(([v, n]) => [v === '' ? '(blank)' : v, n])));

    p('### Dates', '');
    for (const d of s.dateProfiles) {
      p(`**${d.column}**`, '');
      p(table(['Shape', 'Count'], d.shapes.map(([v, n]) => [v, n])));
      p(
        table(
          ['Ambiguity check', 'Count', 'Reading'],
          [
            ['First component > 12', d.firstGt12, d.firstGt12 > 0 ? 'proves day-first (DD/MM/YYYY)' : '—'],
            ['Second component > 12', d.secondGt12, d.secondGt12 > 0 ? 'would prove month-first' : '—'],
            ['Unparseable as DD/MM/YYYY', d.unparseable.length, d.unparseable.length ? 'needs a decision' : '—'],
          ],
        ),
      );
      if (d.unparseable.length) {
        p(table(['Source row', 'Value'], d.unparseable.map((u) => [u.sourceRow, u.value])));
      }
    }
    p(
      table(
        ['Date sanity check', 'Count', 'Rows'],
        [
          ['Passports already expired', s.expired.length, s.expired.map((e) => `${e.sourceRow} (${e.date})`).join(', ') || '—'],
          ['Implausible DOB (<0 or >110 yrs)', s.implausibleDob.length, s.implausibleDob.map((e) => `${e.sourceRow} (${e.date})`).join(', ') || '—'],
        ],
      ),
    );

    p('### Passport numbers', '');
    p('**Shapes** (`A` = letter, `9` = digit) — do not turn these into a rigid validation regex.', '');
    p(table(['Shape', 'Count'], s.passports.passportShapes.map(([v, n]) => [v, n])));
    p(table(['Length', 'Count'], s.passports.lengths.map(([v, n]) => [v, n])));
    p(
      table(
        ['Normalization', 'Count'],
        [['Values changed by normalize (upper/strip space+dash)', s.passports.normalizationChanged.length]],
      ),
    );
    if (s.passports.normalizationChanged.length) {
      p(table(['Source row', 'As typed', 'Normalized'], s.passports.normalizationChanged.map((c) => [c.sourceRow, c.original, c.normalized])));
    }
    p('**Duplicates within this sheet**', '');
    p(
      table(
        ['Normalized', 'Rows'],
        s.passports.internalDuplicates.map((d) => [d.normalized, d.hits.map((h) => h.sourceRow).join(', ')]),
      ),
    );

    p('### Notes — what is really structured data', '');
    p(table(['Pattern', 'Rows matched'], s.notes.noteBuckets.map(([v, n]) => [v, n])));
    p('**Residual text after extraction** — kept verbatim in `notes`, never discarded.', '');
    p(table(['Residual value', 'Count'], s.notes.unrecognisedNotes.map(([v, n]) => [v === '' ? '(nothing left)' : v, n])));

    p(
      table(
        ['Notes coverage', 'Count'],
        [
          ['Records with a note', s.notes.noteAnalysis.length],
          ['Records with no note at all', s.notes.recordsWithNoNote],
        ],
      ),
    );

    p('**Proposed status distribution** (`Added?` refined by reading the note)', '');
    p(table(['Status', 'Count'], s.statusPreview.map(([v, n]) => [v, n])));

    if (s.conflicts.length) {
      p(
        `**\`Added?\` and the note disagree on ${s.conflicts.length} row(s)** — your call, not the parser's.`,
        'The sheet says the passport was handed off, the note says it was cancelled or held.',
        '',
        table(
          ['Row', 'Passport', 'Added?', 'Note', 'Proposed status', 'Alternative'],
          s.conflicts.map((c) => [c.sourceRow, c.passport, c.added, c.note, c.proposed, c.alternative]),
        ),
      );
    }

    // Every transformed row is reported, but the ~290 plain "SINGEL -> single" rows are
    // collapsed to a row-number list; the ones carrying a judgement are shown in full.
    const transformed = s.notes.noteAnalysis.filter((n) => n.extracted.length > 0);
    const plain = transformed.filter(
      (n) => n.residual === '' && n.extracted.length === 1 && n.extracted[0].id === 'application_type_single',
    );
    const interesting = transformed.filter((n) => !plain.includes(n));

    p(
      '**Rows whose note we would transform** — check this interpretation before Phase 2.',
      '',
      `${plain.length} row(s) are the plain case (\`SINGEL\`/\`SENGEL\`/\`SNGEL\` → \`applicationType = single\`, nothing left over):`,
      '',
      plain.length ? `> rows ${plain.map((n) => n.sourceRow).join(', ')}` : '> _none_',
      '',
      `The remaining ${interesting.length} row(s) carry something beyond that:`,
      '',
    );
    p(
      table(
        ['Row', 'Passport', 'Added?', 'Original note', 'Extracted', 'Residual kept verbatim'],
        interesting.map((n) => [
          n.sourceRow,
          n.passport,
          n.added || '(blank)',
          n.original,
          n.extracted
            .map((e) =>
              e.id === 'hold_until'
                ? `${e.target} (${e.holdUntilParts.map((h) => `${h.day}/${h.month}${h.year ? `/${h.year}` : ''}`).join(', ')})`
                : e.target,
            )
            .join('; '),
          n.residual || '—',
        ]),
      ),
    );
    p(
      '**Rows with a note we recognised nothing in** — imported verbatim, exactly as written.',
      '',
      table(
        ['Row', 'Passport', 'Note'],
        s.notes.noteAnalysis.filter((n) => n.extracted.length === 0).map((n) => [n.sourceRow, n.passport, n.original]),
      ),
    );

    if (s.junk.length) {
      p('**Junk rows** — no passport number, skipped on import, reported here rather than dropped silently.', '');
      p(
        table(
          ['Source row', 'Non-empty cells'],
          s.junk.map((j) => [j.sourceRow, j.nonEmpty.map(([k, v]) => `${k}="${v}"`).join(', ')]),
        ),
      );
    }
  }

  // --- cross-sheet duplicates ---------------------------------------------
  p('## Cross-agency duplicate passports', '');
  if (report.crossDuplicates.length === 0) {
    p('None found. The unique index can be applied with no exceptions to resolve.', '');
  } else {
    p(
      `**${report.crossDuplicates.length} passport number(s) appear under more than one agency.**`,
      'Each needs your decision on which agency owns it; the other becomes a recorded rejected duplicate.',
      '',
      table(
        ['Normalized', 'Agency', 'Row', 'Name', 'Added?', 'Note'],
        report.crossDuplicates.flatMap((d) =>
          d.hits.map((h, i) => [
            i === 0 ? d.normalized : '↳',
            h.agency,
            h.sourceRow,
            `${h.firstName} ${h.lastName}`,
            h.added || '(blank)',
            h.notes || '—',
          ]),
        ),
      ),
    );
  }

  // --- payments ------------------------------------------------------------
  const t = report.tracker;
  p('## Payments workbook — Client Tracker tab', '', `Source: \`${t.file}\``, '');
  if (t.error) {
    p(`**Parse failed:** ${t.error}`, '');
  } else {
    p(
      table(
        ['Measure', 'Value'],
        [
          ['Header located at line', t.headerRow],
          ['Header cells contain embedded newlines', t.headerHasEmbeddedNewlines ? 'yes — parse by content, not position' : 'no'],
          ['Agency rows', t.agencies.length],
          ['Rows skipped (TOTALS / blank)', t.skipped.length],
          ['Blank spacer rows below the data block', t.blankSpacerRows],
          ['Exchange rate (EGP per 1 USD)', t.rate ?? '(not found)'],
          ['Rate last updated', t.rateUpdated ?? '(not found)'],
        ],
      ),
    );
    p('**Agency balances as the sheet states them** — the Phase 0 baseline to reconcile against.', '');
    p(
      table(
        ['Agency', 'Currency', 'Total owed', 'Paid', 'Outstanding', 'Status'],
        t.agencies.map((a) => [
          a.agency,
          a.currency,
          a.totalOwed?.ok ? money(a.totalOwed.minorUnits, a.currency) : '(unparsed)',
          a.paid?.ok ? money(a.paid.minorUnits, a.currency) : '(unparsed)',
          a.outstanding?.ok ? money(a.outstanding.minorUnits, a.currency) : '(unparsed)',
          a.status,
        ]),
      ),
    );
    p('**TOTALS row cross-check** — excluded from the data, used only to prove nothing was missed.', '');
    p(
      table(
        ['Figure', 'Sheet TOTALS row', 'Sum of agency rows', 'Agrees'],
        [
          ['Owed (USD)', t.totals?.owedUsd?.ok ? money(t.totals.owedUsd.minorUnits, 'USD') : '—', money(t.computed.owedUsd, 'USD'), t.totals?.owedUsd?.minorUnits === t.computed.owedUsd ? 'yes' : 'NO'],
          ['Paid (USD)', t.totals?.paidUsd?.ok ? money(t.totals.paidUsd.minorUnits, 'USD') : '—', money(t.computed.paidUsd, 'USD'), t.totals?.paidUsd?.minorUnits === t.computed.paidUsd ? 'yes' : 'NO'],
          ['Outstanding (USD)', t.totals?.outstandingUsd?.ok ? money(t.totals.outstandingUsd.minorUnits, 'USD') : '—', money(t.computed.outstandingUsd, 'USD'), t.totals?.outstandingUsd?.minorUnits === t.computed.outstandingUsd ? 'yes' : 'NO'],
        ],
      ),
    );
    p('**Money formatting artefacts to strip on import**', '', table(['Artefact', 'Occurrences'], t.artefacts.map(([v, n]) => [v, n])));
    p('**Rows deliberately not treated as agencies**', '', table(['Line', 'Value', 'Reason'], t.skipped.map((s) => [s.sourceRow, s.name || '(blank)', s.reason])));
  }

  const l = report.paymentsLog;
  p('## Payments workbook — Payments Log tab', '', `Source: \`${l.file}\``, '');
  if (l.error) {
    p(`**Parse failed:** ${l.error}`, '');
  } else {
    p(
      table(
        ['Measure', 'Value'],
        [
          ['Header located at line', l.headerRow],
          ['Payment rows', l.counts.payments],
          ['Rows with a blank Date cell', `${l.counts.blankDates} (${pct(l.counts.blankDates, l.counts.payments)})`],
          ['Rows with no date even after forward-fill', l.counts.missingDateEntirely],
          ['Date range (after forward-fill)', l.dateRange ? `${l.dateRange.first} → ${l.dateRange.last}` : '—'],
          ['Amount cells that failed to parse', l.unparseable.length],
        ],
      ),
    );
    p(
      '> **Forward-fill is mandatory.** A blank `Date` means "same date as the row above". Without it,',
      `> ${l.counts.blankDates} of ${l.counts.payments} payments import with a null date and the ledger stops being traceable.`,
      '',
    );
    p('**Date shapes in the non-blank cells**', '', table(['Shape', 'Count'], l.dateShapes.map(([v, n]) => [v, n])));
    p('**Currencies**', '', table(['Currency', 'Count'], l.currencies.map(([v, n]) => [v, n])));
    p('**Totals per agency per currency** (Phase 0 baseline)', '');
    p(table(['Agency', 'Currency', 'Total paid'], l.totalsByAgency.map((t2) => [t2.agency, t2.currency, money(t2.minorUnits, t2.currency)])));
    p('**Money formatting artefacts to strip on import**', '', table(['Artefact', 'Occurrences'], l.artefacts.map(([v, n]) => [v, n])));
    p('**Every payment row, with the date we would assign**', '');
    p(
      table(
        ['Row', 'Date cell', 'Date used', 'Forward-filled', 'Agency', 'Amount', 'Note'],
        l.payments.map((pm) => [
          pm.sourceRow,
          pm.rawDate || '(blank)',
          pm.effectiveDate ?? '(none)',
          pm.forwardFilled ? 'yes' : '',
          pm.agency,
          pm.amount?.ok ? money(pm.amount.minorUnits, pm.currency ?? '?') : pm.amount?.raw ?? '—',
          pm.note || '',
        ]),
      ),
    );
  }

  // --- reconciliation ------------------------------------------------------
  p('## Phase 0 baseline — reconcile the Payments Log against the Client Tracker', '');
  if (!t.error && !l.error) {
    const paidByAgency = new Map();
    for (const row of l.totalsByAgency) paidByAgency.set(`${row.agency}::${row.currency}`, row.minorUnits);
    p(
      table(
        ['Agency', 'Currency', 'Tracker says paid', 'Payments Log sums to', 'Difference'],
        t.agencies.map((a) => {
          const logged = paidByAgency.get(`${a.agency}::${a.currency}`) ?? 0;
          const stated = a.paid?.minorUnits ?? 0;
          return [
            a.agency,
            a.currency,
            money(stated, a.currency),
            money(logged, a.currency),
            stated === logged ? '—' : money(logged - stated, a.currency),
          ];
        }),
      ),
    );
    p(
      'Agencies that appear in one source and not the other:',
      '',
      table(
        ['Agency', 'In Client Tracker', 'In Payments Log'],
        [...new Set([...t.agencies.map((a) => a.agency), ...l.totalsByAgency.map((x) => x.agency)])].map((name) => [
          name,
          t.agencies.some((a) => a.agency === name) ? 'yes' : 'NO',
          l.totalsByAgency.some((x) => x.agency === name) ? 'yes' : 'NO',
        ]),
      ),
    );
  }

  p(
    '## What this profile settles, and what it does not',
    '',
    '**Settled by the data above** — carry these into the schema and the Phase 2 mapping config:',
    '',
    '- Agency sheets do not share a column set, so the column mapping must be per sheet.',
    '- Names arrive already split; no name-splitting logic is needed or wanted.',
    '- Dates are day-first and must be parsed strictly, never by a permissive parser.',
    '- Nationality is a free-text English country name and needs an explicit name → ISO alpha-3 table;',
    '  an unmapped value stops the import rather than guessing.',
    '- Passport numbers have several shapes; validate loosely (charset and length) only.',
    '- `notes` is carrying `applicationType`, `holdUntil`, `priority` and a cancellation status.',
    '- The Payments Log `Date` column is sparse and needs forward-fill.',
    '',
    '**Still needs your decision** — see the questions raised alongside this report.',
    '',
  );

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function main() {
  const inDir = resolve(argValue('--in', 'private'));
  const outDir = resolve(argValue('--out', join(inDir, 'reports')));

  const files = readdirSync(inDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((name) => {
      const path = join(inDir, name);
      const buf = readFileSync(path);
      return {
        name,
        path,
        bytes: buf.length,
        modified: statSync(path).mtime.toISOString().slice(0, 19).replace('T', ' '),
        sha: sha256(buf),
        rows: parseCsv(buf.toString('utf8')),
      };
    });

  if (files.length === 0) {
    console.error(`No CSV files found in ${inDir}. Export the sheets there first (it is gitignored).`);
    process.exit(1);
  }

  const agencyFiles = files.filter((f) => /client-details/i.test(f.name));
  const trackerFile = files.find((f) => /client tracker/i.test(f.name));
  const logFile = files.find((f) => /payments log/i.test(f.name));

  const sheets = agencyFiles.map((f) =>
    profileAgencySheet({
      agency: basename(f.name).split('-')[0].toLowerCase(),
      file: f.name,
      rows: f.rows,
    }),
  );

  const report = {
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
    files: files.map(({ name, bytes, modified, sha }) => ({ name, bytes, modified, sha })),
    sheets,
    crossDuplicates: crossSheetDuplicates(sheets),
    tracker: trackerFile
      ? profileClientTracker({ file: trackerFile.name, rows: trackerFile.rows })
      : { file: '(missing)', error: 'No "Client Tracker" CSV found.' },
    paymentsLog: logFile
      ? profilePaymentsLog({ file: logFile.name, rows: logFile.rows })
      : { file: '(missing)', error: 'No "Payments Log" CSV found.' },
  };

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const mdPath = join(outDir, `profile-${stamp}.md`);
  const jsonPath = join(outDir, `profile-${stamp}.json`);

  writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  // Drop the bulky per-record arrays from the JSON companion; keep it for Phase 2 tooling.
  writeFileSync(
    jsonPath,
    JSON.stringify(report, (key, value) => (key === '_records' ? undefined : value), 2),
    'utf8',
  );

  // Console summary only — never print passport numbers or names to a terminal/CI log.
  console.log(`Profiled ${files.length} file(s) from ${inDir}`);
  for (const s of sheets) {
    console.log(
      `  ${s.agency.padEnd(8)} ${String(s.counts.records).padStart(4)} records, ` +
        `${s.counts.junk} junk rows, ${s.passports.internalDuplicates.length} internal duplicates`,
    );
  }
  console.log(`  cross-agency duplicate passport numbers: ${report.crossDuplicates.length}`);
  if (!report.paymentsLog.error) {
    console.log(
      `  payments: ${report.paymentsLog.counts.payments} rows, ` +
        `${report.paymentsLog.counts.blankDates} needing forward-filled dates`,
    );
  }
  console.log(`\nReport:  ${mdPath}\nJSON:    ${jsonPath}`);
}

main();
