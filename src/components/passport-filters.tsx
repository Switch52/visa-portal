'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PASSPORT_STATUSES, STATUS_LABELS } from '@/config/statuses';

const selectClass =
  'border-input bg-background flex h-9 rounded-md border px-3 py-1 text-sm shadow-xs';

/**
 * Filters live in the URL, so a filtered view can be linked, reloaded and — from
 * milestone 3 — exported exactly as it appears on screen.
 */
export function PassportFilters({
  agencies,
  nationalities,
  showAgency,
}: {
  agencies?: { id: string; name: string }[];
  nationalities: string[];
  showAgency?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');

  const update = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value === '') next.delete(key);
      else next.set(key, value);
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  // Debounced so a passport-number search fires as it is typed without a request per key.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => update('q', search), 300);
    return () => clearTimeout(timer);
  }, [search, params, update]);

  const hasFilters = ['q', 'status', 'agency', 'nationality', 'from', 'to'].some((key) => params.get(key));

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-background p-3">
      <div className="space-y-1">
        <label htmlFor="q" className="text-xs font-medium text-muted-foreground">
          Search
        </label>
        <Input
          id="q"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Passport number or name"
          className="w-56"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
          Status
        </label>
        <select
          id="status"
          className={selectClass}
          value={params.get('status') ?? ''}
          onChange={(event) => update('status', event.target.value)}
        >
          <option value="">Any status</option>
          {PASSPORT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      {showAgency && agencies ? (
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
      ) : null}

      <div className="space-y-1">
        <label htmlFor="nationality" className="text-xs font-medium text-muted-foreground">
          Nationality
        </label>
        <select
          id="nationality"
          className={selectClass}
          value={params.get('nationality') ?? ''}
          onChange={(event) => update('nationality', event.target.value)}
        >
          <option value="">Any</option>
          {nationalities.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
          Submitted from
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
          to
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
