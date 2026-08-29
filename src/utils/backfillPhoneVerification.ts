import { User } from '../models/User.model';
import { verifyPhone } from './phoneVerification';

/**
 * One-time backfill for users stranded with `phone` set but
 * `phoneVerified: false` — see the bug fix in routes/user.routes.ts PUT
 * /profile (Aug 2026). Anyone who placed an order before phone
 * verification existed already had a real phone saved with
 * phoneVerified defaulting to false, and a since-fixed bug meant
 * re-saving their own unchanged number silently never re-checked it —
 * permanently blocking them from placing/accepting orders with no way
 * to self-fix short of typing in a different number.
 *
 * This proactively re-verifies every such account in the background so
 * nobody has to manually revisit their profile and hit Save again to
 * benefit from the fix — mirrors backfillEmailVerification.ts exactly.
 *
 * Safe to run on every server start: only ever matches accounts that
 * still need it (phone present, not yet verified), so once everyone's
 * fixed this becomes a cheap no-op query every time.
 */
export async function backfillPhoneVerification(): Promise<void> {
  const candidates = await User.find({
    phone: { $exists: true, $nin: [null, ''] },
    phoneVerified: { $ne: true },
  }).select('_id phone');

  if (candidates.length === 0) return;

  console.log(`[Backfill] Re-checking phone verification for ${candidates.length} stranded user(s)...`);

  let verifiedCount = 0;
  for (const user of candidates) {
    // CHANGED: verifyPhone() now takes a full E.164 number instead of
    // adding +91 internally (see phoneVerification.ts — needed once
    // foreign numbers, stored already-E.164, became possible via
    // user.routes.ts PUT /profile's foreign-number path). Every phone
    // saved in the DB before that feature existed is a bare Indian
    // 10-digit number with no "+", so it still needs +91 prepended here;
    // anything already "+"-prefixed (a foreign number saved after that
    // feature shipped) is passed through as-is.
    const e164 = user.phone!.startsWith('+') ? user.phone! : `+91${user.phone}`;
    const result = await verifyPhone(e164);
    if (result.isValid) {
      await User.updateOne({ _id: user._id }, { phoneVerified: true });
      verifiedCount++;
    }
    // Genuinely invalid/VOIP numbers, or a transient check failure, are
    // left as-is — they'll naturally get another shot next restart, or
    // whenever the person saves their profile (now correctly re-checks
    // every time it isn't already confirmed verified).
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  console.log(`[Backfill] Phone verification done — ${verifiedCount}/${candidates.length} confirmed valid and unlocked.`);
}
