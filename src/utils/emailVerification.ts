import { env } from '../config/env';

export type EmailCheckResult = 'valid' | 'invalid' | 'unknown';

/**
 * Checks whether a specific email address currently exists, using Abstract
 * API's (abstractapi.com) Email Reputation product.
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
 * SWITCHED Aug 12 2026 from Email Awesome to Abstract API — Email Awesome's
 * own infrastructure was down (confirmed 503 from their AWS API Gateway,
 * not a bug on our side) and support never replied, so we moved off it
 * rather than keep waiting. CONFIRMED against Abstract's own public docs:
 * GET request, API key passed as a QUERY PARAM `api_key=` (NOT a header —
 * that's Email Awesome's pattern, don't copy it over), response has a
 * nested `email_deliverability.status` field with values like
 * "deliverable" / "undeliverable" / "unknown". If Abstract ever changes
 * their API, this is the ONLY function that needs updating — nothing else
 * in the codebase depends on the specifics.
 */
export async function checkEmailExists(email: string): Promise<EmailCheckResult> {
  if (!env.ABSTRACT_API_KEY) {
    console.warn('[EmailVerification] ABSTRACT_API_KEY not set — skipping check.');
    return 'unknown';
  }

  try {
    const url = `https://emailreputation.abstractapi.com/v1/?api_key=${encodeURIComponent(env.ABSTRACT_API_KEY)}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      method: 'GET',
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

    const data = (await res.json()) as {
      email_deliverability?: { status?: string };
    };

    const status = (data.email_deliverability?.status || '').toString().toLowerCase();

    if (status === 'deliverable') return 'valid';
    if (status === 'undeliverable') return 'invalid';
    return 'unknown'; // includes "unknown"/missing field — never punish on a maybe
  } catch (err) {
    console.error('[EmailVerification] Check failed:', err);
    // Fail-safe: any error (timeout, network, bad JSON) means inconclusive,
    // never treated as evidence of anything.
    return 'unknown';
  }
}
