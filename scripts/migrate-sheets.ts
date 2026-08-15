/**
 * Migration phases 3 to 5: import the Google Sheets into the portal.
 *
 *   npm run migrate-sheets                 dry run into a throwaway scratch database
 *   npm run migrate-sheets -- --commit     the real thing, against MONGODB_URI
 *
 * **The dry run never touches the real database.** It starts its own MongoDB, applies every
 * migration to it, imports into that, reports, and throws it away. There is no flag that
 * makes a dry run write somewhere real, because the whole point of a dry run is that it
 * cannot.
 *
 * Two decisions from the runbook are built in:
 *
 *   - **Live work first.** Nothing here is marked `booked`: the sheets record the handoff
 *     (`Added?`) and cannot say whether an appointment was confirmed. Booked status arrives
 *     later, from importing a real booking file.
 *   - **Balances migrate as an opening balance**, one dated line per agency per currency,
 *     rather than a reconstructed history the old sheets cannot actually support.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ObjectId, type Db } from 'mongodb';

import { parseCsv } from './lib/csv.mjs';
import { transformSheet, findCrossAgencyDuplicates, type SheetMapping, type TransformResult } from '@/lib/migration/transform';
import { parseMoneyInput, formatMoney } from '@/lib/money';
import { formatDateOnly } from '@/lib/dates';

const ROOT = process.cwd();
const MAPPINGS_DIR = join(ROOT, 'sheet-mappings');
const PRIVATE_DIR = join(ROOT, 'private');
const REPORTS_DIR = join(PRIVATE_DIR, 'reports');

const COMMIT = process.argv.includes('--commit');
const CORRECTIONS = argValue('--corrections') ?? join(PRIVATE_DIR, 'corrections.json');
const CUTOVER = argValue('--cutover') ?? formatDateOnly(new Date());
const CENTER = argValue('--center') ?? 'Greece Cairo';
const FEE = argValue('--fee') ?? '60';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

interface Corrections {
  /** Normalized passport number → the agency key that keeps it. */
  duplicateOwners?: Record<string, string>;
  /**
   * Passports left out of the migration on purpose, with the reason.
   *
   * Different from an undecided duplicate: this is a decision — leave it out for now — and
   * the report stops asking about it, while still listing what was excluded and why so it
   * never quietly disappears.
   */
  excludedPassports?: Record<string, string>;
  /** `<agency>:<row>` → field overrides for that row. */
  rows?: Record<string, Record<string, string>>;
}

function loadCorrections(): Corrections {
  if (!existsSync(CORRECTIONS)) return {};
  // Corrections live in their own file: the original sheets stay untouched, so provenance
  // survives and a re-run can always start from the same place.
  return JSON.parse(readFileSync(CORRECTIONS, 'utf8')) as Corrections;
}

function loadMappings(): SheetMapping[] {
  return readdirSync(MAPPINGS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(MAPPINGS_DIR, file), 'utf8')) as SheetMapping);
}

function readSheet(mapping: SheetMapping): { header: string[]; rows: string[][] } {
  const path = join(PRIVATE_DIR, mapping.file);
  if (!existsSync(path)) throw new Error(`${mapping.file} is not in private/. Export it there first.`);

  const grid = parseCsv(readFileSync(path, 'utf8'));
  const header = (grid[0] ?? []).map((value: string) => value.trim());
  return { header, rows: grid.slice(1) };
}

// ---------------------------------------------------------------------------
// The payments workbook: opening balances, and the totals to reconcile against
// ---------------------------------------------------------------------------

interface AgencyBalanceRow {
  agency: string;
  currency: string;
  owedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  status: string;
}

