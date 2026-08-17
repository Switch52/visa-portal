/**
 * The one place that opens a MongoDB connection.
 *
 * Serverless functions would otherwise exhaust an M0 cluster's connection limit: every
 * invocation gets its own module scope, but the Node process is reused between them, so
 * the client promise is cached on `globalThis` and shared. In development it also
 * survives hot reloads, which would otherwise leak a client per save.
 *
 * Nothing outside `src/lib/db` and `migrations/` may import this module — the ESLint
 * config enforces that, so every read and write has to go through the scoped
 * data-access layer instead.
 */

import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'visa_portal';

const options: MongoClientOptions = {
  // M0 allows 500 connections across the whole cluster; a handful per instance is plenty.
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 10_000,
  retryWrites: true,
};

declare global {
  var __visaPortalMongoClient: Promise<MongoClient> | undefined;
}

function connect(): Promise<MongoClient> {
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. On a laptop: copy .env.example to .env.local and fill it in. ' +
        'In a container: it is supplied at run time, from a .env beside docker-compose.yml ' +
        'or the host\'s environment panel — never as a build argument.',
    );
  }
  return new MongoClient(uri, options).connect();
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalThis.__visaPortalMongoClient) {
    globalThis.__visaPortalMongoClient = connect();
  }
  return globalThis.__visaPortalMongoClient;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(dbName);
}

/** Tests and migration scripts point the cache at their own client. */
export function __setMongoClientForTesting(client: Promise<MongoClient> | undefined): void {
  globalThis.__visaPortalMongoClient = client;
}

export function getDbName(): string {
  return dbName;
}
