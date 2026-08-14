'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { CommitResult, PreviewRow } from '@/lib/dal/bookings';
import { formatDateTimeForDisplay, formatDateForDisplay } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

import {
  commitImportAction,
  previewImportAction,
  type PreviewState,
} from '@/app/(app)/admin/imports/actions';

const OUTCOME_LABEL: Record<PreviewRow['outcome'], string> = {
  will_book: 'Will be booked',
  already_booked: 'Already booked — excluded',
  unmatched: 'Matched nothing here',
  not_bookable: 'Cannot be booked',
  rejected_row: 'Could not read this row',
};

const OUTCOME_TONE: Record<PreviewRow['outcome'], string> = {
  will_book: 'text-emerald-700 dark:text-emerald-400',
  already_booked: 'text-amber-700 dark:text-amber-400',
  unmatched: 'text-muted-foreground',
  not_bookable: 'text-muted-foreground',
  rejected_row: 'text-destructive',
};

/**
 * Upload, preview, confirm.
 *
 * Nothing is written until the confirm button is pressed, and the thing the preview is
 * really for — passports that are already booked — is called out first and excluded by
 * default, because those are the accidental double-bookings this whole feature exists to
 * prevent.
 */
export function BookingImport() {
  const router = useRouter();
  const [state, previewAction, previewPending] = useActionState(previewImportAction, {
    status: 'idle',
  } as PreviewState);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const commit = () => {
    if (state.status !== 'ready') return;
    setCommitError(null);

    startTransition(async () => {
      const response = await commitImportAction({
        fileName: state.fileName,
        fileBase64: state.fileBase64,
      });
      if ('error' in response) {
        setCommitError(response.error);
        return;
      }
      setResult(response);
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload a booking file</CardTitle>
          <CardDescription>
            CSV or Excel. Nothing is written until you have seen what it would do and confirmed it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={previewAction} className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              accept=".csv,.xls,.xlsx"
              className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
            <Button type="submit" disabled={previewPending}>
              {previewPending ? 'Reading…' : 'Preview'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {state.status === 'unreadable' ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">{state.message}</CardTitle>
            <CardDescription>
              Nothing was imported. Rather than guess at the format, here is what was expected:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {state.detail.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {state.status === 'error' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ready' && !result ? (
        <Preview
          state={state}
          onCommit={commit}
          committing={pending}
          error={commitError}
        />
      ) : null}

      {result ? <CommitReport result={result} /> : null}
    </div>
  );
}

function Preview({
  state,
  onCommit,
  committing,
  error,
}: {
  state: Extract<PreviewState, { status: 'ready' }>;
  onCommit: () => void;
  committing: boolean;
  error: string | null;
}) {
  const { preview } = state;
  const alreadyBooked = preview.rows.filter((row) => row.outcome === 'already_booked');
  const willBook = preview.counts.will_book;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What this file would do</CardTitle>
          <CardDescription>
            {preview.filename}
            {preview.sheetName ? ` · sheet "${preview.sheetName}"` : ''} · header found on row{' '}
            {preview.headerRow} · {preview.counts.rowsInFile} rows
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Tile label="Will be booked" value={willBook} tone="text-emerald-700 dark:text-emerald-400" />
            <Tile
              label="Already booked"
              value={preview.counts.already_booked}
              tone="text-amber-700 dark:text-amber-400"
            />
            <Tile label="Matched nothing" value={preview.counts.unmatched} />
            <Tile label="Cannot be booked" value={preview.counts.not_bookable} />
            <Tile label="Unreadable rows" value={preview.counts.rejected_row} tone="text-destructive" />
          </div>

          {preview.charges.length > 0 ? (
            <p className="text-sm">
              Charges that would be raised:{' '}
              {preview.charges
                .map((charge) => `${formatMoney({ amountMinor: charge.amountMinor, currency: charge.currency })} across ${charge.count}`)
                .join(' · ')}
              . Each is priced from that passport&apos;s route and keeps that amount afterwards.
            </p>
          ) : null}

          {preview.alreadyImported ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
              This exact file was already imported on{' '}
              {formatDateForDisplay(new Date(preview.alreadyImported.uploadedAt))}. Committing it again
              would change nothing.
            </p>
          ) : null}

          {preview.fileProblems.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {preview.fileProblems.map((problem, index) => (
                <li key={index}>
                  {problem.rowNumber ? `Row ${problem.rowNumber}: ` : ''}
                  {problem.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-center gap-3">
            <Button onClick={onCommit} disabled={committing || willBook === 0 || Boolean(preview.alreadyImported)}>
              {committing ? 'Importing…' : `Import ${willBook} booking${willBook === 1 ? '' : 's'}`}
            </Button>
            <span className="text-xs text-muted-foreground">
              Already-booked rows are left out. The whole batch can be undone afterwards.
            </span>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {alreadyBooked.length > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">
              {alreadyBooked.length} already booked — excluded from this import
            </CardTitle>
            <CardDescription>
              These are the double-bookings this step exists to catch. Their existing appointments:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1">Row</th>
                  <th className="py-1">Passport</th>
                  <th className="py-1">Name</th>
                  <th className="py-1">Booked for</th>
                  <th className="py-1">Reference</th>
                </tr>
              </thead>
              <tbody>
                {alreadyBooked.map((row) => (
                  <tr key={row.rowNumber} className="border-b last:border-0">
                    <td className="py-1 text-xs text-muted-foreground">{row.rowNumber}</td>
                    <td className="py-1 font-mono text-xs">{row.passportNumber}</td>
                    <td className="py-1">{row.passportName ?? '—'}</td>
                    <td className="py-1">
                      {row.existingBooking
                        ? formatDateTimeForDisplay(new Date(row.existingBooking.appointmentAt))
                        : 'already marked booked'}
                    </td>
                    <td className="py-1 text-muted-foreground">{row.existingBooking?.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Every row in the file</CardTitle>
          <CardDescription>Nothing is hidden — including rows that matched nothing here.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1">Row</th>
                <th className="py-1">Passport</th>
                <th className="py-1">Appointment</th>
                <th className="py-1">Outcome</th>
                <th className="py-1">Why</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.rowNumber} className="border-b last:border-0">
                  <td className="py-1 text-xs text-muted-foreground">{row.rowNumber}</td>
                  <td className="py-1 font-mono text-xs">{row.passportNumber || '—'}</td>
                  <td className="py-1">
                    {row.appointmentAt ? formatDateTimeForDisplay(new Date(row.appointmentAt)) : '—'}
                  </td>
                  <td className={cn('py-1', OUTCOME_TONE[row.outcome])}>{OUTCOME_LABEL[row.outcome]}</td>
                  <td className="py-1 text-muted-foreground">{row.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function CommitReport({ result }: { result: CommitResult }) {
  if (result.noop) {
    return (
      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle className="text-base">Nothing to do</CardTitle>
          <CardDescription>
            That file was already imported on {formatDateForDisplay(new Date(result.noop.uploadedAt))}, so nothing
            changed. Re-uploading the same file is always safe.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-emerald-500/40">
      <CardHeader>
        <CardTitle className="text-base">
          {result.booked} booked{result.failures.length > 0 ? `, ${result.failures.length} failed` : ''}
        </CardTitle>
        <CardDescription>
          {result.charges.length > 0
            ? `Charges raised: ${result.charges
                .map((charge) => formatMoney({ amountMinor: charge.amountMinor, currency: charge.currency }))
                .join(' · ')}. They are on those agencies' balances now.`
            : 'No charges were raised.'}
        </CardDescription>
      </CardHeader>
      {result.failures.length > 0 ? (
        <CardContent>
          <ul className="space-y-1 text-sm text-destructive">
            {result.failures.map((failure) => (
              <li key={failure.rowNumber}>
                Row {failure.rowNumber}: {failure.reason}
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}