function readClientTracker(): { rows: AgencyBalanceRow[]; rate: number | null; rateUpdated: string | null } {
  const path = join(PRIVATE_DIR, 'Client Tracker-Table 1.csv');
  if (!existsSync(path)) return { rows: [], rate: null, rateUpdated: null };

  const grid = parseCsv(readFileSync(path, 'utf8'));
  const headerIndex = grid.findIndex(
    (row: string[]) => row[0]?.trim() === 'Client' && row.some((cell: string) => /Outstanding/i.test(cell)),
  );
  if (headerIndex === -1) return { rows: [], rate: null, rateUpdated: null };

  const header = grid[headerIndex].map((cell: string) => cell.replace(/\s+/g, ' ').trim());
  const at = (re: RegExp) => header.findIndex((cell: string) => re.test(cell));
  const columns = {
    currency: at(/Invoice Currency/i),
    owed: at(/^Total Owed/i),
    paid: at(/Paid \(USD\)/i),
    outstanding: at(/Outstanding \(USD\)/i),
    status: at(/^Status$/i),
  };

  let rate: number | null = null;
  let rateUpdated: string | null = null;
  for (const row of grid.slice(0, headerIndex)) {
    if (/Exchange Rate/i.test(row[0] ?? '')) {
      const value = row.find((cell: string, index: number) => index > 0 && /^[\d.,]+$/.test(cell.trim()));
      if (value) rate = Number(value.replace(/,/g, ''));
    }
    if (/Rate last updated/i.test(row[0] ?? '')) {
      const value = row.find((cell: string, index: number) => index > 0 && cell.trim() !== '');
      if (value) rateUpdated = value.trim();
    }
  }

  const money = (value: string, currency: string): number => {
    const cleaned = (value ?? '').replace(/[$,]/g, '').replace(/\b(EGP|USD)\b/gi, '').trim();
    if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return 0;
    return parseMoneyInput(cleaned, currency).amountMinor;
  };

  const rows: AgencyBalanceRow[] = [];
  for (const row of grid.slice(headerIndex + 1)) {
    const agency = (row[0] ?? '').trim();
    // The TOTALS row is a check, never an agency.
    if (agency === '' || /^TOTALS?$/i.test(agency)) continue;

    const currency = (row[columns.currency] ?? 'USD').trim() || 'USD';
    rows.push({
      agency: agency.toLowerCase(),
      currency,
      owedMinor: money(row[columns.owed], currency),
      paidMinor: money(row[columns.paid], currency),
      outstandingMinor: money(row[columns.outstanding], currency),
      status: (row[columns.status] ?? '').trim(),
    });
  }

  return { rows, rate, rateUpdated };
}

// ---------------------------------------------------------------------------
// The import itself
// ---------------------------------------------------------------------------

interface SheetOutcome {
  mapping: SheetMapping;
  transform: TransformResult;
  imported: number;
  blocked: { sourceRow: number; passportNumber: string; reason: string }[];
  statusCounts: Record<string, number>;
}

