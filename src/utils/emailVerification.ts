import { env } from '../config/env';

export type EmailCheckResult = 'valid' | 'invalid' | 'unknown';

/**
 * Checks whether a specific email address currently exists, using Email
 * Awesome's (emailawesome.com) SMTP-level verification API.
 *
 * Why this exists: a worker can accept a CUSTOM-email order (which reveals
 * the exact requested address), quietly go create that account for
 * themselves outside the platform, and just let the 10-minute credential
 * timer expire — the order silently returns to the marketplace for someone
 * else, and the worker keeps the account they "stole." This is the check
 * that catches that: if the requested address now exists right after the
 * timer expires, that's strong evidence of exactly this. See
 * order.service.ts handleAcceptTimerExpiry() for where this gets used, and
 * user.service.ts applyTheftPenalty() for the consequence.
 *
 * IMPORTANT — verify against the real API before relying on this in
 * production: the request shape below (GET, Bearer auth, a `status` field
 * of VALID/INVALID/UNKNOWN) is Email Awesome's standard documented
 * single-verification pattern, but if your dashboard's API key page shows
 * a different exact URL or header name, this is the ONLY function that
 * needs updating — nothing else in the codebase depends on the specifics.
 * Easiest way to confirm: open the "Single Verifications" page in your
 * Email Awesome dashboard, open your browser's Network tab, verify any
 * email, and compare the actual request against what's below.
 */
export async function checkEmailExists(email: string): Promise<EmailCheckResult> {
  if (!env.EMAIL_AWESOME_API_KEY) {
    console.warn('[EmailVerification] EMAIL_AWESOME_API_KEY not set — skipping check.');
    return 'unknown';
  }

  try {
    const url = `https://api.emailawesome.com/v1/verify?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.EMAIL_AWESOME_API_KEY}` },
      // Never let a slow third-party API hang order processing — this
      // check happens inline when an order's accept-timer expires, so a
      // stuck request here would stall a real customer's order.
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[EmailVerification] API returned ${res.status} for the checked address.`);
      return 'unknown';
    }

    const data = (await res.json()) as { status?: string; result?: string };
    const status = (data.status || data.result || '').toString().toUpperCase();

    if (status === 'VALID') return 'valid';
    if (status === 'INVALID') return 'invalid';
    return 'unknown'; // includes catch-all/risky/unknown — never punish on a maybe
  } catch (err) {
    console.error('[EmailVerification] Check failed:', err);
    // Fail-safe: any error (timeout, network, bad JSON) means inconclusive,
    // never treated as evidence of anything.
    return 'unknown';
  }
}
