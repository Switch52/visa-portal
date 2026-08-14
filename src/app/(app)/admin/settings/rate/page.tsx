import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/current-user';
import { getDisplayRate } from '@/lib/dal/settings';

import { RateForm } from './rate-form';

/**
 * The one conversion rate in the system, maintained by hand.
 *
 * It exists because the old payments sheet showed every amount twice — in USD and in EGP —
 * and that habit is worth keeping. What it is not is part of the ledger: figures computed
 * from it are indicative, labelled as such, never stored on a charge or a payment, never
 * used to settle anything, and never the basis of a balance. Change it and only the
 * display changes; no ledger entry moves.
 */
export default async function RateSettingsPage() {
  await requireAdmin();
  const rate = await getDisplayRate();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Display exchange rate</h1>
        <p className="text-sm text-muted-foreground">
          Used only to show an indicative {rate.quote} figure beside a {rate.base} amount.
        </p>
      </div>

      <RateForm rate={rate} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What this rate does not do</CardTitle>
          <CardDescription>
            It never converts a payment, never settles a charge in another currency, and never
            produces a combined balance. A payment settles charges in its own currency only — the
            portal refuses anything else rather than applying a rate nobody agreed.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Stored truth is always the original currency and amount.
        </CardContent>
      </Card>
    </div>
  );
}
