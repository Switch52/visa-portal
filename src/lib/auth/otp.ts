/**
 * Email OTP: request and verify.
 *
 * Invite-only is enforced here. If the email is not on the admin's list, no code is sent
 * and no account is created — and the caller gets exactly the same answer as a known
 * address, so the login page cannot be used to discover who the clients are.
 */

import type { ObjectId } from 'mongodb';

import { OTP } from '@/config/validation';
import { otps } from '@/lib/db/collections';
import { addMinutes } from '@/lib/dates';
import { findActiveUserByEmail, recordLogin } from '@/lib/dal/users';
import { writeAudit } from '@/lib/dal/audit';
import { systemActor } from '@/lib/dal/actor';

import { generateOtpCode, hashIp, hashSecret, safeEqual } from './crypto';
import { sendOtpEmail } from './email';
import { consumeRateLimit } from './rate-limit';

/** The same shape comes back whether or not the email exists. */
export interface RequestOtpResult {
  /** Always the neutral message. Never varies by whether the address is known. */
  message: string;
  retryAfterSeconds?: number;
}

export const NEUTRAL_MESSAGE = "If that email is registered, we've sent a code.";

export async function requestOtp(email: string, ip: string | null): Promise<RequestOtpResult> {
  const emailRate = await consumeRateLimit(`otp:email:${email}`, OTP.perEmail);
  const ipRate = ip ? await consumeRateLimit(`otp:ip:${ip}`, OTP.perIp) : { allowed: true, retryAfterSeconds: 0 };

  if (!emailRate.allowed || !ipRate.allowed) {
    return {
      message: NEUTRAL_MESSAGE,
      retryAfterSeconds: Math.max(emailRate.retryAfterSeconds, ipRate.retryAfterSeconds ?? 0),
    };
  }

  const user = await findActiveUserByEmail(email);
  if (!user) {
    // No code, no account, no hint. Recorded so a probe is visible to the admin later.
    await writeAudit(systemActor(), {
      action: 'auth.blocked_unknown_email',
      entity: 'auth',
      metadata: { ipHash: hashIp(ip) },
    });
    return { message: NEUTRAL_MESSAGE };
  }

  const collection = await otps();
  const now = new Date();

  // Any earlier code for this address stops working the moment a new one is issued.
  await collection.updateMany(
    { emailNormalized: user.emailNormalized, consumedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: now } },
  );

  const code = generateOtpCode();
  await collection.insertOne({
    emailNormalized: user.emailNormalized,
    codeHash: hashSecret(code),
    createdAt: now,
    expiresAt: addMinutes(now, OTP.expiryMinutes),
    attempts: 0,
    consumedAt: null,
    invalidatedAt: null,
    ipHash: hashIp(ip),
  } as never);

  await sendOtpEmail(user.email, code);
  await writeAudit(systemActor(), {
    action: 'auth.otp_requested',
    entity: 'auth',
    entityId: user._id,
    agencyId: user.agencyId,
  });

  return { message: NEUTRAL_MESSAGE };
}

export type VerifyOtpResult =
  | { ok: true; userId: ObjectId }
  | { ok: false; reason: 'invalid' | 'expired' | 'too_many_attempts' | 'rate_limited' };

/**
 * Verify a code. Single-use, expiring, attempt-capped, and compared in constant time.
 *
 * Every failure returns the same generic reason to the caller above, so a wrong code and
 * an unknown email are indistinguishable from outside.
 */
export async function verifyOtp(email: string, code: string, ip: string | null): Promise<VerifyOtpResult> {
  // Capped per address and per source, so neither a single account nor a single host can
  // be used to walk the 6-digit space.
  const emailRate = await consumeRateLimit(`otp:verify:${email}`, OTP.perEmail);
  const ipRate = ip ? await consumeRateLimit(`otp:verify:ip:${ip}`, OTP.perIp) : { allowed: true };
  if (!emailRate.allowed || !ipRate.allowed) return { ok: false, reason: 'rate_limited' };

  const user = await findActiveUserByEmail(email);
  if (!user) return { ok: false, reason: 'invalid' };

  const collection = await otps();
  const record = await collection.findOne(
    { emailNormalized: user.emailNormalized, consumedAt: null, invalidatedAt: null },
    { sort: { createdAt: -1 } },
  );
  if (!record) return { ok: false, reason: 'invalid' };

  if (record.expiresAt <= new Date()) {
    await collection.updateOne({ _id: record._id }, { $set: { invalidatedAt: new Date() } });
    return { ok: false, reason: 'expired' };
  }

  if (record.attempts >= OTP.maxAttempts) {
    await collection.updateOne({ _id: record._id }, { $set: { invalidatedAt: new Date() } });
    return { ok: false, reason: 'too_many_attempts' };
  }

  const matches = safeEqual(record.codeHash, hashSecret(code));
  if (!matches) {
    const after = await collection.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    // Five wrong guesses invalidate the code outright, rather than leaving it open.
    if (after && after.attempts >= OTP.maxAttempts) {
      await collection.updateOne({ _id: record._id }, { $set: { invalidatedAt: new Date() } });
    }
    await writeAudit(systemActor(), {
      action: 'auth.otp_failed',
      entity: 'auth',
      entityId: user._id,
      agencyId: user.agencyId,
    });
    return { ok: false, reason: 'invalid' };
  }

  // Single-use: the same code cannot be redeemed twice, even by a double-submit. The
  // guard on consumedAt makes the second caller lose rather than get a second session.
  const consumed = await collection.findOneAndUpdate(
    { _id: record._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!consumed) return { ok: false, reason: 'invalid' };

  await recordLogin(user._id);
  return { ok: true, userId: user._id };
}
