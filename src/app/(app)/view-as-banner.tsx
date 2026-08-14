'use client';

import { Button } from '@/components/ui/button';

import { endViewAsAction } from './actions';

/** One click out of a view-as session, from the persistent banner. */
export function EndViewAsButton() {
  return (
    <form action={endViewAsAction}>
      <Button type="submit" size="sm" variant="secondary">
        Exit view
      </Button>
    </form>
  );
}
