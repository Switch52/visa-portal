/**
 * Email notifications.
 *
 * Two rules hold for everything here:
 *
 *   1. **Sending never breaks the data.** Every send happens after the transaction that
 *      caused it has committed, and every failure is caught and recorded rather than
 *      thrown. An unreachable mail provider must not roll back a booking.
 *   2. **An agency's email describes only that agency's passports** — no names, no
 *      passport numbers, and nothing that could reveal another client exists. What goes in
 *      the body is a count and a status, and a link to look at the rest in the portal.
 */

import { Resend } from 'resend';

import type { ObjectId } from 'mongodb';

import type { Actor } from '@/lib/dal/actor';
import { adminActor } from '@/lib/dal/actor';
import { getAgency } from '@/lib/dal/agencies';
import { writeAudit } from '@/lib/dal/audit';
import { getSetting, setSetting } from '@/lib/dal/settings';
import { listNotificationRecipients } from '@/lib/dal/users';

export type NotificationEvent = 'user.invited' | 'passports.booked';

export interface NotificationSettings {
  'user.invited': boolean;
  'passports.booked': boolean;
  /** Where the portal lives, for the links in an email. */
  appUrl: string;
}

export const NOTIFICATION_SETTINGS_KEY = 'notifications';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  'user.invited': true,
  'passports.booked': true,
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
};

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const stored = await getSetting<Partial<NotificationSettings>>(NOTIFICATION_SETTINGS_KEY);
  return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(stored ?? {}) };
}

export async function saveNotificationSettings(
  actor: Actor,
  value: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const merged = { ...(await getNotificationSettings()), ...value };
  // setSetting does the admin check itself, in the data layer rather than here.
  return setSetting(actor, NOTIFICATION_SETTINGS_KEY, merged);
}

const from = process.env.EMAIL_FROM ?? 'Visa Portal <onboarding@resend.dev>';
let client: Resend | null = null;

function mailer(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  client ??= new Resend(apiKey);
  return client;
}

interface SendResult {
  sent: number;
  skipped: boolean;
  error?: string;
}

/**
 * Deliver one message. Never throws: the caller is usually mid-workflow and the workflow
 * matters more than the email.
 */
async function send(to: string[], subject: string, text: string, html: string): Promise<SendResult> {
  if (to.length === 0) return { sent: 0, skipped: true };

  const resend = mailer();
  if (!resend) {
    // Development, or email simply not configured. Say so once, without the contents.
    console.info(`[notify] "${subject}" → ${to.length} recipient(s) (email sending is not configured)`);
    return { sent: 0, skipped: true };
  }

  try {
    const { error } = await resend.emails.send({ from, to, subject, text, html });
    if (error) return { sent: 0, skipped: false, error: error.message };
    return { sent: to.length, skipped: false };
  } catch (error) {
    return { sent: 0, skipped: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function layout(body: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;line-height:1.5">${body}</div>`;
}

/**
 * Tell an agency their passports now have appointments.
 *
 * Deliberately thin: how many, and a link. Passport numbers and names are not put in an
 * email, which is the least controlled place this data could end up.
 */
export async function notifyPassportsBooked(
  actor: Actor,
  agencyId: ObjectId,
  count: number,
): Promise<SendResult> {
  try {
    const config = await getNotificationSettings();
    if (!config['passports.booked'] || count === 0) return { sent: 0, skipped: true };

    const to = await listNotificationRecipients(agencyId);
    const noun = count === 1 ? 'passport' : 'passports';
    const subject = `${count} ${noun} booked`;
    const link = `${config.appUrl}/passports?status=booked`;

    const text = [
      `${count} of your ${noun} now have confirmed appointments.`,
      ``,
      `See them in the portal: ${link}`,
    ].join('\n');

    const result = await send(
      to,
      subject,
      text,
      layout(
        `<p>${count} of your ${noun} now have confirmed appointments.</p>
         <p><a href="${link}">See them in the portal</a></p>`,
      ),
    );

    await writeAudit(actor, {
      action: 'booking.import',
      entity: 'notification',
      agencyId,
      metadata: { event: 'passports.booked', count, recipients: to.length, error: result.error ?? null },
    });

    return result;
  } catch (error) {
    // A notification failing is not a reason for anything else to fail.
    console.error('[notify] passports.booked failed:', error instanceof Error ? error.message : error);
    return { sent: 0, skipped: false, error: 'Notification failed' };
  }
}

/** Welcome an invited user, so their first contact is not an unexplained OTP. */
export async function notifyUserInvited(
  actor: Actor,
  user: { email: string; name: string; agencyId: ObjectId | null },
): Promise<SendResult> {
  try {
    const config = await getNotificationSettings();
    if (!config['user.invited']) return { sent: 0, skipped: true };

    let agencyName = 'the portal';
    if (user.agencyId) {
      // Read as the acting admin, through the same scoped call every screen uses.
      const reader = actor.role === 'admin' ? actor : adminActor(actor.userId ?? user.agencyId);
      const agency = await getAgency({ ...reader, viewingAsAgencyId: null }, user.agencyId).catch(() => null);
      if (agency) agencyName = agency.name;
    }

    const link = `${config.appUrl}/login`;
    const subject = 'Your access to the passport portal';
    const text = [
      `Hello ${user.name},`,
      ``,
      `You have been given access to the passport portal for ${agencyName}.`,
      ``,
      `There is no password. Go to ${link}, enter this email address, and we will send you a`,
      `6-digit code to sign in with.`,
    ].join('\n');

    const result = await send(
      [user.email],
      subject,
      text,
      layout(
        `<p>Hello ${user.name},</p>
         <p>You have been given access to the passport portal for <strong>${agencyName}</strong>.</p>
         <p>There is no password: go to <a href="${link}">the sign-in page</a>, enter this email
            address, and we will send you a 6-digit code.</p>`,
      ),
    );

    await writeAudit(actor, {
      action: 'user.invite',
      entity: 'notification',
      agencyId: user.agencyId,
      metadata: { event: 'user.invited', recipients: 1, error: result.error ?? null },
    });

    return result;
  } catch (error) {
    console.error('[notify] user.invited failed:', error instanceof Error ? error.message : error);
    return { sent: 0, skipped: false, error: 'Notification failed' };
  }
}
