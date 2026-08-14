import { env } from '../config/env';
import { ApiKeyRotationState } from '../models/ApiKeyRotationState.model';

export type EmailCheckResult = 'valid' | 'invalid' | 'unknown';

const STATE_ID = 'abstract-email-reputation';

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
 * MULTI-KEY ROTATION (added Aug 14 2026): Abstract's free tier is only
 * 100 requests/month per account, which isn't enough at real volume — so
 * this now accepts ANY NUMBER of API keys (from separate Abstract
 * accounts/emails) via the ABSTRACT_EMAIL_API_KEYS env var, and
 * automatically rotates through them:
 *   - Tries keys round-robin (spreads load evenly, not always key #0 first)
 *   - The moment a key hits its monthly quota (Abstract returns 422), it's
 *     marked exhausted UNTIL THE START OF NEXT MONTH and skipped from then
 *     on — the SAME check call immediately retries with the next available
 *     key, so a quota hit is invisible to the caller as long as at least
 *     one key still has room.
 *   - Only returns 'unknown' (fail-open, never treated as evidence of
 *     anything) if every single configured key is exhausted, or none are
 *     configured at all.
 * Rotation state (which key was used last, which are exhausted and until
 * when) is persisted in MongoDB via ApiKeyRotationState.model.ts, NOT kept
 * in memory — Render's free tier restarts/sleeps often enough that
 * in-memory state would mean re-discovering exhausted keys one wasted
 * request at a time after every restart, which gets expensive fast with
 * 10+ keys.
 *
 * See the very bottom of this file for exactly how to add more keys.
 */
export async function checkEmailExists(email: string): Promise<EmailCheckResult> {
  const keys = getConfiguredKeys();
  if (keys.length === 0) {
    console.warn('[EmailVerification] No ABSTRACT_EMAIL_API_KEYS configured — skipping check.');
    return 'unknown';
  }

  // Try up to N times (N = number of configured keys) — each attempt picks
  // the next available (non-exhausted) key and advances rotation state.
  // A 422 on one key immediately falls through to the next, all within
  // this single call, so the caller never sees the quota hit as long as
  // ANY configured key still has room this month.
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const picked = await pickAndAdvanceKey(keys);
    if (!picked) {
      console.warn('[EmailVerification] All configured API keys are exhausted for this month.');
      return 'unknown';
    }

    const outcome = await tryKey(picked.key, email);

    if (outcome.quotaExhausted) {
      await markExhausted(picked.index);
      continue; // try the next available key
    }
    return outcome.result;
  }

  return 'unknown';
}

// ─── Key configuration ────────────────────────────────────────────────────

function getConfiguredKeys(): string[] {
  if (env.ABSTRACT_EMAIL_API_KEYS) {
    return env.ABSTRACT_EMAIL_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  }
  // Backward-compat: the original single-key env var still works on its
  // own if the new multi-key one was never set.
  return env.ABSTRACT_API_KEY ? [env.ABSTRACT_API_KEY] : [];
}

// ─── Rotation state (persisted in Mongo — see ApiKeyRotationState.model.ts) ─

async function getOrCreateState() {
  let state = await ApiKeyRotationState.findById(STATE_ID);
  if (!state) {
    state = await ApiKeyRotationState.create({ _id: STATE_ID });
  }
  return state;
}

async function pickAndAdvanceKey(keys: string[]): Promise<{ key: string; index: number } | null> {
  const state = await getOrCreateState();
  const now = new Date();

  for (let i = 1; i <= keys.length; i++) {
    const idx = (state.lastUsedIndex + i) % keys.length;
    const exhaustedUntil = state.exhausted.get(String(idx));
    if (exhaustedUntil && exhaustedUntil > now) continue; // still exhausted this month

    await ApiKeyRotationState.updateOne({ _id: STATE_ID }, { $set: { lastUsedIndex: idx } });
    return { key: keys[idx], index: idx };
  }
  return null; // every configured key is currently exhausted
}

async function markExhausted(index: number): Promise<void> {
  const now = new Date();
  const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month
  await ApiKeyRotationState.updateOne(
    { _id: STATE_ID },
    { $set: { [`exhausted.${index}`]: resetsAt } }
  );
}

// ─── Single-key request ────────────────────────────────────────────────────

async function tryKey(
  apiKey: string,
  email: string
): Promise<{ quotaExhausted: boolean; result: EmailCheckResult }> {
  try {
    const url = `https://emailreputation.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      method: 'GET',
      // Never let a slow third-party API hang order processing — this
      // check happens inline when an order's accept-timer expires, so a
      // stuck request here would stall a real customer's order.
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 422) {
      // Monthly quota used up on this specific key — expected, not an
      // error worth logging loudly. checkEmailExists() will move on to
      // the next configured key automatically.
      return { quotaExhausted: true, result: 'unknown' };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '<unreadable>');
      console.error(`[EmailVerification] API returned ${res.status}: ${bodyText}`);
      return { quotaExhausted: false, result: 'unknown' };
    }

    const data = (await res.json()) as {
      email_deliverability?: { status?: string };
    };
    const status = (data.email_deliverability?.status || '').toString().toLowerCase();

    if (status === 'deliverable')   return { quotaExhausted: false, result: 'valid' };
    if (status === 'undeliverable') return { quotaExhausted: false, result: 'invalid' };
    return { quotaExhausted: false, result: 'unknown' }; // never punish on a maybe
  } catch (err) {
    console.error('[EmailVerification] Check failed:', err);
    return { quotaExhausted: false, result: 'unknown' };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * HOW TO ADD MORE API KEYS
 * ═══════════════════════════════════════════════════════════════════════
 * 1. Sign up for a new (free) Abstract API account with a different email
 *    (e.g. a family member's Gmail), enable the "Email Reputation"
 *    product, and copy that account's API key.
 * 2. Go to Render → your backend service → Environment.
 * 3. Find (or create) the env var named ABSTRACT_EMAIL_API_KEYS.
 * 4. Set its value to ALL your keys, comma-separated, no spaces needed
 *    (they get trimmed automatically either way):
 *       key1,key2,key3,key4,key5
 *    To add a new key later, just edit this same value and append
 *    ",newkey" to the end — no code changes, no redeploy of code needed
 *    (env var changes on Render trigger a redeploy automatically, which
 *    is all that's needed).
 * 5. Save — Render will redeploy automatically. That's it. The rotation
 *    system picks it up immediately; no other configuration anywhere.
 * ═══════════════════════════════════════════════════════════════════════
 */
