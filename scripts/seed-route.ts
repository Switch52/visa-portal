/**
 * Create a route from the command line.
 *
 * The admin screen does the same job; this exists so a deploy — production, staging, or a
 * scratch database for a migration dry run — can be brought up the same way every time
 * rather than by remembering to click through a form.
 *
 * Idempotent: the route triple is unique, so running it twice reports the existing route
 * instead of creating a second one or failing.
 *
 *   npm run seed-route -- --origin EGY --destination GRC --center "VFS Cairo" --fee 60 --currency USD
 */

import { ObjectId } from 'mongodb';

import { getMongoClient } from '@/lib/mongodb';
import { users } from '@/lib/db/collections';
import { adminActor } from '@/lib/dal/actor';
import { createRoute, listRoutes } from '@/lib/dal/routes';
import { ValidationError } from '@/lib/dal/errors';
import { parseMoneyInput, formatMoney } from '@/lib/money';

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const origin = arg('--origin') ?? 'EGY';
  const destination = arg('--destination') ?? 'GRC';
  const center = arg('--center');
  const fee = arg('--fee');
  const currency = arg('--currency') ?? 'USD';
  // A route can be set up before it opens — Alexandria today. It exists, carries a price,
  // and is offered to nobody until it is made active.
  const active = !process.argv.includes('--inactive');

  if (!center || !fee) {
    throw new Error(
      'Usage: npm run seed-route -- --origin EGY --destination GRC --center "Greece Cairo" --fee 60 --currency USD [--inactive]\n' +
        'The appointment center is part of what makes a route unique, so it cannot be guessed.',
    );
  }

  // Acts as the first admin on record, so the route carries a real actor in its audit entry.
  const userCollection = await users();
  const admin = await userCollection.findOne({ role: 'admin', active: true });
  const actor = adminActor(admin?._id ?? new ObjectId());
  if (!admin) {
    console.warn('No administrator exists yet — the audit entry will have no actor behind it.');
  }

  const amount = parseMoneyInput(fee, currency);

  try {
    const route = await createRoute(actor, {
      originCountry: origin,
      destinationCountry: destination,
      appointmentCenter: center,
      feeMinor: amount.amountMinor,
      feeCurrency: amount.currency,
      active,
    });

    console.log(
      `Created: ${route.displayLabel} at ${formatMoney(amount)}${active ? '' : ' — not active yet'}`,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      // Already there. Say which one, rather than failing a repeated deploy.
      const existing = (await listRoutes(actor)).find(
        (route) =>
          route.originCountry === origin.toUpperCase() &&
          route.destinationCountry === destination.toUpperCase() &&
          route.appointmentCenter.toLowerCase() === center.toLowerCase(),
      );
      if (existing) {
        console.log(
          `Already exists: ${existing.displayLabel} at ${formatMoney({
            amountMinor: existing.feeMinor,
            currency: existing.feeCurrency,
          })}. Nothing changed.`,
        );
        console.log('Change the fee on the Routes screen — it applies to future charges only.');
        return;
      }
    }
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const client = await getMongoClient().catch(() => null);
    await client?.close();
  });
