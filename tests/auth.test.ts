/**
 * The OTP rules, exactly as specified: invite-only, 6 digits, 10-minute expiry,
 * single-use, five attempts, rate-limited, stored hashed.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;
let otp: typeof import('@/lib/auth/otp');
let session: typeof import('@/lib/auth/session');
let crypto: typeof import('@/lib/auth/crypto');

before(async () => {
  ctx = await startTestDb();
  otp = await import('@/lib/auth/otp');
  session = await import('@/lib/auth/session');
  crypto = await import('@/lib/auth/crypto');
});

after(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await resetData(ctx.client);
  fx = await seedFixtures(ctx);
});

/**
 * Recover the issued code by hashing the 6-digit space against the stored digest.
 *
 * A test cannot read it any other way, which is the point: the plaintext genuinely is not
 * stored. The hash is read once and compared in memory, so this stays a fraction of a
 * second rather than a million round trips.
 */
async function findCode(email: string): Promise<string> {
  const collection = await ctx.collections.otps();
  const record = await collection.findOne(
    { emailNormalized: email, consumedAt: null, invalidatedAt: null },
    { sort: { createdAt: -1 } },
  );
  if (!record) throw new Error('No code was issued');

  for (let i = 0; i < 1_000_000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (crypto.hashSecret(candidate) === record.codeHash) return candidate;
  }
  throw new Error('No issued code matched');
}

describe('invite-only', () => {
  it('sends nothing and creates nothing for an email that is not on the list', async () => {
    const result = await otp.requestOtp('stranger@example.com', '203.0.113.1');
    assert.equal(result.message, otp.NEUTRAL_MESSAGE);

    const otpCollection = await ctx.collections.otps();
    assert.equal(await otpCollection.countDocuments({}), 0);

    const users = await ctx.collections.users();
    assert.equal(await users.countDocuments({ emailNormalized: 'stranger@example.com' }), 0);
  });

  it('gives a known and an unknown address the same answer', async () => {
    const known = await otp.requestOtp('a@example.com', '203.0.113.1');
    const unknown = await otp.requestOtp('nobody@example.com', '203.0.113.2');
    assert.deepEqual(known, unknown);
  });

  it('records the probe so it is visible later, without leaking it to the caller', async () => {
    await otp.requestOtp('stranger@example.com', '203.0.113.1');
    const audit = await ctx.collections.auditLog();
    const entry = await audit.findOne({ action: 'auth.blocked_unknown_email' });
    assert.ok(entry);
  });
});

