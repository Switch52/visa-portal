import { ObjectId } from 'mongodb';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BalanceSummary } from '@/components/balance-summary';
import { LedgerTable } from '@/components/ledger-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { STATUS_LABELS, type PassportStatus } from '@/config/statuses';
import { requireAdmin } from '@/lib/auth/current-user';
import { getAgency } from '@/lib/dal/agencies';
import { NotFoundError } from '@/lib/dal/errors';
import { getAgencyBalance, getLedger } from '@/lib/dal/ledger';
import { countByStatus } from '@/lib/dal/passports';

async function load(actor: Awaited<ReturnType<typeof requireAdmin>>, id: string) {
  const agencyId = new ObjectId(id);
  try {
    return await Promise.all([
      getAgency(actor, agencyId),
      getAgencyBalance(actor, agencyId),
      getLedger(actor, agencyId),
      countByStatus(actor, { agencyId }),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/** One agency: what they have submitted, what they owe, and every line behind it. */
export default async function AgencyDetailPage(props: PageProps<'/admin/agencies/[id]'>) {
  const actor = await requireAdmin();
  const { id } = await props.params;
  if (!ObjectId.isValid(id)) notFound();

  const [agency, balances, ledger, byStatus] = await load(actor, id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{agency.name}</h1>
          <p className="text-sm text-muted-foreground">
            {agency.contactName ?? 'No contact name'}
            {agency.contactEmail ? ` · ${agency.contactEmail}` : ''} · default currency{' '}
            {agency.defaultCurrency}
          </p>
        </div>
        <Link href="/admin/agencies" className="text-sm underline">
          All agencies
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Balance</CardTitle>
          <CardDescription>Charges minus payments, per currency.</CardDescription>
        </CardHeader>
        <CardContent>
          <BalanceSummary balances={balances} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Passports</CardTitle>
          <CardDescription>
            {Object.entries(byStatus)
              .map(([status, count]) => `${count} ${STATUS_LABELS[status as PassportStatus].toLowerCase()}`)
              .join(' · ') || 'None submitted yet'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/admin/passports?agency=${agency.id}`} className="text-sm underline">
            See their passports
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ledger</CardTitle>
          <CardDescription>
            Every charge, payment, credit and opening balance, newest first. Each charge ties back to
            a specific passport, booking and fee.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LedgerTable lines={ledger} showPassportLinks />
        </CardContent>
      </Card>
    </div>
  );
}
