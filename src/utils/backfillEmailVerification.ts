import { User } from '../models/User.model';
import { checkEmailExists } from './emailVerification';

/**
 * One-time backfill for the `emailVerified` field added alongside
 * registration-time email checking (see auth.service.ts register()).
 *
 * Only ever NEW signups get checked at the moment they register — every
 * account created before this shipped has no `emailVerified` value at
 * all. This retroactively checks each of them exactly ONCE (guarded by
 * `emailVerifiedCheckedAt` being unset — once a user has been checked,
 * regardless of outcome, this never touches them again) and records the
 * result for admin visibility.
 *
 * Deliberately informational only — does NOT block, suspend, or restrict
 * any existing account based on the result. An account that's been
 * active and placing/accepting real orders has already effectively
 * proven itself through actual usage; retroactively locking someone out
 * over an email check running months after the fact would be genuinely
 * disruptive for zero real fraud-prevention benefit (the fraud
 * prevention value of this check is entirely at the moment of signup,
 * before any trust has been established).
 *
 * Safe to run on every server start: the query only ever matches
 * documents that still need checking, so once everyone's been processed
 * this becomes a cheap no-op query every time. Runs with a small delay
 * between each check to spread quota usage rather than firing everything
 * at once — see runOneAtATime() below.
 */
export async function backfillEmailVerification(): Promise<void> {
  const candidates = await User.find({
    emailVerifiedCheckedAt: { $exists: false },
  }).select('_id email');

  if (candidates.length === 0) return;

  console.log(`[Backfill] Checking email verification for ${candidates.length} existing user(s)...`);

  let verifiedCount = 0;
  for (const user of candidates) {
    const result = await checkEmailExists(user.email);
    await User.updateOne(
      { _id: user._id },
      { emailVerificationStatus: result, emailVerifiedCheckedAt: new Date() }
    );
    if (result === 'valid') verifiedCount++;
    // Small gap between checks — this can be 50-100+ accounts on first
    // run, no need to hammer the rotation pool back-to-back when there's
    // no time pressure on a background backfill.
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  console.log(`[Backfill] Email verification done — ${verifiedCount}/${candidates.length} confirmed valid.`);
}
