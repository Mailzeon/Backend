import { User } from '../models/User.model';
import { checkEmailExists } from './emailVerification';

/**
 * One-time (per-account) backfill for the `emailVerificationStatus` field
 * added alongside registration-time email checking (see
 * auth.service.ts register()).
 *
 * Only ever NEW signups get checked at the moment they register — every
 * account created before this shipped starts with no status at all.
 *
 * BUG FIX (Aug 2026): this used to be guarded ONLY by
 * `emailVerifiedCheckedAt` being unset — meaning once ANY check ran,
 * regardless of outcome, the account was never touched again. That's
 * fine for a genuinely CONFIRMED 'invalid' result, but 'unknown' means
 * the check was INCONCLUSIVE (e.g. every configured API key happened to
 * be quota-exhausted at that exact moment — entirely possible when the
 * backfill and live order-time verification share the same key pool) —
 * not "confirmed anything." An account checked at exactly the wrong
 * moment was stuck showing unverified forever, even for a genuinely real
 * email, with zero way to self-heal. Now 'unknown' results get retried
 * on every subsequent run too, same "never punish on a maybe, keep
 * trying" philosophy used everywhere else — only a CONFIRMED 'invalid'
 * (or a fresh 'valid') is treated as settled and left alone.
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
 * documents that still need (re-)checking, so once everyone's settled at
 * valid/invalid this becomes a cheap no-op query every time. Runs with a
 * small delay between each check to spread quota usage rather than
 * firing everything at once.
 */
export async function backfillEmailVerification(): Promise<void> {
  console.log('[Backfill] Email verification check starting...');

  const candidates = await User.find({
    $or: [
      { emailVerifiedCheckedAt: { $exists: false } },
      { emailVerificationStatus: 'unknown' },
    ],
  }).select('_id email');

  console.log(`[Backfill] Email verification found ${candidates.length} candidate(s) needing (re-)check.`);

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
