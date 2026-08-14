'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const selectClass = 'border-input bg-background h-9 rounded-md border px-3 py-1 text-sm shadow-xs';

/** Filters in the URL, so a view of the log can be linked to and reloaded. */
export function AuditFilterBar({
  actions,
  agencies,
}: {
  actions: { value: string; label: string }[];
  agencies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const update = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value === '') next.delete(key);
      else next.set(key, value);
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  const hasFilters = ['action', 'agency', 'from', 'to'].some((key) => params.get(key));

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-background p-3">
      <div className="space-y-1">
        <label htmlFor="action" className="text-xs font-medium text-muted-foreground">
          Action
        </label>
        <select
          id="action"
          className={selectClass}
          value={params.get('action') ?? ''}
          onChange={(event) => update('action', event.target.value)}
        >
          <option value="">Everything</option>
          {actions.map((action) => (
            <option key={action.value} value={action.value}>
              {action.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="agency" className="text-xs font-medium text-muted-foreground">
          Agency
        </label>
        <select
          id="agency"
          className={selectClass}
          value={params.get('agency') ?? ''}
          onChange={(event) => update('agency', event.target.value)}
        >
          <option value="">All agencies</option>
          {agencies.map((agency) => (
            <option key={agency.id} value={agency.id}>
              {agency.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
          From
        </label>
        <Input
          id="from"
          type="date"
          className="w-40"
          value={params.get('from') ?? ''}
          onChange={(event) => update('from', event.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
          To
        </label>
        <Input
          id="to"
          type="date"
          className="w-40"
          value={params.get('to') ?? ''}
          onChange={(event) => update('to', event.target.value)}
        />
      </div>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={() => router.replace(pathname)}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
