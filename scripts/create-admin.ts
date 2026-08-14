/**
 * Bootstrap the first administrator.
 *
 * Access is invite-only and only the admin can invite, which leaves a chicken-and-egg
 * problem for the very first account. This script is the only way to create one without
 * an existing admin, and it runs against the database directly, never over the web.
 *
 *   npm run create-admin -- --email you@example.com --name "Your Name"
 */

import { normalizeEmail } from '@/config/validation';
import { getMongoClient } from '@/lib/mongodb';
import { users } from '@/lib/db/collections';
import { writeAudit } from '@/lib/dal/audit';
import { systemActor } from '@/lib/dal/actor';

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const email = arg('--email');
  const name = arg('--name');

  if (!email || !name) {
    throw new Error('Usage: npm run create-admin -- --email you@example.com --name "Your Name"');
  }

  const collection = await users();
  const emailNormalized = normalizeEmail(email);
  const existing = await collection.findOne({ emailNormalized });

  if (existing) {
    if (existing.role === 'admin') {
      console.log(`${email} is already an administrator.`);
      return;
    }
    throw new Error(`${email} already exists as an agency user. Remove it first, or use another address.`);
  }

  const now = new Date();
  const result = await collection.insertOne({
    name,
    email: email.trim(),
    emailNormalized,
    role: 'admin',
    agencyId: null,
    active: true,
    lastLoginAt: null,
    invitedBy: null,
    invitedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } as never);

  await writeAudit(systemActor(), {
    action: 'user.invite',
    entity: 'user',
    entityId: result.insertedId,
    metadata: { bootstrap: true, role: 'admin' },
  });

  console.log(`Created administrator ${email}. Sign in at /login — a code will be emailed.`);
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
