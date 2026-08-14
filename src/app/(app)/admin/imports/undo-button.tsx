'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';

import { undoImportAction } from './actions';

/**
 * Undoing an import is one click, but it asks first: it reverses real bookings, real
 * statuses and real money, and the confirmation says exactly how much of each.
 */
export function UndoBatchButton({
  batchId,
  filename,
  count,
}: {
  batchId: string;
  filename: string;
  count: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const undo = () => {
    setError(null);
    startTransition(async () => {
      const result = await undoImportAction(batchId);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  };

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Undo
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <p className="text-xs text-muted-foreground">
        Undo {filename}? {count} passport{count === 1 ? '' : 's'} go back to added and their charges are
        voided.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={undo} disabled={pending}>
          {pending ? 'Undoing…' : 'Yes, undo it'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
