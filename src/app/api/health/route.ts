import { NextResponse } from 'next/server';

/**
 * Liveness, for the container's HEALTHCHECK and whatever sits in front of it.
 *
 * Deliberately shallow: it proves this process can accept a connection and render a
 * response, and nothing else. It does not touch MongoDB.
 *
 * That is the point. A health check that pings the database couples every container's
 * liveness to one shared dependency, so a slow Atlas moment fails every check at once
 * and the orchestrator restarts the whole fleet — turning a brief database wobble into
 * a full outage, and restarting the one thing that was never broken. Readiness against
 * the database belongs in `npm run preflight`, which is run deliberately and read by a
 * person.
 *
 * Unauthenticated, so it must stay boring: no version, no configuration, no counts.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
