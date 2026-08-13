import { env } from '../config/env';

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

/**
 * Verifies a phone number is real (not fake/disposable) using Abstract
 * API's Phone Intelligence product — 100 free requests/month.
 *
 * IMPORTANT: this is a DIFFERENT Abstract product from the simpler "Phone
 * Validation" API (phonevalidation.abstractapi.com) — Abstract issues a
 * SEPARATE API key per product, so ABSTRACT_PHONE_API_KEY must be the key
 * generated for Phone Intelligence specifically (app.abstractapi.com/api/
 * phone-intelligence), or every check will fail with a 401. Confirmed via
 * official docs (docs.abstractapi.com/api/phone-intelligence) — response
 * is nested (phone_validation.is_valid / phone_validation.is_voip), not
 * the flat `valid`/`line_type` shape the simpler Phone Validation product
 * uses. Don't conflate the two.
 *
 * Unlike checkEmailExists()/checkIpRisk() elsewhere in this codebase, this
 * one is NOT fail-open by design: phone verification is a hard gate at
 * registration (see auth.service.ts register()) and profile updates (see
 * user.routes.ts PUT /profile) — a customer/worker literally cannot
 * proceed without a phone that passes this check. See the `checkFailed`
 * field for how a provider outage is distinguished from a genuinely
 * invalid number.
 */
export async function verifyPhone(phone: string): Promise<PhoneCheckResult> {
  if (!env.ABSTRACT_PHONE_API_KEY) {
    // Not configured — treat as "couldn't check", same signal as a
    // provider outage. See callers for how this is handled.
    return { isValid: false, isVoip: false, checkFailed: true };
  }

  try {
    // Every number on this platform is a 10-digit Indian mobile number
    // with no country code (see the regex in auth.validator.ts) — Phone
    // Intelligence expects something close to E.164, so +91 is prepended
    // here rather than relying on a country param.
    const e164 = `+91${phone.replace(/\D/g, '')}`;
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(env.ABSTRACT_PHONE_API_KEY)}&phone=${encodeURIComponent(e164)}`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '<unreadable>');
      console.error(`[PhoneVerification] API returned ${res.status}: ${bodyText}`);
      return { isValid: false, isVoip: false, checkFailed: true };
    }

    const data = (await res.json()) as {
      phone_validation?: { is_valid?: boolean; is_voip?: boolean };
      phone_carrier?: { line_type?: string };
    };

    const isVoip = !!data.phone_validation?.is_voip;
    const isValid = !!data.phone_validation?.is_valid && !isVoip;

    return {
      isValid,
      isVoip,
      lineType: data.phone_carrier?.line_type,
      checkFailed: false,
    };
  } catch (err) {
    console.error('[PhoneVerification] Check failed:', err);
    return { isValid: false, isVoip: false, checkFailed: true };
  }
}
