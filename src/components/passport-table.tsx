'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATUS_LABELS, type PassportStatus } from '@/config/statuses';
import type { PassportView } from '@/lib/dal/passports';
import { formatDateForDisplay } from '@/lib/dates';
import { cn } from '@/lib/utils';

import { changeStatusAction } from '@/app/(app)/passports/actions';

const STATUS_TONE: Record<PassportStatus, string> = {
  submitted: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
  on_hold: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  ready: 'bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100',
  added: 'bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100',
  booked: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100',
  completed: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
};

export function StatusBadge({ status }: { status: PassportStatus }) {
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * The passport list.
 *
 * Bulk status changes are admin-only and go one row at a time on the server, so a row that
 * cannot make the move reports why instead of failing the whole selection. `booked` is
 * absent from the menu because no manual path may set it — the server refuses it too.
 */
export function PassportTable({
  passports,
  agencyNames,
  showAgency,
  allowBulk,
}: {
  passports: PassportView[];
  agencyNames?: Record<string, string>;
  showAgency?: boolean;
  allowBulk?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) =>
      current.size === passports.length ? new Set() : new Set(passports.map((p) => p.id)),
    );
  };

  const applyStatus = (to: PassportStatus) => {
    startTransition(async () => {
      const result = await changeStatusAction([...selected], to);
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      const failed = result.failures.length;
      setMessage(
        `${result.changed} moved to ${STATUS_LABELS[to]}${failed > 0 ? `, ${failed} could not: ${result.failures[0]!.reason}` : ''}.`,
      );
      setSelected(new Set());
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {allowBulk && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-background px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          {(['ready', 'on_hold', 'added', 'cancelled', 'rejected'] as PassportStatus[]).map((status) => (
            <Button key={status} size="sm" variant="outline" disabled={pending} onClick={() => applyStatus(status)}>
              Mark {STATUS_LABELS[status].toLowerCase()}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">
            Booked is not here: only a booking-file import can set it.
          </span>
        </div>
      ) : null}

      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}

      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {allowBulk ? (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={selected.size === passports.length && passports.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
              ) : null}
              <TableHead>Name</TableHead>
              <TableHead>Passport</TableHead>
              <TableHead>Nationality</TableHead>
              {showAgency ? <TableHead>Agency</TableHead> : null}
              <TableHead>Status</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {passports.length === 0 ? (
              <TableRow>
                <TableCell colSpan={allowBulk ? 8 : 7} className="text-muted-foreground">
                  Nothing matches.
                </TableCell>
              </TableRow>
            ) : (
              passports.map((passport) => (
                <TableRow key={passport.id}>
                  {allowBulk ? (
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(passport.id)}
                        onChange={() => toggle(passport.id)}
                        aria-label={`Select ${passport.passportNumber}`}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className="font-medium">
                    <Link href={`/passports/${passport.id}`} className="hover:underline">
                      {passport.firstName} {passport.lastName}
                    </Link>
                    {passport.priority === 'urgent' ? (
                      <Badge variant="destructive" className="ml-2">
                        Urgent
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{passport.passportNumber}</TableCell>
                  <TableCell>{passport.nationality}</TableCell>
                  {showAgency ? (
                    <TableCell>
                      {passport.agencyId ? (agencyNames?.[passport.agencyId] ?? '—') : '—'}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <StatusBadge status={passport.status} />
                    {passport.holdUntil ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        until {formatDateForDisplay(passport.holdUntil)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateForDisplay(passport.submittedAt)}
                  </TableCell>
                  {/* Notes are Arabic or English; let the browser pick the direction. */}
                  <TableCell dir="auto" className="max-w-[16rem] truncate">
                    {passport.notes ?? '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
