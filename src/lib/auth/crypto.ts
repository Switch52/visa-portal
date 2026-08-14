/**
 * Hashing and comparison for anything secret: OTP codes, session tokens, and the IP
 * addresses we rate-limit on.
 *
 * Codes and tokens are stored hashed and compared in constant time, so a timing signal
 * cannot leak a valid code, and a leaked database dump cannot be replayed.
 */

import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';

import { OTP } from '@/config/validation';

function pepper(): string {
  // Optional: raises the cost of a stolen database on its own. Absent in development.
  return process.env.AUTH_SECRET ?? '';
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(`${pepper()}:${value}`).digest('hex');
}

/** Compare two hex digests without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the failure takes the same shape.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** A 6-digit code from a cryptographic source — never Math.random. */
export function generateOtpCode(): string {
  const max = 10 ** OTP.length;
  return String(randomInt(0, max)).padStart(OTP.length, '0');
}

/** Opaque session token. 256 bits, so it cannot be guessed or enumerated. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** IPs are hashed before storage: we rate-limit on them, we do not keep them. */
export function hashIp(ip: string | null | undefined): string | null {
  return ip ? hashSecret(`ip:${ip}`) : null;
}
