import { Types } from 'mongoose';
import { User } from '../models/User.model';
import { Order } from '../models/Order.model';
import { Dispute } from '../models/Dispute.model';
import { RefundRequest } from '../models/RefundRequest.model';
import { WithdrawRequest } from '../models/WithdrawRequest.model';
import { Transaction } from '../models/Transaction.model';
import { Notification } from '../models/Notification.model';
import { Rating } from '../models/Rating.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { Settings } from '../models/Settings.model';
import { LockedIp } from '../models/LockedIp.model';
import { notificationService } from './notification.service';
import { clearAuthCookie } from '../utils/cookies';
import { pushLiveWorkerCount } from '../socket/socket';
import { Response } from 'express';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

// Own tiny settings cache, independent of order.service.ts's — avoids a
// cross-service import just for this one setting. A few minutes of
// staleness on a penalty-duration setting is harmless.
const settingsCache: Record<string, { value: string; expiresAt: number }> = {};
const SETTINGS_TTL = 5 * 60 * 1000;
const getSetting = async (key: string, fallback: string): Promise<string> => {
  const now = Date.now();
  if (settingsCache[key] && settingsCache[key].expiresAt > now) return settingsCache[key].value;
  const s = await Settings.findOne({ key }).lean();
  const value = (s as any)?.value ?? fallback;
  settingsCache[key] = { value, expiresAt: now + SETTINGS_TTL };
  return value;
};

// Order states where something is still actively in flight — deleting
// either party mid-order would leave the other person stuck (a worker
// who'll never get paid, or a customer who'll never get credentials).
const ACTIVE_ORDER_STATUSES = [
  'payment_pending', 'pending', 'accepted',
  'credentials_submitted', 'verification_pending',
  'success_confirmed', 'under_review',
];

