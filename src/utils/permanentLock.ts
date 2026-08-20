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
 * logging in — see auth.service.ts register() AND login().
 *
 * BUG FIX (Aug 2026): this used to trust a PERMANENT lock on EITHER
 * signal alone (IP or device), while requiring BOTH signals for a merely
 * TEMPORARY strike lock. That asymmetry turned out to be wrong in
 * practice, in two separate real incidents:
 *   1. Someone who had NEVER opened Mailzeon before tried to register as
 *      a worker and was permanently blocked outright — their mobile
 *      network's IP happened to be shared (CGNAT) with a completely
 *      unrelated worker who'd been permanently banned for confirmed
 *      theft. IP-only match, wrong person blocked.
 *   2. The exact same class of bug can hit an EXISTING worker at LOGIN
 *      too — logging in successfully, but silently having a permanent
 *      lock inherited onto their own account (via useLockStatus.ts's
 *      "permanently banned" banner) for the same reason: sharing a
 *      CGNAT IP with a stranger who actually did something wrong.
 *
 * Carrier-grade NAT is extremely common on Indian mobile networks (Jio,
 * Airtel) — many completely unrelated real people share the exact same
 * public IP at the same time, constantly. IP alone was never reliable
 * enough evidence for the TEMPORARY case (already handled correctly
 * below), and this is direct proof it isn't reliable enough for the
 * PERMANENT case either — a permanent ban being a "rare, deliberate
 * outcome" doesn't make IP-sharing with that person any less coincidental
 * for the innocent person on the other end of it.
 *
 * So the rule is now simple and consistent, for every lock and every
 * caller: BOTH the IP and the device fingerprint must match before a
 * lock is ever inherited onto a different account, whether that's a
 * brand-new registration or an existing login. A worker who's genuinely
 * evading their own ban (same actual device, same actual network) still
 * gets caught by this — it's specifically the "different device,
 * coincidentally same shared IP" case that no longer triggers.
 */
export function resolveEvasionLock(
  ipLock: LockLike | null,
  deviceLock: LockLike | null
): LockLike | null {
  if (!ipLock || !deviceLock) return null; // one signal alone is never enough, on any lock
  return ipLock.lockedUntil.getTime() >= deviceLock.lockedUntil.getTime() ? ipLock : deviceLock;
}
