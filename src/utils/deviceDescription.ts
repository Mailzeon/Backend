import { UAParser } from 'ua-parser-js';

/**
 * Turns a raw User-Agent header (plus an optional real device-model hint
 * — see below) into a short, human-readable device description for the
 * admin panel — e.g. "Xiaomi Redmi Note 10 (Android, Chrome)", "Samsung
 * Galaxy S21 (Android, Chrome)", "iPhone (iOS, Safari)", "Windows (Chrome)".
 *
 * This is DELIBERATELY separate from the anti-fraud device fingerprint
 * (see lib/fingerprint.ts on the frontend, registrationDevice/
 * lastLoginDevice on User.model.ts) — that's an opaque hash purpose-built
 * for matching accounts against each other, not for a human to read. This
 * is the opposite: readable, but not reliable enough to match on (two
 * different Xiaomi Redmi Note 10 owners produce the identical string).
 *
 * modelHint (NEW): since Chrome 110 (2023), Chrome deliberately FREEZES
 * the User-Agent string on Android to a generic, fake placeholder —
 * literally "Android 10; K" for every device regardless of real OS
 * version or model (a privacy change, not a bug, and not specific to this
 * app — every site sees this). ua-parser-js has nothing real to extract
 * from that string; the "K" is Chrome's own frozen placeholder, not a
 * mis-parse. The ONLY way to get the genuine model back is User-Agent
 * Client Hints — the frontend calls
 * navigator.userAgentData.getHighEntropyValues(['model']) (Chromium-only;
 * see lib/fingerprint.ts getDeviceModelHint()) and sends the real result
 * (e.g. "Pixel 7", "SM-G991B") up as `deviceModelHint` alongside the
 * device fingerprint — see auth.service.ts's register()/login()/
 * telegramLogin() call sites. When present and it passes the same
 * suspiciously-short-string sanity check as the UA-parsed path below, it
 * REPLACES the device.model ua-parser-js would have extracted (which,
 * again, is never real on modern Android Chrome regardless), while OS and
 * browser still come from the normal UA parse either way. Firefox,
 * Safari, and any non-Chromium browser don't support this API at all —
 * for those, this falls back to the UA-only parsing exactly as before.
 */
export function describeDevice(userAgent: string | undefined, modelHint?: string): string {
  if (!userAgent) return 'Unknown device';

  const { device, os, browser } = UAParser(userAgent);

  let deviceLabel = [device.vendor, device.model].filter(Boolean).join(' ').trim();

  // A real Client Hints model (see the big comment above) takes priority
  // over whatever ua-parser-js found in the frozen UA string — same
  // sanity check as the rejection below applies to it too, since it's
  // still client-supplied input and shouldn't be trusted blindly.
  if (modelHint?.trim() && modelHint.trim().length >= 3) {
    deviceLabel = modelHint.trim();
  } else if (deviceLabel && deviceLabel.length < 3) {
    // BUG FIX (Aug 2026): ua-parser-js occasionally mis-parses unusual
    // User-Agent strings (Telegram's in-app Android WebView being the
    // main source seen so far, and now ALSO just plain frozen Chrome-on-
    // Android UAs — see modelHint comment above) into a bogus single-
    // character "model" like "K" — clearly a placeholder/regex fragment,
    // not a real device name (no genuine phone model is ever 1-2
    // characters). Rejected outright rather than shown as if it were
    // reliable — falls through to the OS+browser-only label below
    // instead, same fallback already used when nothing at all gets
    // extracted.
    console.warn('[DeviceDescription] Rejected suspiciously short device label', JSON.stringify(deviceLabel), 'from UA:', userAgent);
    deviceLabel = '';
  }

  const osLabel = os.name ? `${os.name}${os.version ? ` ${os.version}` : ''}` : null;
  const browserLabel = browser.name || null;

  const platformParts = [osLabel, browserLabel].filter(Boolean);
  const platformSuffix = platformParts.length > 0 ? ` (${platformParts.join(', ')})` : '';

  if (deviceLabel) return `${deviceLabel}${platformSuffix}`;
  if (osLabel === 'iOS' || osLabel?.startsWith('iOS')) return `iPhone/iPad${platformSuffix}`;
  if (platformParts.length > 0) return platformParts.join(', '); // e.g. "Windows, Chrome" for desktop

  // TEMP DEBUG (Aug 2026): ua-parser-js came back with nothing usable at
  // all for this User-Agent — instead of a totally opaque "Unknown
  // device" that gives no clue why, log the raw string so we can see
  // exactly what's arriving (in-app browsers like WhatsApp/Instagram/
  // Snapchat's embedded WebView often send unusual/generic UAs that
  // don't match standard parsing patterns) and show a short snippet of
  // it in the admin panel too, rather than nothing at all.
  console.warn('[DeviceDescription] Could not parse any device/OS/browser info from UA:', userAgent);
  return `Unrecognized (${userAgent.slice(0, 40)}...)`;
}