export const userService = {
  // ── Account deletion (self OR admin-triggered) ──────────────────────────
  // Soft-delete only — see the schema comment on User.isDeleted for why.
  // Every Order/Dispute/Transaction/Rating/Notification this user was ever
  // part of is left completely untouched; only the User document itself is
  // scrubbed and flagged, which is what actually satisfies "the count goes
  // down but the history stays" — the history was never going to be
  // touched in the first place, because it doesn't live on this document.
  async deleteAccount(userId: string, res?: Response): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throwErr('User not found.', 404);
    if (user!.isDeleted) throwErr('This account is already deleted.', 400);
    if (user!.role === 'admin') throwErr('Admin accounts cannot be deleted this way.', 400);

    const activeOrderFilter = user!.role === 'worker'
      ? { workerId: user!._id, status: { $in: ACTIVE_ORDER_STATUSES } }
      : { customerId: user!._id, status: { $in: ACTIVE_ORDER_STATUSES } };

    const activeOrderCount = await Order.countDocuments(activeOrderFilter);
    if (activeOrderCount > 0) {
      throwErr(
        `Cannot delete — this account has ${activeOrderCount} order(s) still in progress. ` +
        `They must finish, be cancelled, or be resolved first.`,
        400
      );
    }

    const wasWorker = user!.role === 'worker';

    user!.isDeleted = true;
    user!.deletedAt = new Date();
    user!.name = 'Deleted User';
    // Free up the original email for reuse (unique index) while keeping
    // this value unique to this specific document.
    user!.email = `deleted_${user!._id.toString()}@mailzeon.local`;
    user!.phone = undefined;
    user!.isOnline = false;
    user!.profileImage = undefined;
    user!.upiId = undefined;
    user!.bankDetails = undefined;
    // Scramble the password to something nobody could ever know or guess —
    // this alone is enough to make login impossible even before the
    // isDeleted check in auth middleware runs.
    user!.password = new Types.ObjectId().toString() + new Types.ObjectId().toString();
    await user!.save();

    // If a logged-in session initiated this (self-delete), log them out
    // immediately — the httpOnly cookie is otherwise still "valid" (a real
    // signed token) even though the account behind it is gone.
    if (res) clearAuthCookie(res);

    if (wasWorker) {
      pushLiveWorkerCount().catch(err =>
        console.error('[UserService] Failed to refresh worker count after delete:', err)
      );
    }
  },

  // ── Admin: wipe a specific user's history/activity data ─────────────────
  // Scoped version of the global "Danger Zone" reset — same idea, same
  // destructiveness, just filtered to one person instead of everyone. The
  // ACCOUNT itself is untouched (still exists, can still log in) — only
  // their orders, disputes, transactions, notifications, ratings, and
  // wallet/level stats are wiped. Unlike deleteAccount() above, this is
  // NOT a safe operation for the other party in any shared order/dispute —
  // those records are deleted outright, not preserved — so the caller
  // (admin.routes.ts) requires a typed confirmation before calling this.
  async clearUserData(userId: string): Promise<Record<string, number>> {
    const user = await User.findById(userId);
    if (!user) throwErr('User not found.', 404);

    const isWorker = user!.role === 'worker';
    const orderFilter   = isWorker ? { workerId: user!._id }   : { customerId: user!._id };
    const disputeFilter = isWorker ? { workerId: user!._id }   : { customerId: user!._id };
    const ratingFilter  = isWorker ? { workerId: user!._id }   : { customerId: user!._id };

    const [orders, disputes, transactions, notifications, ratings] = await Promise.all([
      Order.deleteMany(orderFilter),
      Dispute.deleteMany(disputeFilter),
      Transaction.deleteMany({ userId: user!._id }),
      Notification.deleteMany({ userId: user!._id }),
      Rating.deleteMany(ratingFilter),
    ]);

    const [refunds, withdrawals] = await Promise.all([
      isWorker ? { deletedCount: 0 } : RefundRequest.deleteMany({ customerId: user!._id }),
      isWorker ? WithdrawRequest.deleteMany({ workerId: user!._id }) : { deletedCount: 0 },
    ]);

    await Wallet.findOneAndUpdate(
      { userId: user!._id },
      { $set: { balance: 0, pendingBalance: 0, totalEarned: 0 } }
    );

    if (isWorker) {
      await WorkerLevelModel.findOneAndUpdate(
        { workerId: user!._id },
        { $set: { level: 'bronze', completedOrders: 0, totalEarnings: 0, successRate: 100, averageRating: 0 } }
      );
    }

    return {
      ordersDeleted:        orders.deletedCount ?? 0,
      disputesDeleted:      disputes.deletedCount ?? 0,
      refundsDeleted:       refunds.deletedCount ?? 0,
      withdrawalsDeleted:   withdrawals.deletedCount ?? 0,
      transactionsDeleted:  transactions.deletedCount ?? 0,
      notificationsDeleted: notifications.deletedCount ?? 0,
      ratingsDeleted:       ratings.deletedCount ?? 0,
    };
  },

  // ── Dispute-strike penalty ────────────────────────────────────────────────
  // Called by dispute.service.ts whenever an admin resolves a dispute
  // AGAINST a worker. Escalating temporary lock, tunable from the admin
  // Settings panel (no code change needed): strikeLockHours1/2/3/4Plus.
  //
  // During the lock, the worker still sees every order in the marketplace
  // (nothing is filtered out) — order.service.ts acceptOrder() is what
  // actually blocks them, with a message showing exactly how long is left.
  // This is deliberate: seeing orders they can't take is the whole point.
  async applyStrike(workerId: string): Promise<{ strikeCount: number; lockedUntil: Date }> {
    const worker = await User.findById(workerId);
    if (!worker || worker.role !== 'worker') {
      throwErr('Strike can only be applied to a worker account.', 400);
    }

    const newStrikeCount = (worker!.strikeCount ?? 0) + 1;
    const tierSettingKey =
      newStrikeCount === 1 ? 'strikeLockHours1' :
      newStrikeCount === 2 ? 'strikeLockHours2' :
      newStrikeCount === 3 ? 'strikeLockHours3' : 'strikeLockHours4Plus';
    const tierDefault =
      newStrikeCount === 1 ? '6' :
      newStrikeCount === 2 ? '24' :
      newStrikeCount === 3 ? '72' : '168';

    const hours = parseInt(await getSetting(tierSettingKey, tierDefault), 10) || parseInt(tierDefault, 10);
    const lockedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

    worker!.strikeCount   = newStrikeCount;
    worker!.lockedUntil   = lockedUntil;
    worker!.lastStrikeAt  = new Date();
    await worker!.save();

    // Close the "just make a new account" loophole — lock every IP on
    // record for this worker too, so a fresh registration or a login from
    // the same network inherits the same lock (see auth.service.ts).
    const ips = [worker!.registrationIp, worker!.lastLoginIp].filter(Boolean) as string[];
    await Promise.all(
      Array.from(new Set(ips)).map(ip =>
        LockedIp.findOneAndUpdate(
          { ip },
          { ip, workerId: worker!._id, lockedUntil, strikeCount: newStrikeCount },
          { upsert: true }
        )
      )
    );

    const hoursLabel = hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`;
    await notificationService.create({
      userId: worker!._id,
      title: `⚠️ Account Locked — Strike ${newStrikeCount}`,
      message:
        `A dispute against you was resolved in the customer's favor. Your account is locked for ` +
        `${hoursLabel} — you'll still see orders in the marketplace but can't accept any until the ` +
        `lock ends. Please make sure every account you deliver is genuine and working going forward, ` +
        `or future locks will be longer.`,
      type: 'dispute',
    });

    // 4+ strikes is a clear repeat-offender pattern — flag it for a human
    // to make the permanent call (existing isApproved suspend toggle),
    // rather than the system silently escalating forever on its own.
    if (newStrikeCount >= 4) {
      const admins = await User.find({ role: 'admin' }).select('_id');
      await Promise.all(admins.map(a => notificationService.create({
        userId: a._id,
        title: `🚨 Repeat Offender: ${worker!.name}`,
        message: `${worker!.name} has now received ${newStrikeCount} strikes for upheld disputes. Consider a permanent suspension from Users → this worker's profile.`,
        type: 'dispute',
      })));
    }

    if (worker!.isOnline) {
      pushLiveWorkerCount().catch(err =>
        console.error('[UserService] Failed to refresh worker count after strike:', err)
      );
    }

    return { strikeCount: newStrikeCount, lockedUntil };
  },
};
