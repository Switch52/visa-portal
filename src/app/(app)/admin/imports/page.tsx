import { BookingImport } from '@/components/booking-import';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { listImportBatches } from '@/lib/dal/bookings';
import { formatDateTimeForDisplay } from '@/lib/dates';

import { UndoBatchButton } from './undo-button';

/**
 * Bulk booking import.
 *
 * This is the only path by which a passport becomes `booked`. Everything else in the
 * portal — the UI, the API, the data layer — refuses that status, which is what keeps this
 * system and the main dashboard from disagreeing about what is confirmed.
 */
export default async function ImportsPage() {
  const actor = await requireAdmin();
  const batches = await listImportBatches(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Booking import</h1>
        <p className="text-sm text-muted-foreground">
          Importing a real booking file is the only thing that marks a passport as booked. Charges
          are raised here too, priced from each passport&apos;s route, in the same transaction as the
          booking.
        </p>
      </div>

      <BookingImport />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Previous imports</CardTitle>
          <CardDescription>
            Any batch can be undone in one action — the bookings are reversed, the passports go back
            to added, and their charges are voided with them.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">File</th>
                <th className="py-2">Imported</th>
                <th className="py-2">Booked</th>
                <th className="py-2">Skipped</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-muted-foreground">
                    Nothing imported yet.
                  </td>
                </tr>
              ) : (
                batches.map((batch) => (
                  <tr key={batch.id} className="border-b last:border-0">
                    <td className="py-2 font-medium">{batch.filename}</td>
                    <td className="py-2 text-muted-foreground">
                      {formatDateTimeForDisplay(batch.uploadedAt)}
                    </td>
                    <td className="py-2 tabular-nums">{batch.counts.booked}</td>
                    <td className="py-2 tabular-nums text-muted-foreground">
                      {batch.counts.alreadyBooked + batch.counts.unmatched + batch.counts.skipped}
                    </td>
                    <td className="py-2">
                      {batch.status === 'undone' ? (
                        <span className="text-muted-foreground">
                          Undone {batch.undoneAt ? formatDateTimeForDisplay(batch.undoneAt) : ''}
                        </span>
                      ) : (
                        <span className="text-emerald-700 dark:text-emerald-400">Committed</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {batch.status === 'committed' ? (
                        <UndoBatchButton batchId={batch.id} filename={batch.filename} count={batch.counts.booked} />
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