async function main(): Promise<void> {
  const mappings = loadMappings();
  const corrections = loadCorrections();
  const tracker = readClientTracker();

  console.log(`${COMMIT ? 'COMMITTING' : 'Dry run'} — ${mappings.length} sheet(s), cutover ${CUTOVER}`);
  if (Object.keys(corrections.duplicateOwners ?? {}).length > 0) {
    console.log(`Using ${Object.keys(corrections.duplicateOwners!).length} duplicate decision(s) from ${CORRECTIONS}`);
  }

  // --- read and transform, before anything touches a database ---------------------
  const transformed = mappings.map((mapping) => {
    const { header, rows } = readSheet(mapping);
    return {
      mapping,
      transform: transformSheet(mapping, header, rows, {
        corrections: corrections.rows,
        duplicateOwners: corrections.duplicateOwners,
      }),
    };
  });

  const crossDuplicates = findCrossAgencyDuplicates(
    transformed.map((entry) => ({ agency: entry.mapping.agency, rows: entry.transform.rows })),
  );

  // A duplicate with no decision recorded is held back from both agencies rather than
  // being handed to whichever sheet happened to be read first. One that has been
  // deliberately excluded is also held back, but is not an open question.
  const owners = corrections.duplicateOwners ?? {};
  const excluded = corrections.excludedPassports ?? {};
  const undecided = crossDuplicates.filter(
    (duplicate) => !owners[duplicate.normalized] && !excluded[duplicate.normalized],
  );
  const heldBack = new Set([...undecided.map((duplicate) => duplicate.normalized), ...Object.keys(excluded)]);

  // --- open a database ------------------------------------------------------------
  let stopScratch: (() => Promise<void>) | null = null;

  if (COMMIT) {
    if (!process.env.MONGODB_URI) throw new Error('--commit needs MONGODB_URI set.');
    console.log(`Committing into ${process.env.MONGODB_DB ?? 'visa_portal'} — this writes for real.`);
  } else {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB = 'visa_portal_dryrun';
    stopScratch = async () => {
      await replSet.stop();
    };
    console.log('Scratch database started. Nothing here can reach the real one.');
  }

  const { getMongoClient } = await import('@/lib/mongodb');
  const client = await getMongoClient();
  const db = client.db(process.env.MONGODB_DB);

  // Every migration, in order, exactly as `npm run migrate` applies them.
  const migrationFiles = [
    '001_initial_collections',
    '002_bookings_and_charges',
    '003_payments_and_ledger',
    '004_family_applications',
  ];
  for (const file of migrationFiles) {
    const migration = (await import(`../migrations/${file}`)) as { up: (database: Db) => Promise<void> };
    await migration.up(db);
  }

  const dal = await import('@/lib/dal');
  const { systemActor } = await import('@/lib/dal/actor');
  const { users } = await import('@/lib/db/collections');
  const actor = systemActor();

  // An administrator, so the route and the agencies have an actor behind them.
  const userCollection = await users();
  const existingAdmin = await userCollection.findOne({ role: 'admin' });
  const adminId = existingAdmin?._id ?? new ObjectId();
  if (!existingAdmin) {
    const now = new Date();
    await userCollection.insertOne({
      _id: adminId,
      name: 'Migration',
      email: 'migration@localhost',
      emailNormalized: 'migration@localhost',
      role: 'admin',
      agencyId: null,
      active: false,
      createdAt: now,
      updatedAt: now,
    } as never);
  }
  const { adminActor } = await import('@/lib/dal/actor');
  const admin = adminActor(adminId);

  // --- the route everything is filed against --------------------------------------
  const fee = parseMoneyInput(FEE, 'USD');
  let routeId: ObjectId;
  const existingRoutes = await dal.listRoutes(admin);
  const match = existingRoutes.find((route) => route.appointmentCenter.toLowerCase() === CENTER.toLowerCase());
  if (match) {
    routeId = new ObjectId(match.id);
  } else {
    const route = await dal.createRoute(admin, {
      originCountry: 'EGY',
      destinationCountry: 'GRC',
      appointmentCenter: CENTER,
      feeMinor: fee.amountMinor,
      feeCurrency: fee.currency,
      active: true,
    });
    routeId = new ObjectId(route.id);
  }

  // --- agencies: every one on the payments sheet, not only those with passports ----
  const agencyNames = new Map<string, string>();
  for (const mapping of mappings) agencyNames.set(mapping.agency, mapping.agencyName);
  for (const row of tracker.rows) {
    if (!agencyNames.has(row.agency)) {
      agencyNames.set(row.agency, row.agency.charAt(0).toUpperCase() + row.agency.slice(1));
    }
  }

  const agencyIds = new Map<string, ObjectId>();
  for (const [key, name] of agencyNames) {
    const existing = (await dal.listAgencies(admin)).find(
      (agency) => agency.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      agencyIds.set(key, new ObjectId(existing.id));
      continue;
    }
    const created = await dal.createAgency(admin, { name, defaultCurrency: 'USD' });
    agencyIds.set(key, new ObjectId(created.id));
  }

  // --- passports -------------------------------------------------------------------
  const outcomes: SheetOutcome[] = [];

  for (const { mapping, transform } of transformed) {
    const agencyId = agencyIds.get(mapping.agency)!;
    const blocked: SheetOutcome['blocked'] = [];
    const statusCounts: Record<string, number> = {};
    let imported = 0;

    for (const row of transform.rows) {
      if (excluded[row.normalized]) {
        blocked.push({
          sourceRow: row.sourceRow,
          passportNumber: row.passportNumber,
          reason: `Left out on purpose: ${excluded[row.normalized]}`,
        });
        continue;
      }
      if (heldBack.has(row.normalized)) {
        blocked.push({
          sourceRow: row.sourceRow,
          passportNumber: row.passportNumber,
          reason: 'Held back: this number appears under another agency too, and no owner has been decided',
        });
        continue;
      }
      if (owners[row.normalized] && owners[row.normalized] !== mapping.agency) {
        blocked.push({
          sourceRow: row.sourceRow,
          passportNumber: row.passportNumber,
          reason: `Recorded as a rejected duplicate: ${owners[row.normalized]} owns this passport`,
        });
        continue;
      }

      try {
        const created = await dal.createPassport(
          actor,
          { ...row.input, routeId: routeId.toHexString() },
          {
            agencyId,
            source: { file: mapping.file, sheet: mapping.sheet, rowNumber: row.sourceRow, raw: row.raw },
          },
        );

        // The sheets cannot say whether something was booked, so nothing here becomes
        // `booked`. `Added?` is the handoff, and that is all it means.
        if (row.status !== 'submitted') {
          const id = new ObjectId(created.id);
          if (row.status === 'added') {
            await dal.changePassportStatus(admin, id, 'ready', { note: 'Migrated from the sheet' });
            await dal.changePassportStatus(admin, id, 'added', { note: `Added? = Yes in ${mapping.file}` });
          } else if (row.status === 'cancelled') {
            await dal.changePassportStatus(admin, id, 'cancelled', { note: 'CANCEL in the sheet notes' });
          }
          // `on_hold` is already the status a row with a hold date is created in.
        }

        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
        imported += 1;
      } catch (error) {
        blocked.push({
          sourceRow: row.sourceRow,
          passportNumber: row.passportNumber,
          reason: error instanceof Error ? error.message : 'Could not import this row',
        });
      }
    }

    outcomes.push({ mapping, transform, imported, blocked, statusCounts });
  }

  // --- opening balances -------------------------------------------------------------
  const openingBalances: { agency: string; currency: string; amountMinor: number }[] = [];
  for (const row of tracker.rows) {
    if (row.outstandingMinor === 0) continue;
    const agencyId = agencyIds.get(row.agency);
    if (!agencyId) continue;

    await dal.recordOpeningBalance(admin, {
      agencyId: agencyId.toHexString(),
      amountMinor: row.outstandingMinor,
      currency: row.currency,
      description: `Opening balance at cutover, from the payments sheet (${row.status || 'no status'})`,
      at: CUTOVER,
    });
    openingBalances.push({ agency: row.agency, currency: row.currency, amountMinor: row.outstandingMinor });
  }

  // --- reconcile ---------------------------------------------------------------------
  const balances = await dal.getBalanceOverview(admin);
  const report = renderReport({
    outcomes,
    crossDuplicates,
    undecided,
    decisions: {
      ...Object.fromEntries(Object.entries(owners).map(([number, agency]) => [number, `kept by ${agency}`])),
      ...Object.fromEntries(Object.entries(excluded).map(([number, reason]) => [number, `left out — ${reason}`])),
    },
    tracker,
    openingBalances,
    balances,
    agencyNames,
    routeLabel: `Egypt → Greece · ${CENTER}`,
    fee: formatMoney(fee),
  });

  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = formatDateOnly(new Date());
  const path = join(REPORTS_DIR, `migration-${COMMIT ? 'commit' : 'dry-run'}-${stamp}.md`);
  writeFileSync(path, report, 'utf8');

  // Console output carries counts only — never a name or a passport number.
  console.log('');
  for (const outcome of outcomes) {
    console.log(
      `  ${outcome.mapping.agency.padEnd(8)} ${String(outcome.imported).padStart(4)} imported · ` +
        `${outcome.transform.rejected.length} rejected · ${outcome.transform.junk.length} junk · ` +
        `${outcome.blocked.length} held back`,
    );
  }
  console.log(`  opening balances: ${openingBalances.length}`);
  console.log(`  cross-agency duplicates needing a decision: ${undecided.length}`);
  console.log(`\nReport: ${path}`);

  await client.close();
  await stopScratch?.();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function table(headers: string[], rows: (string | number)[][]): string {
  if (rows.length === 0) return '_none_\n';
  const escape = (value: string | number) => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
    '',
  ].join('\n');
}

