'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { QueueGroup } from '@/lib/dal/handoff';
import { formatDateForDisplay } from '@/lib/dates';
import { cn } from '@/lib/utils';

import { markAddedAction } from '@/app/(app)/admin/handoff/actions';

/** Waiting longer than this is worth noticing; longer than twice this, worth chasing. */
const STALE_DAYS = 7;

interface Outcome {
  marked: number;
  alreadyAdded: number;
  failures: string[];
}

/**
 * One route's worth of the handoff queue.
 *
 * The order of operations on screen is the order of the real job: select, export, go and
 * enter them in the other system, then come back and mark them added. The export button
 * does not change any status, and the mark button is deliberately separate — and stays
 * available whether or not an export happened, because sometimes the file was downloaded
 * an hour ago.
 */
export function HandoffQueue({ groups }: { groups: QueueGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="rounded-md border bg-background p-6 text-sm text-muted-foreground">
        Nothing is waiting to be handed off. Passports appear here once they are marked ready.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <RouteGroup key={group.routeId} group={group} />
      ))}
    </div>
  );
}

function RouteGroup({ group }: { group: QueueGroup }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(group.entries.map((e) => e.id)));
  const [exported, setExported] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ids = useMemo(() => [...selected], [selected]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((current) =>
      current.size === group.entries.length ? new Set() : new Set(group.entries.map((e) => e.id)),
    );

  const exportUrl = `/api/exports/handoff?ids=${ids.join(',')}`;

  const markAdded = () => {
    setError(null);
    startTransition(async () => {
      const result = await markAddedAction(ids);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setOutcome({
        marked: result.marked,
        alreadyAdded: result.alreadyAdded.length,
        failures: result.failures.map((failure) => failure.reason),
      });
      router.refresh();
    });
  };

  return (
    <section className="rounded-md border bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">{group.routeLabel}</h2>
          <p className="text-xs text-muted-foreground">
            {group.entries.length} waiting · oldest {group.oldestWaitingDays} day
            {group.oldestWaitingDays === 1 ? '' : 's'}
            {group.urgentCount > 0 ? ` · ${group.urgentCount} urgent` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{selected.size} selected</span>

          {/* A plain link, so the browser downloads it the way it downloads anything. */}
          <a
            href={exportUrl}
            onClick={() => setExported(true)}
            className={cn(
              'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground',
              selected.size === 0 && 'pointer-events-none opacity-50',
            )}
          >
            Export {selected.size} as CSV
          </a>

          <Button
            variant={exported ? 'default' : 'outline'}
            disabled={pending || selected.size === 0}
            onClick={markAdded}
          >
            {pending ? 'Marking…' : `Mark ${selected.size} as added`}
          </Button>
        </div>
      </header>

      {exported && !outcome ? (
        <p className="border-b bg-muted/40 px-4 py-2 text-sm">
          Exported. Once those {selected.size} are in the main dashboard, mark them as added — the
          export on its own changed nothing, and re-exporting is always safe.
        </p>
      ) : null}

      {outcome ? (
        <p className="border-b bg-muted/40 px-4 py-2 text-sm">
          {outcome.marked} marked as added
          {outcome.alreadyAdded > 0 ? `, ${outcome.alreadyAdded} already were` : ''}
          {outcome.failures.length > 0 ? ` — ${outcome.failures[0]}` : '.'}
        </p>
      ) : null}

      {error ? <p className="border-b px-4 py-2 text-sm text-destructive">{error}</p> : null}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-10 px-4 py-2">
              <input
                type="checkbox"
                checked={selected.size === group.entries.length}
                onChange={toggleAll}
                aria-label={`Select all for ${group.routeLabel}`}
              />
            </th>
            <th className="px-2 py-2">Name</th>
            <th className="px-2 py-2">Passport</th>
            <th className="px-2 py-2">Nationality</th>
            <th className="px-2 py-2">Submitted</th>
            <th className="px-2 py-2">Waiting</th>
          </tr>
        </thead>
        <tbody>
          {group.entries.map((entry) => (
            <tr key={entry.id} className="border-b last:border-0">
              <td className="px-4 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  aria-label={`Select ${entry.passportNumber}`}
                />
              </td>
              <td className="px-2 py-2">
                {entry.firstName} {entry.lastName}
                {entry.priority === 'urgent' ? (
                  <Badge variant="destructive" className="ml-2">
                    Urgent
                  </Badge>
                ) : null}
              </td>
              <td className="px-2 py-2 font-mono text-xs">{entry.passportNumber}</td>
              <td className="px-2 py-2">{entry.nationality}</td>
              <td className="px-2 py-2 text-muted-foreground">{formatDateForDisplay(entry.submittedAt)}</td>
              <td
                className={cn(
                  'px-2 py-2 tabular-nums',
                  entry.waitingDays >= STALE_DAYS * 2
                    ? 'font-medium text-destructive'
                    : entry.waitingDays >= STALE_DAYS
                      ? 'text-amber-600'
                      : 'text-muted-foreground',
                )}
              >
                {entry.waitingDays}d
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