describe('otp codes', () => {
  it('is six digits, stored hashed, and never in plaintext', async () => {
    await otp.requestOtp('a@example.com', null);

    const collection = await ctx.collections.otps();
    const record = await collection.findOne({ emailNormalized: 'a@example.com' });
    assert.ok(record);
    assert.equal(record.attempts, 0);
    assert.equal(record.codeHash.length, 64); // sha-256 hex
    assert.equal('code' in record, false);

    const code = await findCode('a@example.com');
    assert.match(code, /^\d{6}$/);
    assert.notEqual(record.codeHash, code);
    assert.equal(record.codeHash, crypto.hashSecret(code));
  });

  it('expires ten minutes after it is issued', async () => {
    await otp.requestOtp('a@example.com', null);
    const collection = await ctx.collections.otps();
    const record = await collection.findOne({ emailNormalized: 'a@example.com' });
    const minutes = (record!.expiresAt.getTime() - record!.createdAt.getTime()) / 60_000;
    assert.equal(minutes, 10);
  });

  it('accepts a valid code once, and refuses the same code a second time', async () => {
    await otp.requestOtp('a@example.com', null);
    const code = await findCode('a@example.com');

    const first = await otp.verifyOtp('a@example.com', code, null);
    assert.equal(first.ok, true);

    const second = await otp.verifyOtp('a@example.com', code, null);
    assert.equal(second.ok, false);
  });

  it('refuses an expired code', async () => {
    await otp.requestOtp('a@example.com', null);
    const code = await findCode('a@example.com');

    const collection = await ctx.collections.otps();
    await collection.updateOne(
      { emailNormalized: 'a@example.com' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const result = await otp.verifyOtp('a@example.com', code, null);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'expired');
  });

  it('invalidates the code after five wrong attempts', async () => {
    await otp.requestOtp('a@example.com', null);
    const code = await findCode('a@example.com');
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      const attempt = await otp.verifyOtp('a@example.com', wrong, null);
      assert.equal(attempt.ok, false);
    }

    // Even the right code is dead once the attempts are used up.
    const afterwards = await otp.verifyOtp('a@example.com', code, null);
    assert.equal(afterwards.ok, false);
  });

  it('issuing a new code kills the previous one', async () => {
    await otp.requestOtp('a@example.com', null);
    const first = await findCode('a@example.com');

    await otp.requestOtp('a@example.com', null);
    const result = await otp.verifyOtp('a@example.com', first, null);
    assert.equal(result.ok, false);
  });

  it('rate-limits repeated requests for the same address', async () => {
    const results = [];
    for (let i = 0; i < 7; i += 1) {
      results.push(await otp.requestOtp('a@example.com', '203.0.113.9'));
    }
    // The message never changes — only the number of codes actually issued does.
    assert.ok(results.every((r) => r.message === otp.NEUTRAL_MESSAGE));

    const collection = await ctx.collections.otps();
    const issued = await collection.countDocuments({ emailNormalized: 'a@example.com' });
    assert.ok(issued <= 5, `expected at most 5 codes to be issued, got ${issued}`);
  });
});

describe('sessions', () => {
  it('stores only a hash of the token', async () => {
    const created = await session.createSession(fx.userA);
    const collection = await ctx.collections.sessions();
    const doc = await collection.findOne({ userId: fx.userA });

    assert.ok(doc);
    assert.notEqual(doc.tokenHash, created.token);
    assert.equal(doc.tokenHash, crypto.hashSecret(created.token));
  });

  it('resolves to an actor scoped to that user’s agency', async () => {
    const created = await session.createSession(fx.userA);
    const resolved = await session.resolveSession(created.token);

    assert.ok(resolved);
    assert.equal(resolved.actor.role, 'agency');
    assert.equal(resolved.actor.agencyId?.toHexString(), fx.agencyA.toHexString());
  });

  it('dies the moment the user is deactivated', async () => {
    const created = await session.createSession(fx.userA);
    assert.ok(await session.resolveSession(created.token));

    await ctx.dal.setUserActive(ctx.actor.adminActor(fx.adminId), fx.userA, false);

    assert.equal(await session.resolveSession(created.token), null);
  });

  it('a made-up token resolves to nobody', async () => {
    assert.equal(await session.resolveSession('not-a-real-token'), null);
    assert.equal(await session.resolveSession(undefined), null);
  });

  it('view-as is recorded on the session, and only for an admin', async () => {
    const adminSession = await session.createSession(fx.adminId);
    const resolved = await session.resolveSession(adminSession.token);
    await session.startViewAs(resolved!.sessionId, fx.agencyA);

    const viewing = await session.resolveSession(adminSession.token);
    assert.equal(viewing!.actor.viewingAsAgencyId?.toHexString(), fx.agencyA.toHexString());

    await session.endViewAs(resolved!.sessionId);
    const back = await session.resolveSession(adminSession.token);
    assert.equal(back!.actor.viewingAsAgencyId, null);
  });

  it('an agency user cannot be put into a view-as session', async () => {
    const agencySession = await session.createSession(fx.userA);
    const resolved = await session.resolveSession(agencySession.token);
    await session.startViewAs(resolved!.sessionId, new ObjectId());

    const again = await session.resolveSession(agencySession.token);
    assert.equal(again!.actor.viewingAsAgencyId, null);
  });
});
