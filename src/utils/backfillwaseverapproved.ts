import { User } from '../models/User.model';
import { Order } from '../models/Order.model';

/**
 * One-time backfill for the `wasEverApproved` field added to fix the
 * Pending-vs-Suspended distinction in the admin Users list.
 *
 * The field only gets SET going forward (see admin.routes.ts PATCH
 * /users/:id/approve). Workers who were already suspended BEFORE that fix
 * shipped never got it backfilled — they'd show as "Pending" with an
 * "Approve" button instead of "Suspended" with "Reactivate", even though
 * they were clearly approved at some point in the past.
 *
 * Heuristic: a worker could only ever have accepted an order, or racked up
 * a strike / IP lock, while isApproved was true (both are gated behind the
 * isApproved check in role.middleware.ts / order.service.ts). So if any of
 * those are true for a worker who's currently NOT approved and doesn't
 * have wasEverApproved set, they must have been approved before — backfill
 * it.
 *
 * Safe to run on every server start: the query only ever matches documents
 * that still need fixing, so once everyone's backfilled this becomes a
 * cheap no-op query every time.
 */
export async function backfillWasEverApproved(): Promise<void> {
  const candidates = await User.find({
    role: 'worker',
    isApproved: false,
    wasEverApproved: { $ne: true },
  }).select('_id strikeCount lockedUntil');

  if (candidates.length === 0) return;

  const idsToFix: typeof candidates[number]['_id'][] = [];

  for (const worker of candidates) {
    const hasStrikeOrLockHistory = (worker.strikeCount ?? 0) > 0 || !!worker.lockedUntil;
    const hasOrderHistory = hasStrikeOrLockHistory
      ? true // already known — skip the extra query
      : await Order.exists({ workerId: worker._id });

    if (hasStrikeOrLockHistory || hasOrderHistory) {
      idsToFix.push(worker._id);
    }
  }

  if (idsToFix.length > 0) {
    await User.updateMany({ _id: { $in: idsToFix } }, { wasEverApproved: true });
    console.log(`[Backfill] wasEverApproved set for ${idsToFix.length} previously-suspended worker(s).`);
  }
}
