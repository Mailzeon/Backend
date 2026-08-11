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
 * CONFIRMED Aug 11 2026 against Email Awesome's own docs
 * (developers.emailawesome.com) and their support bot: GET request,
 * `x-api-key` header (NOT `Authorization: Bearer` — that was the bug that
 * made every call fail before), response has a `status` field of
 * VALID/INVALID/UNKNOWN. If Email Awesome ever changes their API, this is
 * the ONLY function that needs updating — nothing else in the codebase
 * depends on the specifics.
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
      headers: { 'x-api-key': env.EMAIL_AWESOME_API_KEY },
      // Never let a slow third-party API hang order processing — this
      // check happens inline when an order's accept-timer expires, so a
      // stuck request here would stall a real customer's order.
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      // Log the body too (not just the status code) — if the API ever
      // changes shape again, this one line tells us exactly what came
      // back instead of needing another round of guessing.
      const bodyText = await res.text().catch(() => '<unreadable>');
      console.error(`[EmailVerification] API returned ${res.status}: ${bodyText}`);
      return 'unknown';
    }

    const data = (await res.json()) as Record<string, unknown>;
    // Be liberal in what we accept — different response shapes have shown
    // up in Email Awesome's own docs (status/result as string, or a plain
    // boolean `valid` field), so check all of them rather than assuming one.
    if (typeof data.valid === 'boolean') {
      return data.valid ? 'valid' : 'invalid';
    }
    const status = ((data.status as string) || (data.result as string) || '').toString().toUpperCase();

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
