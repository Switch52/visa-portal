'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getClientIp, getUserAgent } from '@/lib/auth/current-user';
import { NEUTRAL_MESSAGE, requestOtp, verifyOtp } from '@/lib/auth/otp';
import { SESSION_COOKIE, createSession, sessionCookieOptions } from '@/lib/auth/session';
import { writeAudit } from '@/lib/dal/audit';
import { systemActor } from '@/lib/dal/actor';
import { requestOtpSchema, verifyOtpSchema } from '@/lib/schema/zod';

export interface LoginState {
  step: 'email' | 'code';
  email?: string;
  message?: string;
  error?: string;
}

/**
 * Step one. The response is identical whether or not the address is on the admin's list —
 * same message, same shape, same timing profile as far as the caller can tell — so the
 * login page cannot be used to find out who the clients are.
 */
export async function requestCodeAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = requestOtpSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { step: 'email', error: 'Enter a valid email address.' };
  }

  const ip = await getClientIp();
  const result = await requestOtp(parsed.data.email, ip);

  return {
    step: 'code',
    email: parsed.data.email,
    message: result.retryAfterSeconds
      ? `${NEUTRAL_MESSAGE} If you have asked several times, wait a few minutes before trying again.`
      : result.message,
  };
}

/** Step two. Every failure gives the same message; only the code itself distinguishes. */
export async function verifyCodeAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = verifyOtpSchema.safeParse({
    email: formData.get('email'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return {
      step: 'code',
      email: String(formData.get('email') ?? ''),
      error: 'Enter the 6-digit code from your email.',
    };
  }

  const ip = await getClientIp();
  const result = await verifyOtp(parsed.data.email, parsed.data.code, ip);

  if (!result.ok) {
    const error =
      result.reason === 'expired'
        ? 'That code has expired. Ask for a new one.'
        : result.reason === 'too_many_attempts'
          ? 'Too many attempts. Ask for a new code.'
          : result.reason === 'rate_limited'
            ? 'Too many attempts. Wait a few minutes and try again.'
            : 'That code is not right.';
    return { step: 'code', email: parsed.data.email, error };
  }

  const userAgent = await getUserAgent();
  const session = await createSession(result.userId, { ip, userAgent });

  const store = await cookies();
  store.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

  await writeAudit(systemActor(), {
    action: 'auth.login',
    entity: 'auth',
    entityId: result.userId,
  });

  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    const { revokeSession } = await import('@/lib/auth/session');
    await revokeSession(token);
    await writeAudit(systemActor(), { action: 'auth.logout', entity: 'auth' });
  }
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
