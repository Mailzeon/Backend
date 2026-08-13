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
 * API's Phone Validation product — 100 free requests/month.
 *
 * Unlike checkEmailExists()/checkIpRisk() elsewhere in this codebase, this
 * one is NOT fail-open by design: phone verification is a hard gate at
 * registration (see auth.service.ts register()) and profile updates (see
 * user.controller.ts updateProfile()) — a customer/worker literally cannot
 * proceed without a phone that passes this check. Whether a provider
 * outage should also block signups is a real product trade-off, not an
 * engineering default — see the `checkFailed` field, which callers use to
 * decide (current behavior: still block, see auth.service.ts, with a
 * message asking the person to try again shortly rather than pretending
 * the number is invalid).
 */
export async function verifyPhone(phone: string): Promise<PhoneCheckResult> {
  if (!env.ABSTRACT_PHONE_API_KEY) {
    // Not configured — treat as "couldn't check", same signal as a
    // provider outage. See callers for how this is handled.
    return { isValid: false, isVoip: false, checkFailed: true };
  }

  try {
    // country=IN — every number entered on this platform is expected to be
    // a plain 10-digit Indian mobile number (see the E.164-less regex in
    // auth.validator.ts) with no country code prefix, so telling Abstract
    // which country it's from is necessary for it to parse correctly.
    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(env.ABSTRACT_PHONE_API_KEY)}&phone=${encodeURIComponent(phone)}&country=IN`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '<unreadable>');
      console.error(`[PhoneVerification] API returned ${res.status}: ${bodyText}`);
      return { isValid: false, isVoip: false, checkFailed: true };
    }

    const data = (await res.json()) as {
      valid?: boolean;
      line_type?: string;
    };

    const lineType = (data.line_type || '').toLowerCase();
    const isVoip = lineType === 'voip';

    return {
      isValid: !!data.valid && !isVoip,
      isVoip,
      lineType: data.line_type,
      checkFailed: false,
    };
  } catch (err) {
    console.error('[PhoneVerification] Check failed:', err);
    return { isValid: false, isVoip: false, checkFailed: true };
  }
}
