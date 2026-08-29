import { env } from '../config/env';
import { ApiKeyRotationState } from '../models/ApiKeyRotationState.model';

export interface PhoneCheckResult {
  isValid: boolean;
  // Rejected specifically for being a VOIP/virtual number (the classic
  // disposable/fake-number pattern) — surfaced separately from a plain
  // "invalid" so the error message can be specific about why.
  isVoip: boolean;
  lineType?: string;
  // true only when the provider genuinely couldn't be reached/parsed the
  // response oddly — NOT the same as "the number is invalid". Callers
  // decide what to do with this (see auth.service.ts register()).
  checkFailed: boolean;
}

const STATE_ID = 'abstract-phone-intelligence';

/**
 * Verifies a phone number is real (not fake/disposable) using Abstract
 * API's Phone Intelligence product.
 *
 * IMPORTANT: this is a DIFFERENT Abstract product from the simpler "Phone
 * Validation" API (phonevalidation.abstractapi.com) — Abstract issues a
 * SEPARATE API key per product, so every configured key here must be
 * generated for Phone Intelligence specifically (app.abstractapi.com/api/
 * phone-intelligence), or every check will fail with a 401. Confirmed via
 * official docs (docs.abstractapi.com/api/phone-intelligence) — response
 * is nested (phone_validation.is_valid / phone_validation.is_voip), not
 * the flat `valid`/`line_type` shape the simpler Phone Validation product
 * uses. Don't conflate the two.
 *
 * MULTI-KEY ROTATION (added Aug 14 2026): same system as
 * utils/emailVerification.ts, same reasoning — Abstract's free tier is
 * only 100 requests/month per account, which isn't enough at real volume.
 * Accepts ANY NUMBER of API keys via ABSTRACT_PHONE_API_KEYS
 * (comma-separated), rotates round-robin, and skips any key that hits its
 * monthly quota (422) until the 1st of next month. This matters even MORE
 * here than for email verification: phone verification is a HARD GATE at
 * registration (see auth.service.ts register()) — if it were still a
 * single key, that one key running out would completely stop new signups
 * platform-wide, not just weaken an anti-fraud check. Rotation state is
 * tracked SEPARATELY from the email rotation (different STATE_ID) even
 * though they share the same ApiKeyRotationState model/collection — each
 * provider's keys and exhaustion status are independent of the other's.
 *
 * See the big comment block at the bottom of this file for exactly how to
 * add more keys.
 *
 * Unlike checkEmailExists()/checkIpRisk() elsewhere in this codebase, this
 * one is NOT fail-open by design: a customer/worker literally cannot
 * register or verify a phone without this check passing. See the
 * `checkFailed` field for how "every key exhausted / provider outage" is
 * distinguished from "genuinely an invalid number" — callers (see
 * auth.service.ts register()) show a "try again shortly" message for the
 * former, not a false "invalid number" claim.
 */
export async function verifyPhone(e164Phone: string): Promise<PhoneCheckResult> {
  const keys = getConfiguredKeys();
  if (keys.length === 0) {
    console.warn('[PhoneVerification] No ABSTRACT_PHONE_API_KEYS configured — cannot verify.');
    return { isValid: false, isVoip: false, checkFailed: true };
  }

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const picked = await pickAndAdvanceKey(keys);
    if (!picked) {
      console.warn('[PhoneVerification] All configured API keys are exhausted for this month.');
      return { isValid: false, isVoip: false, checkFailed: true };
    }

    const outcome = await tryKey(picked.key, e164Phone);
    if (outcome.quotaExhausted) {
      await markExhausted(picked.index);
      continue; // try the next available key
    }
    return outcome.result;
  }

  return { isValid: false, isVoip: false, checkFailed: true };
}

// ─── Key configuration ────────────────────────────────────────────────────

function getConfiguredKeys(): string[] {
  if (env.ABSTRACT_PHONE_API_KEYS) {
    return env.ABSTRACT_PHONE_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  }
  // Backward-compat: the original single-key env var still works on its
  // own if the new multi-key one was never set.
  return env.ABSTRACT_PHONE_API_KEY ? [env.ABSTRACT_PHONE_API_KEY] : [];
}

// ─── Rotation state (persisted in Mongo — see ApiKeyRotationState.model.ts) ─
// Shares the model with emailVerification.ts, but a distinct STATE_ID
// keeps the two providers' rotation/exhaustion tracking fully separate.

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
  return null;
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
  e164Phone: string
): Promise<{ quotaExhausted: boolean; result: PhoneCheckResult }> {
  try {
    // CHANGED: this now takes a FULL E.164 number (with country code
    // already attached) instead of a bare 10-digit Indian number with +91
    // hardcoded on here — see user.routes.ts PUT /profile's foreign-number
    // path (added for genuinely-foreign accounts whose IP matches their
    // own number's country) for why a caller might now pass e.g.
    // "+13234511067". The original all-Indian caller (auth.service.ts
    // register()) now builds its own "+91..." string before calling this,
    // so its behavior is unchanged.
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&phone=${encodeURIComponent(e164Phone)}`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });

    if (res.status === 422) {
      // Monthly quota used up on this specific key — expected, not an
      // error worth logging loudly. verifyPhone() moves on to the next
      // configured key automatically.
      return { quotaExhausted: true, result: { isValid: false, isVoip: false, checkFailed: true } };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '<unreadable>');
      console.error(`[PhoneVerification] API returned ${res.status}: ${bodyText}`);
      return { quotaExhausted: false, result: { isValid: false, isVoip: false, checkFailed: true } };
    }

    const data = (await res.json()) as {
      phone_validation?: { is_valid?: boolean; is_voip?: boolean };
      phone_carrier?: { line_type?: string };
    };

    const isVoip = !!data.phone_validation?.is_voip;
    const isValid = !!data.phone_validation?.is_valid && !isVoip;

    return {
      quotaExhausted: false,
      result: { isValid, isVoip, lineType: data.phone_carrier?.line_type, checkFailed: false },
    };
  } catch (err) {
    console.error('[PhoneVerification] Check failed:', err);
    return { quotaExhausted: false, result: { isValid: false, isVoip: false, checkFailed: true } };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * HOW TO ADD MORE API KEYS
 * ═══════════════════════════════════════════════════════════════════════
 * 1. Sign up for a new (free) Abstract API account with a different email
 *    (e.g. a family member's Gmail), enable the "Phone Intelligence"
 *    product specifically (NOT "Phone Validation" — different product,
 *    different key), and copy that account's API key.
 * 2. Go to Render → your backend service → Environment.
 * 3. Find (or create) the env var named ABSTRACT_PHONE_API_KEYS.
 * 4. Set its value to ALL your keys, comma-separated:
 *       key1,key2,key3,key4,key5
 *    To add a new key later, just edit this value and append ",newkey"
 *    to the end — no code changes needed, Render redeploys automatically
 *    when you save an env var change.
 * 5. Save — that's it. Rotation picks it up immediately.
 * ═══════════════════════════════════════════════════════════════════════
 */
