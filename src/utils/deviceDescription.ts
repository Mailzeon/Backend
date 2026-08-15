import { UAParser } from 'ua-parser-js';

/**
 * Turns a raw User-Agent header into a short, human-readable device
 * description for the admin panel — e.g. "Xiaomi Redmi Note 10 (Android,
 * Chrome)", "Samsung Galaxy S21 (Android, Chrome)", "iPhone (iOS, Safari)",
 * "Windows (Chrome)".
 *
 * This is DELIBERATELY separate from the anti-fraud device fingerprint
 * (see lib/fingerprint.ts on the frontend, registrationDevice/
 * lastLoginDevice on User.model.ts) — that's an opaque hash purpose-built
 * for matching accounts against each other, not for a human to read. This
 * is the opposite: readable, but not reliable enough to match on (two
 * different Xiaomi Redmi Note 10 owners produce the identical string).
 *
 * Best-effort only: most browsers today deliberately reduce how much
 * device detail they put in the User-Agent for privacy reasons (this is
 * an industry-wide trend, not a bug here) — Android phones vary widely by
 * brand/OS-version in how much they still expose, and iPhones/iPads never
 * expose a specific model at all (Apple's User-Agent just says "iPhone").
 * When nothing useful can be extracted, this falls back to whatever level
 * of detail IS available (OS + browser only) rather than returning
 * nothing.
 */
export function describeDevice(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';

  const { device, os, browser } = UAParser(userAgent);

  const deviceLabel = [device.vendor, device.model].filter(Boolean).join(' ').trim();
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
