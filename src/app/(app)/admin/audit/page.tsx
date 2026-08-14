import { ObjectId } from 'mongodb';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { listAgencies } from '@/lib/dal/agencies';
import { countAuditEntries, listAuditActions, listAuditEntries } from '@/lib/dal/audit';
import { listUsers } from '@/lib/dal/users';
import { formatDateTimeForDisplay, parseDateOnly } from '@/lib/dates';

import { AuditFilterBar } from './filter-bar';

const ACTION_LABEL: Record<string, string> = {
  'passport.create': 'Passports submitted',
  'passport.update': 'Passport edited',
  'passport.status_change': 'Status changed',
  'passport.duplicate_blocked': 'Duplicate blocked',
  'passport.export': 'Handoff exported',
  'booking.import': 'Booking import',
  'booking.import_undo': 'Import undone',
  'payment.record': 'Payment recorded',
  'payment.delete': 'Payment reversed',
  'user.invite': 'User invited',
  'user.deactivate': 'User deactivated',
  'user.reactivate': 'User reactivated',
  'agency.create': 'Agency added',
  'agency.update': 'Agency updated',
  'agency.deactivate': 'Agency deactivated',
  'route.create': 'Route added',
  'route.update': 'Route or setting updated',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.otp_requested': 'Sign-in code requested',
  'auth.otp_failed': 'Wrong sign-in code',
  'auth.blocked_unknown_email': 'Unknown email tried to sign in',
  'viewas.start': 'Started viewing as agency',
  'viewas.end': 'Left agency view',
};

/**
 * The audit log, read-only and admin-only.
 *
 * It is append-only by design and spans every agency, so there is no agency-scoped version
 * of this screen. Passport numbers, names and dates of birth were stripped when each entry
 * was written, so what is shown here cannot leak them however it is filtered.
 */
export default async function AuditPage(props: PageProps<'/admin/audit'>) {
  const actor = await requireAdmin();
  const params = await props.searchParams;

  const single = (key: string) => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.trim() || undefined;
  };

  const agencyParam = single('agency');
  const fromParam = single('from');
  const toParam = single('to');

  const filters = {
    action: single('action'),
    agencyId: agencyParam && ObjectId.isValid(agencyParam) ? new ObjectId(agencyParam) : undefined,
    from: fromParam ? tryDate(fromParam) : undefined,
    to: toParam ? tryDate(toParam, true) : undefined,
    limit: 200,
  };

  const [entries, actions, agencies, users, total] = await Promise.all([
    listAuditEntries(actor, filters),
    listAuditActions(actor),
    listAgencies(actor),
    listUsers(actor),
    countAuditEntries(actor, filters),
  ]);

  const agencyName = new Map(agencies.map((agency) => [agency.id, agency.name]));
  const userName = new Map(users.map((user) => [user.id, user.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Append-only. Every status change, booking, import, export, payment, invite and
          deactivation, with who did it and when.
        </p>
      </div>

      <AuditFilterBar
        actions={actions.map((action) => ({ value: action, label: ACTION_LABEL[action] ?? action }))}
        agencies={agencies.map((agency) => ({ id: agency.id, name: agency.name }))}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{entries.length} shown</CardTitle>
          <CardDescription>
            {total} entries match. Personal data is stripped when an entry is written, so these
            records describe what happened without repeating what it happened to.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">When</th>
                <th className="py-2">What</th>
                <th className="py-2">Who</th>
                <th className="py-2">Agency</th>
                <th className="py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-muted-foreground">
                    Nothing matches these filters.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0 align-top">
                    <td className="py-2 whitespace-nowrap text-muted-foreground">
                      {formatDateTimeForDisplay(entry.at)}
                    </td>
                    <td className="py-2">{ACTION_LABEL[entry.action] ?? entry.action}</td>
                    <td className="py-2 text-muted-foreground">
                      {entry.actorId ? (userName.get(entry.actorId) ?? entry.actorRole) : 'System'}
                      {entry.onBehalfOfAgencyId
                        ? ` (viewing as ${agencyName.get(entry.onBehalfOfAgencyId) ?? 'an agency'})`
                        : ''}
                    </td>
                    <td className="py-2">
                      {entry.agencyId ? (agencyName.get(entry.agencyId) ?? '—') : '—'}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      <Detail before={entry.before} after={entry.after} metadata={entry.metadata} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function tryDate(value: string, endOfDay = false): Date | undefined {
  try {
    const date = parseDateOnly(value);
    return endOfDay ? new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1) : date;
  } catch {
    return undefined;
  }
}

/** Before/after and metadata, flattened into something readable at a glance. */
function Detail({
  before,
  after,
  metadata,
}: {
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
}) {
  const parts: string[] = [];

  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])) {
      if (String(beforeRecord[key]) !== String(afterRecord[key])) {
        parts.push(`${key}: ${format(beforeRecord[key])} → ${format(afterRecord[key])}`);
      }
    }
  } else if (after && typeof after === 'object') {
    for (const [key, value] of Object.entries(after as Record<string, unknown>)) {
      parts.push(`${key}: ${format(value)}`);
    }
  }

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      // Ids are for tracing, not for reading on screen.
      if (key.endsWith('Ids') || key === 'fileHash') continue;
      parts.push(`${key}: ${format(value)}`);
    }
  }

  return <span>{parts.join(' · ') || '—'}</span>;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
