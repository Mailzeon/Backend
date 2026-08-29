// ─── International calling code → country lookup ───────────────────────
// Used ONLY by user.routes.ts PUT /profile's foreign-number path: when
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
