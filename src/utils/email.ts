import nodemailer from 'nodemailer';
import { env } from '../config/env';

/**
 * Gmail SMTP transporter (via nodemailer) — chosen instead of a dedicated
 * transactional email provider (Resend/SendGrid) because those require
 * verifying a domain you own before they'll deliver to arbitrary recipients.
 * Since this project runs on free-tier Vercel/Render with no custom domain,
 * Gmail SMTP is the only zero-cost option that can actually reach real
 * customer inboxes — it only needs a Gmail account + an App Password.
 *
 * Created lazily (not at import time) so the server doesn't crash on boot
 * if GMAIL_USER/GMAIL_APP_PASSWORD aren't set yet — it only throws when a
 * forgot-password request actually comes in.
 */
let transporter: nodemailer.Transporter | null = null;

const getTransporter = (): nodemailer.Transporter => {
  if (transporter) return transporter;

  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    throw new Error(
      'Email is not configured — set GMAIL_USER and GMAIL_APP_PASSWORD in environment variables.'
    );
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: env.GMAIL_USER,
      pass: env.GMAIL_APP_PASSWORD, // 16-character App Password, NOT the normal Gmail password
    },
  });

  return transporter;
};

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

const sendEmail = async ({ to, subject, html }: SendEmailInput): Promise<void> => {
  try {
    await getTransporter().sendMail({
      from: `Mailzeon <${env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    // Log the real reason for Render logs, but never leak SMTP internals to
    // the user — forgotPassword() always responds with the same generic
    // message regardless of email delivery outcome.
    console.error('Gmail SMTP send failed:', (err as Error).message);
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
