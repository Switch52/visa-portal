import { ObjectId } from 'mongodb';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PassportEditForm } from '@/components/passport-edit-form';
import { StatusBadge } from '@/components/passport-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { STATUS_DESCRIPTIONS, isAgencyEditable } from '@/config/statuses';
import { requireUser } from '@/lib/auth/current-user';
import { getPassport, getPassportHistory } from '@/lib/dal/passports';
import { listRouteOptions } from '@/lib/dal/routes';
import { NotFoundError } from '@/lib/dal/errors';
import { formatDateForDisplay, formatDateTimeForDisplay } from '@/lib/dates';

/**
 * Fetching is kept out of the render: a "not found" is decided before any JSX exists, and
 * a try/catch wrapped around JSX would not catch a render-time error anyway.
 *
 * An agency reaching for another agency's id lands on the same "not found" as an id that
 * never existed — the DAL decides that, not this page.
 */
async function load(actor: Awaited<ReturnType<typeof requireUser>>, id: string) {
  try {
    return await Promise.all([
      getPassport(actor, new ObjectId(id)),
      getPassportHistory(actor, new ObjectId(id)),
      listRouteOptions(actor, true),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/** One passport, its details and its full history. */
export default async function PassportDetailPage(props: PageProps<'/passports/[id]'>) {
  const actor = await requireUser();
  const { id } = await props.params;

  if (!ObjectId.isValid(id)) notFound();

  const [passport, history, routes] = await load(actor, id);

  const isAdmin = actor.role === 'admin' && !actor.viewingAsAgencyId;
  const locked = !isAdmin && !isAgencyEditable(passport.status);
  const readOnly = Boolean(actor.viewingAsAgencyId) || locked;
  const route = routes.find((option) => option.id === passport.routeId);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {passport.firstName} {passport.lastName}
          </h1>
          <p className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="font-mono">{passport.passportNumber}</span>
            <StatusBadge status={passport.status} />
          </p>
        </div>
        <Link href="/passports" className="text-sm underline">
          Back to the list
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
              <CardDescription>
                {locked
                  ? 'This passport is booked, so its details are locked. Contact us if something is wrong.'
                  : 'The passport number cannot be changed here — cancel and resubmit if it is wrong.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PassportEditForm passport={passport} readOnly={readOnly} isAdmin={isAdmin} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Where it stands</CardTitle>
              <CardDescription>{STATUS_DESCRIPTIONS[passport.status]}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Route" value={route?.displayLabel ?? '—'} />
              <Row label="Submitted" value={formatDateForDisplay(passport.submittedAt)} />
              <Row
                label="Handed off"
                value={passport.addedAt ? formatDateForDisplay(passport.addedAt) : 'Not yet'}
              />
              <Row
                label="Hold until"
                value={passport.holdUntil ? formatDateForDisplay(passport.holdUntil) : '—'}
              />
              <Row label="Priority" value={passport.priority === 'urgent' ? 'Urgent' : 'Normal'} />
              <Row label="Application type" value={passport.applicationType} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">History</CardTitle>
              <CardDescription>Every status change, with when and how.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm">
                {history.map((entry, index) => (
                  <li key={index} className="border-l-2 pl-3">
                    <p className="font-medium">{entry.status}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTimeForDisplay(entry.at)}
                      {entry.via === 'booking_import' ? ' · from a booking import' : ''}
                      {entry.via === 'system' ? ' · automatic' : ''}
                      {entry.actorName ? ` · ${entry.actorName}` : ''}
                    </p>
                    {entry.note ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
