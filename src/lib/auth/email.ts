/**
 * Email delivery via Resend.
 *
 * In development, or whenever RESEND_API_KEY is unset, the code is written to the server
 * console instead of being sent — so a local run never depends on a third-party service.
 * Nothing here logs anything about the recipient beyond the address it is mailing.
 */

import { Resend } from 'resend';

import { OTP } from '@/config/validation';

const from = process.env.EMAIL_FROM ?? 'Visa Portal <onboarding@resend.dev>';
const apiKey = process.env.RESEND_API_KEY;

let client: Resend | null = null;
function resend(): Resend | null {
  if (!apiKey) return null;
  client ??= new Resend(apiKey);
  return client;
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const subject = `${code} is your sign-in code`;
  const text = [
    `Your sign-in code is ${code}.`,
    ``,
    `It expires in ${OTP.expiryMinutes} minutes and can only be used once.`,
    `If you did not ask to sign in, you can ignore this email.`,
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">
      <p>Your sign-in code is:</p>
      <p style="font-size:32px;letter-spacing:6px;font-weight:600;margin:24px 0">${code}</p>
      <p style="color:#555">It expires in ${OTP.expiryMinutes} minutes and can only be used once.</p>
      <p style="color:#555">If you did not ask to sign in, you can ignore this email.</p>
    </div>`;

  const mailer = resend();
  if (!mailer) {
    console.info(`[auth] OTP for ${email}: ${code} (email sending is not configured)`);
    return;
  }

  const { error } = await mailer.emails.send({ from, to: email, subject, text, html });
  if (error) throw new Error(`Could not send the sign-in code: ${error.message}`);
}
