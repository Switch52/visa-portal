/**
 * Migration runner. Schema changes are numbered scripts, committed to the repo and
 * runnable forward — never ad-hoc edits in the Atlas console.
 *
 * Usage:
 *   npm run migrate            apply everything not yet applied
 *   npm run migrate -- --status  show what has run
 *   npm run migrate -- --down 001_initial_collections
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Db } from 'mongodb';

import { getDb, getMongoClient, getDbName } from '@/lib/mongodb';

interface Migration {
  id: string;
  description: string;
  up: (db: Db) => Promise<void>;
  down?: (db: Db) => Promise<void>;
}

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const LEDGER = 'migrations';

async function loadMigrations(): Promise<Migration[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.ts$/.test(f))
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href)) as Migration;
    if (!mod.id || typeof mod.up !== 'function') {
      throw new Error(`${file} does not export an id and an up() function.`);
    }
    migrations.push(mod);
  }
  return migrations;
}

async function applied(db: Db): Promise<Set<string>> {
  const rows = await db.collection(LEDGER).find({}, { projection: { _id: 1 } }).toArray();
  return new Set(rows.map((r) => String(r._id)));
}

async function main(): Promise<void> {
  const db = await getDb();
  const migrations = await loadMigrations();
  const done = await applied(db);

  const downTarget = process.argv.includes('--down') ? process.argv[process.argv.indexOf('--down') + 1] : null;

  if (process.argv.includes('--status')) {
    console.log(`Database: ${getDbName()}`);
    for (const m of migrations) {
      console.log(`  [${done.has(m.id) ? 'x' : ' '}] ${m.id} — ${m.description}`);
    }
    return;
  }

  if (downTarget) {
    const migration = migrations.find((m) => m.id === downTarget);
    if (!migration?.down) throw new Error(`No reversible migration named ${downTarget}.`);
    console.log(`Reverting ${migration.id} …`);
    await migration.down(db);
    await db.collection(LEDGER).deleteOne({ _id: migration.id as never });
    console.log('Reverted.');
    return;
  }

  const pending = migrations.filter((m) => !done.has(m.id));
  if (pending.length === 0) {
    console.log('Nothing to apply — the database is up to date.');
    return;
  }

  for (const migration of pending) {
    console.log(`Applying ${migration.id} — ${migration.description}`);
    await migration.up(db);
    await db.collection(LEDGER).insertOne({
      _id: migration.id as never,
      description: migration.description,
      appliedAt: new Date(),
    });
  }
  console.log(`Applied ${pending.length} migration(s) to ${getDbName()}.`);
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
