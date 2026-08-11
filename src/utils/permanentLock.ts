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
