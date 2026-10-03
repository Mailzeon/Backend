// ─── International calling code → country lookup ───────────────────────
// Used by the foreign-number paths of BOTH registration (auth.service.ts
// register()) and profile-update (user.routes.ts PUT /profile) — via the
// shared resolvePhoneForCountry() at the bottom of this file — plus the
// public GET /auth/detect-country-code badge endpoint: when
// someone submits a phone number in full E.164 format (e.g.
// "+13234511067") instead of a bare Indian 10-digit number, this is what
// decides which country that number's calling code belongs to, so it can
// be compared against the requester's own IP country (see
// ipIntelligence.ts getIpCountryCode()) — a foreign number is only ever
// accepted when it matches the country the request is actually coming
// from, never on its own.
//
// NOT exhaustive — deliberately covers the calling codes most likely to
// actually show up (India, North America, and the other countries with
// meaningful Mailzeon/Telegram usage), each mapped to every ISO-2 country
// that shares that calling code (e.g. "1" covers the whole North American
// Numbering Plan, not just the US). A calling code missing from this table
// is NOT a security gap — it just falls back to requiring the existing
// Indian-number path, the same as today, for anyone whose number doesn't
// match a code below. Add more codes here anytime without touching the
// route logic itself.
//
// Sorted longest-prefix-first within CALLING_CODE_LENGTHS so parsePhoneCountry()
// below tries 3-digit codes before 2-digit before 1-digit — calling codes
// are NOT self-delimiting (e.g. "1" vs "44" vs "971"), so trying the
// wrong length first would silently misparse some numbers.
const CALLING_CODE_COUNTRIES: Record<string, string[]> = {
  '91':  ['IN'],                          // India
  '1':   ['US', 'CA'],                    // USA / Canada (NANP) — the two that actually matter here
  '44':  ['GB'],                          // United Kingdom
  '971': ['AE'],                          // UAE
  '966': ['SA'],                          // Saudi Arabia
  '974': ['QA'],                          // Qatar
  '968': ['OM'],                          // Oman
  '965': ['KW'],                          // Kuwait
  '973': ['BH'],                          // Bahrain
  '92':  ['PK'],                          // Pakistan
  '880': ['BD'],                          // Bangladesh
  '977': ['NP'],                          // Nepal
  '94':  ['LK'],                          // Sri Lanka
  '61':  ['AU'],                          // Australia
  '64':  ['NZ'],                          // New Zealand
  '65':  ['SG'],                          // Singapore
  '60':  ['MY'],                          // Malaysia
  '63':  ['PH'],                          // Philippines
  '62':  ['ID'],                          // Indonesia
  '81':  ['JP'],                          // Japan
  '82':  ['KR'],                          // South Korea
  '86':  ['CN'],                          // China
  '49':  ['DE'],                          // Germany
  '33':  ['FR'],                          // France
  '39':  ['IT'],                          // Italy
  '34':  ['ES'],                          // Spain
  '31':  ['NL'],                          // Netherlands
  '27':  ['ZA'],                          // South Africa
  '234': ['NG'],                          // Nigeria
  '254': ['KE'],                          // Kenya
  '20':  ['EG'],                          // Egypt
  '55':  ['BR'],                          // Brazil
  '52':  ['MX'],                          // Mexico
  '7':   ['RU', 'KZ'],                    // Russia / Kazakhstan
};

// Longest calling codes first — a leading "9" digit-scan has to try "971"
// before "91" before "9" or it'll cut a UAE number's code short.
const CALLING_CODE_LENGTHS = [...new Set(Object.keys(CALLING_CODE_COUNTRIES).map(c => c.length))]
  .sort((a, b) => b - a);

/**
 * Parses a "+"-prefixed E.164-ish phone string into its calling code and
 * the list of ISO-2 countries that code belongs to. Returns null if the
 * string isn't "+"-prefixed or its calling code isn't one we recognize
 * (see the table above — recognized ⇒ eligible for the foreign-number
 * path; unrecognized ⇒ falls back to requiring an Indian number, same as
 * before this feature existed).
 */
export function parsePhoneCountry(phone: string): { callingCode: string; countries: string[] } | null {
  if (!phone.startsWith('+')) return null;
  const digits = phone.slice(1).replace(/\D/g, '');

  for (const len of CALLING_CODE_LENGTHS) {
    const candidate = digits.slice(0, len);
    const countries = CALLING_CODE_COUNTRIES[candidate];
    if (countries) return { callingCode: candidate, countries };
  }
  return null;
}

// ─── Country → calling code (reverse lookup) ──────────────────────────
// Used by GET /auth/detect-country-code to decide which "+NN" badge to
// show next to the phone field. For codes shared by several countries
// (NANP "1", "7") any member country maps back to that one shared code.
const COUNTRY_TO_CALLING_CODE: Record<string, string> = {};
for (const [code, countries] of Object.entries(CALLING_CODE_COUNTRIES)) {
  for (const c of countries) {
    if (!COUNTRY_TO_CALLING_CODE[c]) COUNTRY_TO_CALLING_CODE[c] = code;
  }
}

/** ISO-2 country → calling code digits (no "+"), or null if we don't support that country. */
export function getCallingCodeForCountry(iso2: string | null | undefined): string | null {
  if (!iso2) return null;
  return COUNTRY_TO_CALLING_CODE[iso2.toUpperCase()] ?? null;
}

// ─── Shared phone resolution (register + profile) ─────────────────────
// Discriminated on `status` (a string), not a boolean `ok` — this project's
// tsconfig has strict off, and boolean-literal narrowing is unreliable then.
export type PhoneResolution =
  | { status: 'ok'; e164: string; stored: string; isForeign: boolean }
  | { status: 'error'; reason: 'invalid_format' | 'unsupported_code' | 'ip_unknown' | 'ip_mismatch' };

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Single source of truth for "is this phone string acceptable, and in what
 * form do we verify/store it?" Two accepted shapes:
 *   1. Bare Indian 10-digit mobile — unchanged original behavior.
 *      verified as +91..., stored bare.
 *   2. "+"-prefixed international number — ONLY when its calling code's
 *      country matches `ipCountry` (the country this very request's IP
 *      resolves to). Verified and stored as full E.164.
 * A "+91"-prefixed Indian number is normalized to shape 1 so Indian numbers
 * are always stored the same way regardless of how they arrived.
 *
 * `ipCountry` only needs to be looked up when the input starts with "+" —
 * pass null otherwise (saves an API credit).
 */
export function resolvePhoneForCountry(phone: string, ipCountry: string | null): PhoneResolution {
  const trimmed = phone.trim();

  if (INDIAN_MOBILE.test(trimmed)) {
    return { status: 'ok', e164: `+91${trimmed}`, stored: trimmed, isForeign: false };
  }
  if (!trimmed.startsWith('+')) return { status: 'error', reason: 'invalid_format' };

  const parsed = parsePhoneCountry(trimmed);
  if (!parsed) return { status: 'error', reason: 'unsupported_code' };

  const digits = trimmed.slice(1).replace(/\D/g, '');

  if (parsed.callingCode === '91') {
    const national = digits.slice(2);
    if (INDIAN_MOBILE.test(national)) {
      return { status: 'ok', e164: `+91${national}`, stored: national, isForeign: false };
    }
    return { status: 'error', reason: 'invalid_format' };
  }

  if (!ipCountry) return { status: 'error', reason: 'ip_unknown' };
  if (!parsed.countries.includes(ipCountry.toUpperCase())) return { status: 'error', reason: 'ip_mismatch' };

  const e164 = `+${digits}`;
  return { status: 'ok', e164, stored: e164, isForeign: true };
}