function renderReport(data: {
  outcomes: SheetOutcome[];
  crossDuplicates: ReturnType<typeof findCrossAgencyDuplicates>;
  undecided: ReturnType<typeof findCrossAgencyDuplicates>;
  /** Normalized number → what was decided about it, for the ones that are settled. */
  decisions: Record<string, string>;
  tracker: ReturnType<typeof readClientTracker>;
  openingBalances: { agency: string; currency: string; amountMinor: number }[];
  balances: Awaited<ReturnType<typeof import('@/lib/dal').getBalanceOverview>>;
  agencyNames: Map<string, string>;
  routeLabel: string;
  fee: string;
}): string {
  const out: string[] = [];
  const p = (...lines: string[]) => out.push(...lines);

  p(
    `# Migration ${COMMIT ? 'commit' : 'dry run'}`,
    '',
    `Run ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · cutover ${CUTOVER}`,
    `Route: ${data.routeLabel} at ${data.fee}`,
    '',
    '> **Confidential.** This report quotes real passport numbers so exceptions can be resolved.',
    '> It lives in `private/`, which is gitignored.',
    '',
    COMMIT
      ? '**This was a real import.** Check the reconciliation at the bottom before anyone logs in.'
      : '**Nothing was written to the real database.** This ran against a throwaway MongoDB that was ' +
        'started for the run and destroyed at the end.',
    '',
    '## What came across',
    '',
    table(
      ['Agency', 'Rows in sheet', 'Imported', 'Rejected', 'Junk rows', 'Held back'],
      data.outcomes.map((outcome) => [
        outcome.mapping.agencyName,
        outcome.transform.rows.length + outcome.transform.rejected.length + outcome.transform.junk.length,
        outcome.imported,
        outcome.transform.rejected.length,
        outcome.transform.junk.length,
        outcome.blocked.length,
      ]),
    ),
    '### Status each row landed in',
    '',
    table(
      ['Agency', ...['submitted', 'added', 'on_hold', 'cancelled']],
      data.outcomes.map((outcome) => [
        outcome.mapping.agencyName,
        outcome.statusCounts.submitted ?? 0,
        outcome.statusCounts.added ?? 0,
        outcome.statusCounts.on_hold ?? 0,
        outcome.statusCounts.cancelled ?? 0,
      ]),
    ),
    'Nothing is `booked`. The sheets record the handoff and cannot say whether an appointment',
    'was confirmed — that arrives later, from importing a real booking file.',
    '',
  );

  // --- exceptions ---------------------------------------------------------------
  p('## Exceptions to resolve', '');

  p(`### Cross-agency duplicates (${data.crossDuplicates.length})`, '');
  if (data.crossDuplicates.length === 0) {
    p('None.', '');
  } else if (data.undecided.length === 0) {
    p(
      `All ${data.crossDuplicates.length} have a decision on file — nothing here is waiting on you.`,
      '',
      table(
        ['Passport', 'Appears under', 'Decision'],
        data.crossDuplicates.map((duplicate) => [
          duplicate.normalized,
          duplicate.occurrences
            .map((occurrence) => `${data.agencyNames.get(occurrence.agency) ?? occurrence.agency} row ${occurrence.sourceRow}`)
            .join(', '),
          data.decisions[duplicate.normalized] ?? 'excluded',
        ]),
      ),
      'They are out of the portal entirely, so the unique index stays absolute and neither',
      'agency has a passport the other also has. Revisit by editing `private/corrections.json`',
      'and re-running — nothing about this is permanent.',
      '',
    );
  } else {
    p(
      'The same passport under more than one agency. **Neither copy was imported**: pick who owns',
      'each in the corrections file and re-run, and the other is recorded as a rejected duplicate.',
      '',
      table(
        ['Passport', 'Agency', 'Sheet row', 'Status in sheet', 'Decision'],
        data.crossDuplicates.flatMap((duplicate) =>
          duplicate.occurrences.map((occurrence, index) => [
            index === 0 ? duplicate.normalized : '↳',
            data.agencyNames.get(occurrence.agency) ?? occurrence.agency,
            occurrence.sourceRow,
            occurrence.status,
            index === 0 ? (data.undecided.some((entry) => entry.normalized === duplicate.normalized) ? 'needed' : 'made') : '',
          ]),
        ),
      ),
      '```json',
      '// private/corrections.json',
      JSON.stringify(
        {
          duplicateOwners: Object.fromEntries(
            data.crossDuplicates.map((duplicate) => [duplicate.normalized, duplicate.occurrences[0]!.agency]),
          ),
        },
        null,
        2,
      ),
      '```',
      '',
    );
  }

  for (const outcome of data.outcomes) {
    if (outcome.transform.rejected.length === 0 && outcome.transform.junk.length === 0) continue;

    p(`### ${outcome.mapping.agencyName} — rows that did not import`, '');
    if (outcome.transform.rejected.length > 0) {
      p(
        table(
          ['Row', 'Passport', 'Why'],
          outcome.transform.rejected.map((row) => [row.sourceRow, row.passportNumber, row.reasons.join('; ')]),
        ),
      );
      p(
        'Fix these in `private/corrections.json` rather than in the sheet, so the original stays',
        'untouched and provenance survives:',
        '',
        '```json',
        JSON.stringify(
          {
            rows: Object.fromEntries(
              outcome.transform.rejected
                .slice(0, 3)
                .map((row) => [`${outcome.mapping.agency}:${row.sourceRow}`, { gender: 'Female' }]),
            ),
          },
          null,
          2,
        ),
        '```',
        '',
      );
    }
    if (outcome.transform.junk.length > 0) {
      p(
        `**${outcome.transform.junk.length} junk row(s)** — no passport number, skipped rather than`,
        'silently dropped. These are leftovers from editing:',
        '',
        table(
          ['Row', 'What was in it'],
          outcome.transform.junk.map((row) => [
            row.sourceRow,
            Object.entries(row.nonEmpty)
              .map(([key, value]) => `${key}="${value}"`)
              .join(', '),
          ]),
        ),
      );
    }
  }

  // --- what the notes became -----------------------------------------------------
  p('## What the notes column was read as', '', 'Check this interpretation before committing.', '');
  for (const outcome of data.outcomes) {
    const interesting = outcome.transform.rows.filter(
      (row) => row.extracted.length > 1 || row.residualNote !== '' || row.extracted.some((entry) => !entry.includes('single')),
    );
    p(`**${outcome.mapping.agencyName}** — ${interesting.length} row(s) beyond a plain "single":`, '');
    p(
      table(
        ['Row', 'Passport', 'Read as', 'Kept in notes'],
        interesting.map((row) => [
          row.sourceRow,
          row.passportNumber,
          row.extracted.join('; ') || '—',
          row.residualNote || '—',
        ]),
      ),
    );
  }

  // --- balances ------------------------------------------------------------------
  p(
    '## Opening balances',
    '',
    'One dated line per agency per currency, rather than a reconstructed history the sheets',
    'cannot support. Everything after cutover is generated from real bookings.',
    '',
    table(
      ['Agency', 'Currency', 'Opening balance'],
      data.openingBalances.map((balance) => [
        data.agencyNames.get(balance.agency) ?? balance.agency,
        balance.currency,
        formatMoney({ amountMinor: balance.amountMinor, currency: balance.currency }),
      ]),
    ),
  );

  // --- reconciliation ------------------------------------------------------------
  p(
    '## Reconciliation',
    '',
    'The sheet on the left, the portal on the right. **Sign off on this before anyone logs in.**',
    '',
    table(
      ['Agency', 'Sheet says outstanding', 'Portal shows', 'Agrees'],
      data.tracker.rows.map((row) => {
        const agencyName = data.agencyNames.get(row.agency) ?? row.agency;
        const portal = data.balances.rows.find((entry) => entry.agencyName === agencyName);
        const outstanding = portal?.balances.find((balance) => balance.currency === row.currency)?.outstandingMinor ?? 0;
        return [
          agencyName,
          formatMoney({ amountMinor: row.outstandingMinor, currency: row.currency }),
          formatMoney({ amountMinor: outstanding, currency: row.currency }),
          outstanding === row.outstandingMinor ? 'yes' : 'NO',
        ];
      }),
    ),
    table(
      ['Check', 'Sheet', 'Portal'],
      [
        [
          'Passports across all agencies',
          data.outcomes.reduce(
            (sum, outcome) =>
              sum + outcome.transform.rows.length + outcome.transform.rejected.length + outcome.transform.junk.length,
            0,
          ),
          data.outcomes.reduce((sum, outcome) => sum + outcome.imported, 0),
        ],
      ],
    ),
    'The two passport counts differ by exactly the rejected, junk and held-back rows above.',
    '',
    '## What to do next',
    '',
    '1. Read the exceptions and decide the duplicates.',
    '2. Put your decisions in `private/corrections.json`.',
    '3. Re-run the dry run until only genuine judgement calls remain.',
    '4. Write down your own expected counts and balances, independently.',
    '5. Then `npm run migrate-sheets -- --commit`, and check this report again against your numbers.',
    '',
  );

  return out.join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
