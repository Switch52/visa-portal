'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GRID_COLUMNS, GRID_FIELDS, type GridField } from '@/lib/grid/columns';
import { APPLICATION_TYPES, APPLICATION_TYPE_LABELS, APPLICATION_TYPE_SIZE, type ApplicationType } from '@/config/validation';
import { emptyRow, parsePaste, normalizeCell, type GridRow } from '@/lib/grid/paste';
import { isRowEmpty, validateRow, type RowErrors } from '@/lib/grid/validate';
import { normalizePassportNumber } from '@/config/validation';
import { cn } from '@/lib/utils';

import {
  checkDuplicatesAction,
  savePassportBatchAction,
  type DuplicateHit,
} from '@/app/(app)/passports/actions';
import type { BatchRowResult } from '@/lib/dal/passports';

const INITIAL_ROWS = 8;

interface RouteOption {
  id: string;
  displayLabel: string;
}

interface SaveReport {
  saved: number;
  blocked: number;
  rows: BatchRowResult[];
}

/**
 * Grid entry.
 *
 * The bar this has to clear is a spreadsheet: Tab and the arrow keys move between cells,
 * Enter on the last field adds a row, and a multi-row multi-column paste from Excel or
 * Google Sheets fills the grid in one go. Validation is per cell and live, and nothing
 * typed is ever thrown away by a failed submit — blocked rows stay on screen with their
 * reason so they can be fixed and saved again.
 */
