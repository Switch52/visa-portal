'use client';

import { useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Export whatever the list is currently showing.
 *
 * The link carries the same search params the screen is filtered by, and the export route
 * parses them with the same code the page does — so what is on screen is what lands in the
 * file, with no second definition of "the current view" to drift.
 */
export function ExportCurrentView({ disabled }: { disabled?: boolean }) {
  const params = useSearchParams();
  const query = params.toString();

  return (
    <a
      href={`/api/exports/handoff${query ? `?${query}` : ''}`}
      className={cn(
        'inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium',
        'hover:bg-muted',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      Export this view as CSV
    </a>
  );
}
