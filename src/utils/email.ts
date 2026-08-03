import { env } from '../config/env';

/**
 * Brevo (formerly Sendinblue) transactional email API — sends over HTTPS,
 * not SMTP. This matters because Render's free web-service tier blocks
 * outbound traffic to SMTP ports 25/465/587 (since Sept 2025), which is
 * exactly why a Gmail-SMTP-via-nodemailer approach silently times out on
 * this project's hosting. Brevo's REST API is unaffected since it's just
 * a normal HTTPS POST request, same as any other external API call we make
 * (e.g. Cashfree in payment.service.ts).
 *
 * Brevo also only requires a single verified SENDER email (Brevo dashboard →
 * Senders → Add a Sender), not a verified domain — which fits a zero-domain
 * setup. Free tier: 300 emails/day, sent to any recipient once the sender
 * email is verified.
 */
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

const sendEmail = async ({ to, subject, html }: SendEmailInput): Promise<void> => {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
    throw new Error(
      'Email is not configured — set BREVO_API_KEY and BREVO_SENDER_EMAIL in environment variables.'
    );
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Mailzeon', email: env.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    // Log the real reason for Render logs, but never leak provider internals
    // to the user — forgotPassword() always responds with the same generic
    // message regardless of email delivery outcome.
    const body = await res.text().catch(() => '');
    console.error(`Brevo email failed (${res.status}):`, body);
    throw new Error('Failed to send email.');
  }
};

/**
 * Sends the "reset your password" email with a link back to the frontend.
 * The raw (unhashed) token is only ever sent here, in the URL — it is never
 * stored in the database, only its SHA-256 hash is (see auth.service.ts).
 */
export const sendPasswordResetEmail = async (to: string, rawToken: string): Promise<void> => {
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;

  await sendEmail({
    to,
    subject: 'Reset your Mailzeon password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111;">Reset your password</h2>
        <p style="color: #444; font-size: 15px; line-height: 1.5;">
          We received a request to reset the password for your Mailzeon account.
          Click the button below to choose a new password. This link expires in
          <strong>30 minutes</strong>.
        </p>
        <a href="${resetUrl}"
           style="display: inline-block; margin: 20px 0; padding: 12px 24px; background: #7c3aed;
                  color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Reset Password
        </a>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          If you didn't request this, you can safely ignore this email — your
          password will remain unchanged.
        </p>
        <p style="color: #aaa; font-size: 12px; margin-top: 24px;">
          Or paste this link into your browser:<br/>${resetUrl}
        </p>
      </div>
    `,
  });
};

/**
 * NEW: mirrors every in-app notification to the user's registered email —
 * called from notificationService.create() so every notification, from any
 * trigger in the app, also lands in their inbox, not just the bell icon.
 */
export const sendNotificationEmail = async (to: string, title: string, message: string): Promise<void> => {
  await sendEmail({
    to,
    subject: title || 'New notification from Mailzeon',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 4px;">${title}</h2>
        <p style="color: #444; font-size: 15px; line-height: 1.5;">${message}</p>
        <a href="${env.FRONTEND_URL}/login"
           style="display: inline-block; margin: 20px 0; padding: 10px 20px; background: #7c3aed;
                  color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
          Open Mailzeon
        </a>
        <p style="color: #aaa; font-size: 12px; margin-top: 16px;">
          You're receiving this because it happened on your Mailzeon account.
        </p>
      </div>
    `,
  });
};