export function PassportGrid({
  routes,
  agencyId,
  agencyName,
  /** When set, this grid belongs to one route and the picker disappears. */
  fixedRouteId,
}: {
  routes: RouteOption[];
  /** Set when an admin is entering on an agency's behalf. */
  agencyId?: string;
  agencyName?: string;
  fixedRouteId?: string;
}) {
  const [rows, setRows] = useState<GridRow[]>(() => Array.from({ length: INITIAL_ROWS }, emptyRow));
  const [routeId, setRouteId] = useState<string>(fixedRouteId ?? routes[0]?.id ?? '');
  // Members of one family application share a reference, so they stay together from here
  // all the way through the queue, the export and the booking file.
  const [groups, setGroups] = useState<Record<number, string>>({});
  const [rowRoutes, setRowRoutes] = useState<Record<number, string>>({});
  const [duplicates, setDuplicates] = useState<Record<string, string>>({});
  const [report, setReport] = useState<SaveReport | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cellRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const key = (row: number, field: GridField) => `${row}:${field}`;

  const filledRows = useMemo(() => rows.filter((row) => !isRowEmpty(row)), [rows]);

  const validations = useMemo(
    () =>
      rows.map((row, index) =>
        isRowEmpty(row) ? null : validateRow(row, rowRoutes[index] ?? routeId, groups[index] ?? null),
      ),
    [rows, routeId, rowRoutes, groups],
  );

  /**
   * A family that is short of members is worth saying out loud — four rows were expected
   * and three were typed — but it does not block the save: the missing one may be coming
   * separately, and losing three good rows over it would help nobody.
   */
  const familyWarnings = useMemo(() => {
    const sizes = new Map<string, { expected: number; actual: number }>();
    rows.forEach((row, index) => {
      const ref = groups[index];
      if (!ref || isRowEmpty(row)) return;
      const type = (row.applicationType || 'single') as ApplicationType;
      const entry = sizes.get(ref) ?? { expected: APPLICATION_TYPE_SIZE[type] ?? 1, actual: 0 };
      entry.actual += 1;
      sizes.set(ref, entry);
    });
    return [...sizes.values()].filter((entry) => entry.actual !== entry.expected);
  }, [rows, groups]);

  /** Duplicate messages are keyed by normalized number, so they follow an edited cell. */
  const duplicateFor = useCallback(
    (row: GridRow): string | null => {
      const normalized = normalizePassportNumber(row.passportNumber);
      return normalized ? (duplicates[normalized] ?? null) : null;
    },
    [duplicates],
  );

  const readyCount = validations.filter((validation, index) => validation?.ok && !duplicateFor(rows[index]!)).length;
  const problemCount = filledRows.length - readyCount;

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  const setCell = useCallback((rowIndex: number, field: GridField, value: string) => {
    setRows((current) => {
      const next = [...current];
      next[rowIndex] = { ...next[rowIndex]!, [field]: value };
      // Typing past the last row adds another, so the grid never runs out underneath you.
      if (rowIndex === next.length - 1 && value !== '') next.push(emptyRow());
      return next;
    });
    setReport(null);
  }, []);

  /** Append the rows of one family application, already marked and linked together. */
  const addFamily = useCallback((type: ApplicationType) => {
    const size = APPLICATION_TYPE_SIZE[type];
    const ref = `fam_${Math.random().toString(36).slice(2, 10)}`;

    setRows((current) => {
      const trimmed = current.filter((row, index) => !isRowEmpty(row) || index < current.length - 1);
      const start = trimmed.length;

      setGroups((groupState) => {
        const next = { ...groupState };
        for (let i = 0; i < size; i += 1) next[start + i] = ref;
        return next;
      });

      const added = Array.from({ length: size }, () => ({ ...emptyRow(), applicationType: type }));
      return [...trimmed, ...added, emptyRow()];
    });
    setReport(null);
  }, []);

  const focusCell = useCallback((rowIndex: number, field: GridField) => {
    const input = cellRefs.current.get(`${rowIndex}:${field}`);
    input?.focus();
    input?.select();
  }, []);

  const moveFocus = useCallback(
    (rowIndex: number, field: GridField, direction: 'up' | 'down' | 'left' | 'right') => {
      const fieldIndex = GRID_FIELDS.indexOf(field);
      if (direction === 'up') return focusCell(Math.max(0, rowIndex - 1), field);
      if (direction === 'down') return focusCell(rowIndex + 1, field);
      if (direction === 'left' && fieldIndex > 0) return focusCell(rowIndex, GRID_FIELDS[fieldIndex - 1]!);
      if (direction === 'right' && fieldIndex < GRID_FIELDS.length - 1) {
        return focusCell(rowIndex, GRID_FIELDS[fieldIndex + 1]!);
      }
    },
    [focusCell],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, rowIndex: number, field: GridField) => {
      const input = event.currentTarget;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;

      switch (event.key) {
        case 'Enter': {
          event.preventDefault();
          const isLastField = GRID_FIELDS.indexOf(field) === GRID_FIELDS.length - 1;
          if (isLastField) {
            // Enter at the last field starts the next row, the way tabbing off the end of
            // a spreadsheet row does.
            setRows((current) => (rowIndex === current.length - 1 ? [...current, emptyRow()] : current));
            focusCell(rowIndex + 1, GRID_FIELDS[0]!);
          } else {
            moveFocus(rowIndex, field, 'down');
          }
          break;
        }
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(rowIndex, field, 'up');
          break;
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(rowIndex, field, 'down');
          break;
        // Left and right only move cells from the edge of the text, so ordinary
        // within-cell editing still works.
        case 'ArrowLeft':
          if (atStart) {
            event.preventDefault();
            moveFocus(rowIndex, field, 'left');
          }
          break;
        case 'ArrowRight':
          if (atEnd) {
            event.preventDefault();
            moveFocus(rowIndex, field, 'right');
          }
          break;
        default:
          break;
      }
    },
    [focusCell, moveFocus],
  );

  // ---------------------------------------------------------------------------
  // Paste
  // ---------------------------------------------------------------------------

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLInputElement>, rowIndex: number, field: GridField) => {
      const text = event.clipboardData.getData('text/plain');
      // A single cell with no tabs or newlines is an ordinary paste; leave it alone.
      if (!text.includes('\t') && !text.includes('\n')) return;

      event.preventDefault();
      const result = parsePaste(text, { startField: field });
      if (result.rows.length === 0) return;

      setRows((current) => {
        const next = [...current];
        result.rows.forEach((pastedRow, offset) => {
          const target = rowIndex + offset;
          while (next.length <= target) next.push(emptyRow());

          // Without a header the paste fills from the cell it started in; with one, each
          // column goes where its name says, and untouched cells keep what they had.
          const merged = { ...next[target]! };
          for (const gridField of GRID_FIELDS) {
            if (pastedRow[gridField] !== '') merged[gridField] = pastedRow[gridField];
          }
          next[target] = merged;
        });
        if (!isRowEmpty(next[next.length - 1]!)) next.push(emptyRow());
        return next;
      });

      const notes: string[] = [`Pasted ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.`];
      if (result.mapping) notes.push(`Matched columns by name: ${result.mapping.recognised.join(', ')}.`);
      if (result.ignoredColumns.length > 0) {
        notes.push(`Ignored ${result.ignoredColumns.join(', ')} — this portal does not store those.`);
      }
      if (result.unknownColumns.length > 0) {
        notes.push(`Did not recognise ${result.unknownColumns.join(', ')}, so those were left out.`);
      }
      if (result.truncatedColumns > 0) {
        notes.push(`${result.truncatedColumns} pasted value(s) went past the last column and were dropped.`);
      }
      setPasteNote(notes.join(' '));
      setReport(null);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Duplicate checking
  // ---------------------------------------------------------------------------

  const numbersToCheck = useMemo(
    () =>
      rows
        .map((row) => normalizePassportNumber(row.passportNumber))
        .filter((value) => value.length >= 5),
    [rows],
  );

  useEffect(() => {
    if (numbersToCheck.length === 0) return;
    let cancelled = false;

    // Debounced: this runs while someone is typing, and it is a database read.
    const timer = setTimeout(async () => {
      const hits: DuplicateHit[] = await checkDuplicatesAction(numbersToCheck);
      if (cancelled) return;
      setDuplicates(Object.fromEntries(hits.map((hit) => [hit.normalized, hit.message])));
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [numbersToCheck.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  const save = useCallback(() => {
    setSaveError(null);

    const payload: { input: NonNullable<ReturnType<typeof validateRow>['input']>; rowIndex: number }[] = [];
    rows.forEach((row, index) => {
      if (isRowEmpty(row)) return;
      const validation = validations[index];
      if (validation?.ok && validation.input) payload.push({ input: validation.input, rowIndex: index });
    });

    if (payload.length === 0) {
      setSaveError('Nothing to save yet — every row still has something to fix.');
      return;
    }

    startTransition(async () => {
      const result = await savePassportBatchAction({
        rows: payload.map((entry) => entry.input),
        agencyId,
      });

      if ('error' in result) {
        setSaveError(result.error);
        return;
      }

      // Keep what did not save, with its reason, and clear only what did — nothing typed
      // is lost by a failed submit.
      const blockedByGridRow = new Map<number, BatchRowResult>();
      for (const row of result.rows) {
        if (row.status === 'blocked') blockedByGridRow.set(payload[row.index]!.rowIndex, row);
      }

      setRows((current) => {
        const kept = current.filter((row, index) => {
          if (isRowEmpty(row)) return false;
          const wasSubmitted = payload.some((entry) => entry.rowIndex === index);
          return !wasSubmitted || blockedByGridRow.has(index);
        });
        return kept.length > 0 ? [...kept, emptyRow()] : Array.from({ length: INITIAL_ROWS }, emptyRow);
      });

      setReport({
        saved: result.saved,
        blocked: result.blocked,
        rows: result.rows.map((row) => ({ ...row, index: payload[row.index]!.rowIndex })),
      });
    });
  }, [rows, validations, agencyId]);

  const blockedReasons = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of report?.rows ?? []) {
      if (row.status === 'blocked' && row.reason) map.set(row.index, row.reason);
    }
    return map;
  }, [report]);

  // ---------------------------------------------------------------------------

  if (routes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No routes yet</CardTitle>
          <CardDescription>
            A passport is submitted for a route, and none has been set up. Ask the admin to add one
            before entering passports.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">
            {agencyName ? `Add passports for ${agencyName}` : 'Add passports'}
          </CardTitle>
          <CardDescription>
            Paste straight from your spreadsheet — several rows and columns at once. Tab and the
            arrow keys move between cells; Enter at the last cell starts a new row. Dates are
            day/month/year.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          {fixedRouteId ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {routes.find((route) => route.id === fixedRouteId)?.displayLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                Everything entered here goes to this route. Other routes have their own page.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor="batch-route" className="text-sm font-medium">
                Route for this batch
              </label>
              <select
                id="batch-route"
                value={routeId}
                onChange={(event) => setRouteId(event.target.value)}
                className="border-input bg-background flex h-9 w-80 rounded-md border px-3 py-1 text-sm shadow-xs"
              >
                {routes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.displayLabel}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Chosen once for the batch. Override a single row in its own Route cell.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Add as a family:</span>
            {(['family_2', 'family_4'] as ApplicationType[]).map((type) => (
              <Button key={type} variant="outline" size="sm" onClick={() => addFamily(type)}>
                {APPLICATION_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {readyCount} ready{problemCount > 0 ? `, ${problemCount} to fix` : ''}
            </span>
            <Button onClick={save} disabled={pending || readyCount === 0}>
              {pending ? 'Saving…' : `Save ${readyCount} passport${readyCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {familyWarnings.length > 0 ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          {familyWarnings
            .map((warning) => `A family of ${warning.expected} has ${warning.actual} row(s) filled in`)
            .join('. ')}
          . They will still save — this is only worth a look.
        </p>
      ) : null}

      {pasteNote ? (
        <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">{pasteNote}</p>
      ) : null}

      {saveError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {saveError}
        </p>
      ) : null}

      {report ? <SaveReportPanel report={report} /> : null}

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="w-10 px-2 py-2 text-left text-xs font-medium text-muted-foreground">#</th>
              {GRID_COLUMNS.map((column) => (
                <th key={column.field} className={cn('px-2 py-2 text-left text-xs font-medium', column.width)}>
                  {column.label}
                  {column.required ? <span className="text-destructive"> *</span> : null}
                  {column.hint ? (
                    <span className="block font-normal text-muted-foreground">{column.hint}</span>
                  ) : null}
                </th>
              ))}
              <th className="w-52 px-2 py-2 text-left text-xs font-medium text-muted-foreground">Route</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const validation = validations[rowIndex];
              const duplicate = duplicateFor(row);
              const blocked = blockedReasons.get(rowIndex);
              const errors: RowErrors = validation?.errors ?? {};

              return (
                <tr
                  key={rowIndex}
                  className={cn(
                    'border-b',
                    duplicate || blocked ? 'bg-destructive/5' : undefined,
                    validation?.ok && !duplicate ? 'bg-emerald-500/5' : undefined,
                    // A family reads as one block rather than as adjacent strangers.
                    groups[rowIndex] ? 'border-l-2 border-l-primary/50' : undefined,
                  )}
                >
                  <td className="px-2 py-1 text-xs text-muted-foreground tabular-nums">{rowIndex + 1}</td>

                  {GRID_COLUMNS.map((column) => {
                    const error = errors[column.field];
                    const isDuplicateCell = column.field === 'passportNumber' && duplicate;

                    if (column.field === 'applicationType') {
                      return (
                        <td key={column.field} className="px-1 py-1 align-top">
                          <select
                            value={row.applicationType || 'single'}
                            onChange={(event) => setCell(rowIndex, 'applicationType', event.target.value)}
                            className={cn(
                              'h-8 w-full rounded border border-transparent bg-transparent px-1 text-xs hover:border-input',
                              error && 'border-destructive',
                            )}
                            aria-label={`Application type, row ${rowIndex + 1}`}
                          >
                            {APPLICATION_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {APPLICATION_TYPE_LABELS[type]}
                              </option>
                            ))}
                          </select>
                          {groups[rowIndex] ? (
                            <p className="px-1 text-[11px] text-muted-foreground">one application</p>
                          ) : null}
                        </td>
                      );
                    }

                    return (
                      <td key={column.field} className="px-1 py-1 align-top">
                        <input
                          ref={(element) => {
                            if (element) cellRefs.current.set(key(rowIndex, column.field), element);
                            else cellRefs.current.delete(key(rowIndex, column.field));
                          }}
                          value={row[column.field]}
                          placeholder={column.placeholder}
                          dir={column.field === 'notes' ? 'auto' : undefined}
                          onChange={(event) => setCell(rowIndex, column.field, event.target.value)}
                          onBlur={(event) =>
                            setCell(rowIndex, column.field, normalizeCell(column.field, event.target.value))
                          }
                          onKeyDown={(event) => handleKeyDown(event, rowIndex, column.field)}
                          onPaste={(event) => handlePaste(event, rowIndex, column.field)}
                          className={cn(
                            'h-8 w-full rounded border bg-transparent px-2 text-sm outline-none',
                            'focus:border-primary focus:ring-1 focus:ring-primary',
                            error || isDuplicateCell ? 'border-destructive' : 'border-transparent hover:border-input',
                            column.width,
                          )}
                          aria-label={`${column.label}, row ${rowIndex + 1}`}
                          aria-invalid={Boolean(error || isDuplicateCell)}
                        />
                        {error ? <p className="px-2 text-[11px] text-destructive">{error}</p> : null}
                      </td>
                    );
                  })}

                  <td className="px-1 py-1 align-top">
                    <select
                      value={rowRoutes[rowIndex] ?? ''}
                      onChange={(event) =>
                        setRowRoutes((current) => ({ ...current, [rowIndex]: event.target.value }))
                      }
                      className="h-8 w-full rounded border border-transparent bg-transparent px-1 text-xs hover:border-input"
                      aria-label={`Route override, row ${rowIndex + 1}`}
                    >
                      <option value="">Batch route</option>
                      {routes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.displayLabel}
                        </option>
                      ))}
                    </select>
                    {duplicate ? <p className="px-1 text-[11px] text-destructive">{duplicate}</p> : null}
                    {blocked && !duplicate ? (
                      <p className="px-1 text-[11px] text-destructive">{blocked}</p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRows((current) => [...current, ...Array.from({ length: 5 }, emptyRow)])}
        >
          Add 5 rows
        </Button>
        <span className="text-xs text-muted-foreground">
          Blocked rows stay here with their reason — fix them and save again.
        </span>
      </div>
    </div>
  );
}

function SaveReportPanel({ report }: { report: SaveReport }) {
  const blocked = report.rows.filter((row) => row.status === 'blocked');

  return (
    <div className="rounded-md border bg-background p-4">
      <p className="text-sm font-medium">
        {report.saved} saved
        {report.blocked > 0 ? `, ${report.blocked} blocked` : ''}.
      </p>
      {blocked.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-destructive">
          {blocked.map((row) => (
            <li key={row.index}>
              Row {row.index + 1}: {row.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
