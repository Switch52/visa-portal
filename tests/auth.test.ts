/**
 * Authorization, now that Clerk owns authentication.
 *
 * The OTP and session rules these tests used to cover are Clerk's problem. What is still
 * ours — and still the part that matters — is everything that decides whether a signed-in
 * person may see anything at all: invitation, linking, deactivation, and view-as.
 *
 * These exercise the layer under `getActor()` rather than mocking Clerk. `getActor()` does
 * exactly two things beyond what is proven here: read a user id from Clerk, and read a
 * cookie. The decisions all live below.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ObjectId } from 'mongodb';

import { resetData, seedFixtures, startTestDb, stopTestDb, type Fixtures, type TestContext } from './helpers/db';

let ctx: TestContext;
let fx: Fixtures;
let users: typeof import('@/lib/dal/users');
let viewAs: typeof import('@/lib/auth/view-as');

before(async () => {
  ctx = await startTestDb();
  users = await import('@/lib/dal/users');
  viewAs = await import('@/lib/auth/view-as');
});

after(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await resetData(ctx.client);
  fx = await seedFixtures(ctx);
});

describe('invite-only', () => {
  it('a Clerk account with no invited record resolves to nobody', async () => {
    const found = await users.findActiveUserByClerkId('user_completely_unknown');
    assert.equal(found, null);
  });

  it('an address that was never invited cannot be linked', async () => {
    const invited = await users.findActiveUserByEmail('nobody@example.com');
    assert.equal(invited, null);
  });

  it('links an invited record on first sign-in, and finds it by Clerk id after', async () => {
    const invited = await users.findActiveUserByEmail('admin@example.com');
    assert.ok(invited);

    const linked = await users.linkClerkIdentity(invited._id, 'user_clerk_admin');
    assert.ok(linked);
    assert.equal(linked.clerkUserId, 'user_clerk_admin');

    const again = await users.findActiveUserByClerkId('user_clerk_admin');
    assert.ok(again);
    assert.equal(again._id.toHexString(), invited._id.toHexString());
  });

  it('a second Clerk account cannot take over a record that is already linked', async () => {
    const invited = await users.findActiveUserByEmail('admin@example.com');
    assert.ok(invited);

    await users.linkClerkIdentity(invited._id, 'user_the_real_one');
    const stolen = await users.linkClerkIdentity(invited._id, 'user_the_impostor');

    assert.equal(stolen, null, 'the second link must be refused');

    const still = await users.findActiveUserByClerkId('user_the_real_one');
    assert.ok(still);
    const impostor = await users.findActiveUserByClerkId('user_the_impostor');
    assert.equal(impostor, null);
  });

  it('one Clerk identity cannot be attached to two different records', async () => {
    const admin = await users.findActiveUserByEmail('admin@example.com');
    assert.ok(admin);
    await users.linkClerkIdentity(admin._id, 'user_shared');

    // The unique partial index is the backstop, not the application check.
    await assert.rejects(
      async () => {
        const collection = await ctx.collections.users();
        await collection.updateOne({ _id: fx.userA }, { $set: { clerkUserId: 'user_shared' } });
      },
      /duplicate key/i,
    );
  });
});

describe('deactivation', () => {
  it('takes effect immediately, without waiting for a token to expire', async () => {
    const invited = await users.findActiveUserByEmail('admin@example.com');
    assert.ok(invited);
    await users.linkClerkIdentity(invited._id, 'user_to_be_disabled');

    assert.ok(await users.findActiveUserByClerkId('user_to_be_disabled'));

    const collection = await ctx.collections.users();
    await collection.updateOne({ _id: invited._id }, { $set: { active: false } });

    assert.equal(
      await users.findActiveUserByClerkId('user_to_be_disabled'),
      null,
      'the very next request must resolve to nobody',
    );
  });

  it('a deactivated record cannot be linked in the first place', async () => {
    const collection = await ctx.collections.users();
    await collection.updateOne({ _id: fx.userA }, { $set: { active: false } });

    const linked = await users.linkClerkIdentity(fx.userA, 'user_disabled_signup');
    assert.equal(linked, null);
  });
});

describe('view-as', () => {
  it('survives a round trip for an admin', () => {
    const agencyId = new ObjectId();
    const cookie = viewAs.encodeViewAs(agencyId);
    const decoded = viewAs.decodeViewAs(cookie, 'admin');

    assert.ok(decoded);
    assert.equal(decoded.toHexString(), agencyId.toHexString());
  });

  it('is ignored for anyone who is not an admin', () => {
    const cookie = viewAs.encodeViewAs(new ObjectId());

    assert.equal(viewAs.decodeViewAs(cookie, 'agency'), null);
    assert.equal(viewAs.decodeViewAs(cookie, 'system'), null);
  });

  it('refuses a tampered agency id', () => {
    const cookie = viewAs.encodeViewAs(new ObjectId());
    const [, signature] = cookie.split('.');

    // Someone swaps in another agency and keeps the signature they were given.
    const forged = `${new ObjectId().toHexString()}.${signature}`;
    assert.equal(viewAs.decodeViewAs(forged, 'admin'), null);
  });

  it('refuses an unsigned or malformed value', () => {
    assert.equal(viewAs.decodeViewAs(new ObjectId().toHexString(), 'admin'), null);
    assert.equal(viewAs.decodeViewAs('nonsense', 'admin'), null);
    assert.equal(viewAs.decodeViewAs('', 'admin'), null);
    assert.equal(viewAs.decodeViewAs(undefined, 'admin'), null);
  });
});
