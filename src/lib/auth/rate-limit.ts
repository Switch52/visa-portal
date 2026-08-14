/**
 * Fixed-window rate limiting, counted separately per email and per client IP.
 *
 * The counter is a single upserted document keyed by scope, so a burst of concurrent
 * requests increments one atomic value rather than racing. Windows expire on their own
 * via the TTL index from migration 001.
 */

import { rateLimits } from '@/lib/db/collections';

export interface RateLimitRule {
  readonly max: number;
  readonly windowMinutes: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const now = new Date();
  const windowMs = rule.windowMinutes * 60_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  const id = `${key}:${windowStart.getTime()}`;

  const collection = await rateLimits();
  const doc = await collection.findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { windowStart, expiresAt },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const count = doc?.count ?? 1;
  return {
    allowed: count <= rule.max,
    remaining: Math.max(0, rule.max - count),
    retryAfterSeconds: Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
  };
}

/** Used by tests and by the admin tooling; never exposed to an unauthenticated caller. */
export async function clearRateLimits(): Promise<void> {
  const collection = await rateLimits();
  await collection.deleteMany({});
}
