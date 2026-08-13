/**
 * The whole codebase represents "locked until" as a plain Date on
 * worker.lockedUntil / LockedIp.lockedUntil, compared against `new Date()`
 * everywhere a lock needs checking (auth.service.ts, order.service.ts,
 * user.service.ts). Rather than adding a separate `isPermanent: boolean`
 * field to two schemas and updating every single one of those comparisons,
 * a permanent lock is just represented as this one far-future date — every
 * existing `lockedUntil > new Date()` check keeps working unmodified, and
 * this file is the one place that defines what "far future" means and how
 * to detect it for display purposes (so we can show "permanently banned"
 * instead of a silly "your lock ends in 90,000 days" message).
 */

// Year 9999 — far enough that it will never realistically be reached, but
// still a valid, unambiguous BSON Date (unlike JS's actual Date max, which
// Mongo doesn't handle cleanly).
export const PERMANENT_LOCK_DATE = new Date('9999-12-31T23:59:59.999Z');

// Anything locked more than ~50 years out is being treated as permanent —
// gives headroom in case the exact constant above ever changes.
const PERMANENT_THRESHOLD_MS = 50 * 365 * 24 * 60 * 60 * 1000;

export const isPermanentLock = (lockedUntil: Date | null | undefined): boolean => {
  if (!lockedUntil) return false;
  return lockedUntil.getTime() - Date.now() > PERMANENT_THRESHOLD_MS;
};

interface LockLike {
  lockedUntil: Date;
}

/**
 * Decides which (if any) of an IP-based lock and a device-based lock
 * should actually be inherited by the account currently registering/
 * logging in — see auth.service.ts register()/login().
 *
 * IP alone is NOT trustworthy evidence for a merely-temporary strike lock:
 * carrier-grade NAT (very common on Indian mobile networks — Jio, Airtel)
 * means many completely unrelated real people can share the exact same
 * public IP at the same time. Blocking/locking a stranger's account just
 * because a totally different worker on the same mobile network got a
 * strike is a real false-positive risk, not a hypothetical one — this
 * showed up in testing: an unrelated worker got a fresh 6h lock the
 * moment a different worker on a shared network took a strike.
 *
 * So the rule is asymmetric on purpose:
 *   - PERMANENT bans (confirmed theft, admin manual suspend) are a much
 *     stronger signal — a single match on EITHER IP or device is enough to
 *     block/inherit, same as before. These are rare, deliberate outcomes,
 *     worth being aggressive about.
 *   - TEMPORARY strike locks are weaker signals individually — only
 *     inherited if BOTH the IP and the device fingerprint match. IP-only
 *     coincidence (CGNAT) or device-only coincidence (fingerprint
 *     collision, rare but possible) alone isn't enough on its own.
 */
export function resolveEvasionLock(
  ipLock: LockLike | null,
  deviceLock: LockLike | null
): LockLike | null {
  const permanent = [ipLock, deviceLock].find(l => l && isPermanentLock(l.lockedUntil));
  if (permanent) return permanent;

  if (ipLock && deviceLock) {
    return ipLock.lockedUntil.getTime() >= deviceLock.lockedUntil.getTime() ? ipLock : deviceLock;
  }
  return null; // only one signal matched, on a merely-temporary lock — not enough alone
}
