import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/current-user';
import { listRouteOptions } from '@/lib/dal/routes';
import { ReadOnlySessionError } from '@/lib/dal/errors';

/**
 * Choosing where to file.
 *
 * Each route has its own entry page at its own address, so Cairo and Alexandria are two
 * separate places to work rather than one screen with a dropdown to get wrong. Any route
 * added later appears here on its own, with no code change: the list is the routes.
 *
 * Only active routes are offered. A route that is set up but not running yet — Alexandria,
 * today — is deliberately not a place anyone can file into.
 */
export default async function ChooseRoutePage() {
  const actor = await requireUser();

  if (actor.viewingAsAgencyId) {
    return (
      <div className="rounded-md border bg-background p-6">
        <h1 className="text-lg font-semibold">Read-only</h1>
        <p className="mt-2 text-sm text-muted-foreground">{new ReadOnlySessionError().message}</p>
      </div>
    );
  }

  const routes = await listRouteOptions(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Add passports</h1>
        <p className="text-sm text-muted-foreground">
          Choose where these applications are going. Each one has its own entry page.
        </p>
      </div>

      {routes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nothing is open for applications yet</CardTitle>
            <CardDescription>
              A passport is submitted for a route, and none is active. Ask us to open one.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {routes.map((route) => (
            <Link key={route.id} href={`/passports/new/${route.id}`} className="block">
              <Card className="h-full transition-colors hover:border-primary/60">
                <CardHeader>
                  <CardTitle className="text-base">{route.displayLabel}</CardTitle>
                  <CardDescription>Open the entry grid for this route</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Paste straight from your spreadsheet, or type. Singles and families both.
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        <Link href="/passports" className="underline">
          Back to your passports
        </Link>
      </p>
    </div>
  );
}
