import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole }  from '../middleware/role.middleware';
import { validate }     from '../middleware/validate.middleware';
import { updateSettingSchema } from '../validators/settings.validator';
import { User }              from '../models/User.model';
import { Order }             from '../models/Order.model';
import { Settings }          from '../models/Settings.model';
import { WithdrawRequest }   from '../models/WithdrawRequest.model';
import { RefundRequest }     from '../models/RefundRequest.model';
import { Dispute }           from '../models/Dispute.model';
import { Rating }            from '../models/Rating.model';
import { Wallet }             from '../models/Wallet.model';
import { WorkerLevelModel }  from '../models/WorkerLevel.model';
import { Transaction }        from '../models/Transaction.model';
import { Notification }       from '../models/Notification.model';
import { LockedIp }           from '../models/LockedIp.model';
import { LockedDevice }       from '../models/LockedDevice.model';
import { ApiKeyRotationState } from '../models/ApiKeyRotationState.model';
import { PERMANENT_LOCK_DATE } from '../utils/permanentLock';
import { withdrawalService } from '../services/withdrawal.service';
import { refundService }     from '../services/refund.service';
import { disputeService }    from '../services/dispute.service';
import { notificationService } from '../services/notification.service';
import { runAutoCompleteJob } from '../utils/autoComplete';
import { invalidateSettingsCache } from '../services/order.service';
import { emitToUser, EVENTS }  from '../socket/events';
import { computeLiveOnlineWorkerCount } from '../socket/socket';
import { userService } from '../services/user.service';
import { orderHistoryService } from '../services/orderHistory.service';
import { sendSuccess, sendError } from '../utils/response';
import { submitToIndexNow, ALL_PUBLIC_URLS } from '../utils/indexNow';
import { Request, Response }  from 'express';

const router = Router();
router.use(authenticate, requireRole('admin'));

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders,  completedOrders, totalOrders,
    pendingWithdrawals, pendingRefunds, openDisputes, todayOrders,
  ] = await Promise.all([
    User.countDocuments({ role: 'customer', isDeleted: { $ne: true } }),
    User.countDocuments({ role: 'worker', isDeleted: { $ne: true } }),
    // Live count (preference AND actually connected right now) — same
    // logic the real-time socket push uses, so the number is already
    // correct on first page load, not just after the next toggle/reconnect.
    computeLiveOnlineWorkerCount(),
    Order.countDocuments({ status: 'pending' }),
    Order.countDocuments({ status: 'completed' }),
    // FIX: this used to be a bare countDocuments() — every order document
    // ever created, including 'payment_pending' (customer hasn't finished
    // paying yet) and 'payment_failed' (payment attempt never succeeded —
    // no money moved, no worker was ever involved). Neither of those is a
    // real order; counting them inflated this number with pure checkout
    // noise. 'cancelled' orders ARE still counted — payment succeeded on
    // those, they were genuine orders that just didn't complete.
    Order.countDocuments({ status: { $nin: ['payment_pending', 'payment_failed'] } }),
    WithdrawRequest.countDocuments({ status: 'pending' }),
    RefundRequest.countDocuments({ status: 'pending' }),
    Dispute.countDocuments({ status: 'open' }),
    // Same fix applied here — "today's orders" should mean today's real
    // orders, not today's failed/abandoned checkout attempts.
    Order.countDocuments({ createdAt: { $gte: today }, status: { $nin: ['payment_pending', 'payment_failed'] } }),
  ]);

  // NEW: platformCommission is now tracked per-order (locked-in at creation).
  // This aggregation reports both gross revenue collected from customers
  // AND the platform's actual net commission earned — two different,
  // both-useful numbers now that pricing is customer-set rather than fixed.
  const revenueAgg = await Order.aggregate([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id:   null,
        total: { $sum: '$amount' },
        today: {
          $sum: { $cond: [{ $gte: ['$completedAt', today] }, '$amount', 0] },
        },
        commissionTotal: { $sum: '$platformCommission' },
        commissionToday: {
          $sum: { $cond: [{ $gte: ['$completedAt', today] }, '$platformCommission', 0] },
        },
        // NEW: wrong-password penalty (see wallet.service.ts
        // settleOrderEarnings()) is separate platform revenue from
        // commission — tracked on its own so it's visible as its own line
        // rather than getting silently folded into the commission number.
        penaltyTotal: { $sum: { $ifNull: ['$wrongPasswordPenaltyAmount', 0] } },
        penaltyToday: {
          $sum: { $cond: [{ $gte: ['$completedAt', today] }, { $ifNull: ['$wrongPasswordPenaltyAmount', 0] }, 0] },
        },
      },
    },
  ]);
  const revenue = revenueAgg[0] ?? { total: 0, today: 0, commissionTotal: 0, commissionToday: 0, penaltyTotal: 0, penaltyToday: 0 };

  // NEW: earliest account on record — bounds the admin dashboard's
  // analytics date-range picker (see /analytics below) so nobody can pick
  // a month/year before the platform actually had any data at all.
  const earliestUser = await User.findOne().sort({ createdAt: 1 }).select('createdAt').lean();

  sendSuccess(res, 'Stats fetched.', {
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders,  completedOrders, totalOrders, todayOrders,
    pendingWithdrawals, pendingRefunds, openDisputes,
    totalRevenue:    revenue.total,           // Gross — total collected from customers
    todayRevenue:    revenue.today,
    totalCommission: revenue.commissionTotal, // NEW: platform's actual net earnings
    todayCommission: revenue.commissionToday, // NEW
    totalPenalty:    revenue.penaltyTotal,    // NEW: wrong-password penalty revenue
    todayPenalty:    revenue.penaltyToday,    // NEW
    earliestDataDate: earliestUser?.createdAt ?? null, // NEW
  });
});

// ── Analytics (date-range aware) ──────────────────────────────────────────
// Powers all 3 admin dashboard charts (Revenue & Commission, Orders,
// Signups) with ONE shared endpoint and ONE shared date range, picked from
// the dashboard's range selector (7D / 30D / a specific month / a specific
// year / All Time). Defaults to the original last-7-days behavior when no
// range is given at all, so nothing existing breaks.
//
// Bucketing switches from DAY to MONTH once the requested range spans more
// than ~2 months — a year (or all-time, for an older account) charted
// day-by-day would be a few hundred unreadable points; month buckets stay
// readable at any span. There's no in-between "week" bucket — deliberately
// kept to two modes for simplicity, since this dashboard's real usage is
// either "the last few weeks" (day buckets) or "a whole year/all-time"
// (month buckets), never really an ambiguous middle case.
router.get('/analytics', async (req: Request, res: Response) => {
  const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let from: Date;
  let to: Date;

  if (req.query.from && req.query.to) {
    from = new Date(req.query.from as string);
    to   = new Date(req.query.to as string);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
      sendError(res, 'Invalid date range.', 400);
      return;
    }
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);
  } else {
    // Unchanged original default: last 7 days.
    to = new Date();
    to.setHours(23, 59, 59, 999);
    from = new Date();
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
  }

  const spanDays      = Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  const bucketByMonth = spanDays > 62;
  const dateFormat    = bucketByMonth ? '%Y-%m' : '%Y-%m-%d';

  const [revenueAgg, ordersAgg, signupsAgg] = await Promise.all([
    Order.aggregate([
      { $match: { status: 'completed', completedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:        { $dateToString: { format: dateFormat, date: '$completedAt' } },
          revenue:    { $sum: '$amount' },
          commission: { $sum: '$platformCommission' },
        },
      },
    ]),
    Order.aggregate([
      // Same fix as /stats above — a bucket's "orders" chart shouldn't
      // include checkout attempts that never became real orders.
      { $match: { createdAt: { $gte: from, $lte: to }, status: { $nin: ['payment_pending', 'payment_failed'] } } },
      {
        $group: {
          _id:    { $dateToString: { format: dateFormat, date: '$createdAt' } },
          orders: { $sum: 1 },
        },
      },
    ]),
    // Signups per bucket, split by role — every signup is already a User
    // document with its own createdAt, so this is just grouping data that
    // already exists, same as the two aggregations above it. This is the
    // "who's signing up" data Vercel Web Analytics can't show for free
    // (custom events there are a $20/mo Pro-plan-only feature).
    User.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, role: { $in: ['customer', 'worker'] }, isDeleted: { $ne: true } } },
      {
        $group: {
          _id:     { bucket: { $dateToString: { format: dateFormat, date: '$createdAt' } }, role: '$role' },
          signups: { $sum: 1 },
        },
      },
    ]),
  ]);

  const revenueMap: Record<string, number> = {};
  const commissionMap: Record<string, number> = {};
  revenueAgg.forEach(r => { revenueMap[r._id] = r.revenue; commissionMap[r._id] = r.commission; });

  const ordersMap: Record<string, number> = {};
  ordersAgg.forEach(o => { ordersMap[o._id] = o.orders; });

  const customerSignupsMap: Record<string, number> = {};
  const workerSignupsMap: Record<string, number> = {};
  signupsAgg.forEach((s: any) => {
    if (s._id.role === 'customer') customerSignupsMap[s._id.bucket] = s.signups;
    else workerSignupsMap[s._id.bucket] = s.signups;
  });

  const buckets: Array<{
    day: string; revenue: number; commission: number; orders: number;
    customerSignups: number; workerSignups: number;
  }> = [];

  if (!bucketByMonth) {
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().split('T')[0];
      // Always "Mon 8" rather than bare "Mon" — reads fine at 7 days, and
      // stays unambiguous once the range crosses into a second week
      // (where two Mondays would otherwise look identical on the chart).
      buckets.push({
        day:             `${DAY_NAMES[d.getDay()]} ${d.getDate()}`,
        revenue:         revenueMap[key] ?? 0,
        commission:      commissionMap[key] ?? 0,
        orders:          ordersMap[key] ?? 0,
        customerSignups: customerSignupsMap[key] ?? 0,
        workerSignups:   workerSignupsMap[key] ?? 0,
      });
    }
  } else {
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    const end    = new Date(to.getFullYear(), to.getMonth(), 1);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({
        day:             `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        revenue:         revenueMap[key] ?? 0,
        commission:      commissionMap[key] ?? 0,
        orders:          ordersMap[key] ?? 0,
        customerSignups: customerSignupsMap[key] ?? 0,
        workerSignups:   workerSignupsMap[key] ?? 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  sendSuccess(res, 'Analytics fetched.', buckets);
});

// ── API key rotation status (see utils/emailVerification.ts /
//    utils/phoneVerification.ts) ─────────────────────────────────────────
// Shows how many keys are configured and which (if any) are currently
// exhausted for the month, for each rotating provider — so you can see at
// a glance whether it's time to add more keys, without digging through
// logs.
router.get('/email-api-key-status', async (_req: Request, res: Response) => {
  sendSuccess(res, 'API key rotation status fetched.', {
    email: await getRotationStatus('abstract-email-reputation', process.env.ABSTRACT_EMAIL_API_KEYS || process.env.ABSTRACT_API_KEY),
    phone: await getRotationStatus('abstract-phone-intelligence', process.env.ABSTRACT_PHONE_API_KEYS || process.env.ABSTRACT_PHONE_API_KEY),
    ip:    await getRotationStatus('abstract-ip-intelligence', process.env.ABSTRACT_IP_API_KEYS || process.env.ABSTRACT_IP_API_KEY),
  });
});

async function getRotationStatus(stateId: string, keysEnvValue: string | undefined) {
  const configured = (keysEnvValue || '').split(',').map(k => k.trim()).filter(Boolean);
  const state = await ApiKeyRotationState.findById(stateId);
  const now = new Date();
  const exhaustedIndexes = state
    ? Array.from(state.exhausted.entries())
        .filter(([, until]) => until > now)
        .map(([idx]) => Number(idx))
    : [];

  return {
    totalKeys:      configured.length,
    exhaustedCount: exhaustedIndexes.length,
    availableCount: configured.length - exhaustedIndexes.length,
    // Keys themselves are never returned — only which numbered slot
    // (1-indexed, matching the order in the comma-separated env var) is
    // exhausted and when it resets, so nothing sensitive leaks here.
    exhaustedSlots: exhaustedIndexes.map(i => ({
      slot: i + 1,
      resetsAt: state!.exhausted.get(String(i)),
    })),
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', async (_req: Request, res: Response) => {
  const settings = await Settings.find().sort({ key: 1 });
  sendSuccess(res, 'Settings fetched.', settings);
});

router.put('/settings/:key', validate(updateSettingSchema), async (req: Request, res: Response) => {
  const { key }   = req.params;
  const { value } = req.body;
  const numValue  = Number(value);

  if (isNaN(numValue) || numValue <= 0) {
    sendError(res, 'Value must be a positive number.', 400);
    return;
  }

  // NEW: platformCommissionRate is a percentage — cap it at a sane maximum
  // so a typo (e.g. "150") can't silently break every future order's math.
  if (key === 'platformCommissionRate' && numValue > 100) {
    sendError(res, 'Commission rate cannot exceed 100%.', 400);
    return;
  }

  const setting = await Settings.findOneAndUpdate(
    { key },
    { value },
    { new: true }
  );

  if (!setting) { sendError(res, 'Setting not found.', 404); return; }

  invalidateSettingsCache();

  sendSuccess(res, 'Setting updated successfully.', setting);
});

// ── All orders ────────────────────────────────────────────────────────────────
router.get('/orders', async (req: Request, res: Response) => {
  const { status, page = '1', limit = '20' } = req.query;
  const filter = status ? { status } : {};
  const skip   = (Number(page) - 1) * Number(limit);

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .select('-credentials')
      .populate('customerId workerId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  sendSuccess(res, 'Orders fetched.', {
    orders,
    total,
    page:       Number(page),
    totalPages: Math.ceil(total / Number(limit)),
  });
});

// Full chronological event history for one order — powers the "View
// History" timeline in the admin All Orders panel. See
// services/orderHistory.service.ts / models/OrderHistory.model.ts.
router.get('/orders/:id/history', async (req: Request, res: Response) => {
  const history = await orderHistoryService.getForOrder(req.params.id);
  sendSuccess(res, 'Order history fetched.', history);
});

// ── All users ─────────────────────────────────────────────────────────────────
router.get('/users', async (req: Request, res: Response) => {
  const { role } = req.query;
  const filter   = role ? { role } : { role: { $ne: 'admin' } };
  const users    = await User.find(filter).sort({ createdAt: -1 });
  sendSuccess(res, 'Users fetched.', users);
});

// ── Approve / suspend worker ──────────────────────────────────────────────────
router.patch('/users/:id/approve', async (req: Request, res: Response) => {
  const { isApproved } = req.body;

  // Fetch first — we need to know the worker's CURRENT isApproved value
  // before overwriting it, to correctly backfill wasEverApproved.
  const existing = await User.findOne({ _id: req.params.id, role: 'worker' });
  if (!existing) { sendError(res, 'Worker not found.', 404); return; }

  const update: Record<string, unknown> = { isApproved };
  // Once a worker has ever been approved, remember that permanently — this
  // is what lets the Users list tell a first-time "Pending" worker apart
  // from one who was approved and later suspended (both have isApproved:
  // false, but only one of them should show "Suspended" + a "Reactivate"
  // button instead of "Pending" + "Approve").
  //
  // BUG FIX: workers approved before wasEverApproved existed in the schema
  // never had it persisted as true — so suspending one of them (isApproved
  // true -> false) with only `if (isApproved) update.wasEverApproved =
  // true` left it unset, and they incorrectly showed "Pending" instead of
  // "Suspended" afterward. Backfilling it here too — the moment we SEE a
  // worker was isApproved:true right before this update — self-heals every
  // such worker the first time an admin suspends them, no separate
  // migration script needed.
  if (isApproved || existing.isApproved) update.wasEverApproved = true;

  // ── Manual-suspend IP + device lock (closes a real evasion gap) ───────
  // Previously, ONLY the automatic strike/theft-penalty paths locked a
  // worker's IPs/devices (see user.service.ts applyStrike()/
  // applyTheftPenalty()). A worker an admin suspended manually — for
  // anything strikes/theft-detection didn't automatically catch — could
  // just sign up again from the same network or browser with a new email
  // and start over immediately. This mirrors the exact same lock those
  // automatic paths apply.
  if (!isApproved && existing.isApproved) {
    update.lockedUntil = PERMANENT_LOCK_DATE;
    const ips = [existing.registrationIp, existing.lastLoginIp].filter(Boolean) as string[];
    const devices = [existing.registrationDevice, existing.lastLoginDevice].filter(Boolean) as string[];
    await Promise.all([
      ...Array.from(new Set(ips)).map(ip =>
        LockedIp.findOneAndUpdate(
          { ip },
          { ip, workerId: existing._id, lockedUntil: PERMANENT_LOCK_DATE, strikeCount: existing.strikeCount ?? 0 },
          { upsert: true }
        )
      ),
      ...Array.from(new Set(devices)).map(deviceId =>
        LockedDevice.findOneAndUpdate(
          { deviceId },
          { deviceId, workerId: existing._id, lockedUntil: PERMANENT_LOCK_DATE, strikeCount: existing.strikeCount ?? 0 },
          { upsert: true }
        )
      ),
    ]);

    // NEW: a deliberate admin permanent-suspend gets the same linked-
    // account cascade as an automatic confirmed-theft ban — see
    // user.service.ts banLinkedAccounts() for the matching rule (both IP
    // AND device required).
    await userService.banLinkedAccounts(existing._id, ips, devices).catch(err =>
      console.error('[Admin] Failed to cascade-ban linked accounts:', err)
    );
  }
  // Reactivating a previously-suspended worker — undo the lock above so
  // they can actually accept orders again, and release any IPs/devices
  // THIS suspension locked (only entries still attributed to this worker,
  // so we don't accidentally unlock one a different worker's violation has
  // since re-locked).
  if (isApproved && !existing.isApproved) {
    update.lockedUntil = null;
    await Promise.all([
      LockedIp.deleteMany({ workerId: existing._id }),
      LockedDevice.deleteMany({ workerId: existing._id }),
    ]);
  }

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'worker' },
    update,
    { new: true }
  );
  if (!user) { sendError(res, 'Worker not found.', 404); return; }

  if (isApproved) {
    await notificationService.create({
      userId:  user._id,
      title:   '✅ Account Approved!',
      message: 'Your worker account has been approved. You can now accept orders from the marketplace.',
      type:    'system',
    });
    emitToUser(user._id.toString(), EVENTS.WORKER_APPROVED, {});
  } else {
    // FIX: this branch never existed before — a suspended worker got no
    // notification and no live update at all, only finding out the next
    // time they happened to log in.
    await notificationService.create({
      userId:  user._id,
      title:   '⛔ Account Suspended',
      message: 'Your worker account has been suspended by an admin, and your account\'s known network(s) have been locked to prevent new signups from them. Contact support if you believe this is a mistake.',
      type:    'system',
    });
    emitToUser(user._id.toString(), EVENTS.WORKER_SUSPENDED, {});
  }

  sendSuccess(res, `Worker ${isApproved ? 'approved' : 'suspended'}.`, user);
});

// New: per-user detail view — full history in one place instead of admin
// having to cross-reference the Orders/Disputes pages manually.
// Works for both workers and customers: a worker gets their earnings stats,
// wallet, and rating history on top of shared order/dispute history; a
// customer just gets their order/dispute history.
router.get('/users/:id/detail', async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id);
  if (!user) { sendError(res, 'User not found.', 404); return; }

  const isWorker    = user.role === 'worker';
  const partyFilter = isWorker ? { workerId: user._id } : { customerId: user._id };

  const [orders, disputes, workerLevel, wallet, recentTransactions, recentRatings] = await Promise.all([
    Order.find(partyFilter)
      .select('-credentials')
      .populate('customerId workerId', 'name email')
      .sort({ createdAt: -1 })
      .limit(25),
    Dispute.find(partyFilter)
      .populate('orderId', 'serviceName')
      .sort({ createdAt: -1 })
      .limit(25),
    isWorker ? WorkerLevelModel.findOne({ workerId: user._id }) : null,
    // FIX: was worker-only before — customers have wallets too now
    // (refund credits, and wallet recharge via Cashfree), so admin
    // couldn't see a customer's wallet balance at all previously.
    Wallet.findOne({ userId: user._id }),
    Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20),
    isWorker
      ? Rating.find({ workerId: user._id })
          .populate('customerId', 'name')
          .sort({ createdAt: -1 })
          .limit(10)
      : null,
  ]);

  sendSuccess(res, 'User detail fetched.', {
    user,
    orders,
    disputes,
    workerLevel,
    wallet,
    recentTransactions,
    recentRatings,
  });
});

// Admin: manually lift a worker's dispute-strike lock early (a "pardon") —
// doesn't reset their strike count (that stays as history), just ends the
// current lock immediately.
router.post('/users/:id/unlock', async (req: Request, res: Response) => {
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'worker' },
    { $unset: { lockedUntil: 1 } },
    { new: true }
  );
  if (!user) { sendError(res, 'Worker not found.', 404); return; }
  sendSuccess(res, 'Lock lifted — they can accept orders again immediately.', user);
});

// Admin: delete any user's account (soft delete — see user.service.ts).
// Blocked if that account has an order actively in progress.
router.delete('/users/:id', async (req: Request, res: Response) => {
  await userService.deleteAccount(req.params.id);
  sendSuccess(res, 'Account deleted.', {});
});

// Admin: wipe ONE user's history/activity data — orders, disputes,
// transactions, notifications, ratings, wallet + worker level stats — while
// leaving the account itself (and the other party's copy of anything
// shared) alone... except that shared orders/disputes ARE deleted outright
// here (unlike account deletion), so this genuinely removes them from the
// other party's history too. Gated by a typed confirmation, same pattern
// as the platform-wide Danger Zone reset.
router.post('/users/:id/clear-data', async (req: Request, res: Response) => {
  const { confirm } = req.body;
  if (confirm !== 'CLEAR') {
    sendError(res, 'Confirmation phrase did not match. Nothing was deleted.', 400);
    return;
  }
  const result = await userService.clearUserData(req.params.id);
  sendSuccess(res, "This user's data has been cleared. Their account was left untouched.", result);
});

// ── Wallet transactions (admin-wide monitoring) ─────────────────────────
// Lets admin browse recharges, refunds, earnings, withdrawals across every
// user without needing to open each user's detail page individually.
// Optional ?type=recharge|credit|debit|withdrawal to filter.
router.get('/wallet-transactions', async (req: Request, res: Response) => {
  const { type } = req.query;
  const filter: Record<string, unknown> = {};
  if (type && typeof type === 'string') filter.type = type;

  const transactions = await Transaction.find(filter)
    .populate('userId', 'name email role')
    .populate('orderId', 'serviceName')
    .sort({ createdAt: -1 })
    .limit(200);

  sendSuccess(res, 'Wallet transactions fetched.', transactions);
});

// ── Referral program monitoring ─────────────────────────────────────────
// Platform-wide view of every worker OR customer who's referred someone,
// how many they've referred, and total payouts — the per-account "Refer &
// Earn" page (see user.routes.ts /me/referral) only shows one person's
// own numbers. CROSS-ROLE: a referrer's list can now contain a genuine mix
// of workers and customers (see auth.service.ts register()), so this no
// longer filters the referred list by the referrer's own role — it used
// to, which silently hid every cross-role referral from this view even
// though the payout itself was already working correctly.
router.get('/referrals', async (_req: Request, res: Response) => {
  const referrers = await User.find({ role: { $in: ['worker', 'customer'] } })
    .select('name email role referralCode')
    .lean();

  const withReferrals = await Promise.all(
    referrers
      .filter(r => r.referralCode)
      .map(async r => {
        const referred = await User.find({ referredBy: r._id }).select('name role createdAt').lean();
        if (referred.length === 0) return null;

        const totalPaidAgg = await Transaction.aggregate([
          { $match: { userId: r._id, type: 'credit', description: /^Referral bonus/, status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);

        return {
          referrer: { _id: r._id, name: r.name, email: r.email, role: r.role, referralCode: r.referralCode },
          referredCount: referred.length,
          referred,
          totalPaid: totalPaidAgg[0]?.total ?? 0,
        };
      })
  );

  const result = withReferrals.filter(Boolean).sort((a: any, b: any) => b.totalPaid - a.totalPaid);
  sendSuccess(res, 'Referrals fetched.', result);
});

// ── Withdrawals ───────────────────────────────────────────────────────────────
router.get('/withdrawals', async (_req: Request, res: Response) => {
  const reqs = await withdrawalService.getAllRequests();
  sendSuccess(res, 'Withdrawal requests fetched.', reqs);
});

router.patch('/withdrawals/:id', async (req: Request, res: Response) => {
  const { status, adminNote } = req.body;
  if (!['approved', 'rejected', 'completed'].includes(status)) {
    sendError(res, 'Invalid status.', 400); return;
  }
  const wr = await withdrawalService.updateStatus(req.params.id, status, adminNote);
  sendSuccess(res, 'Withdrawal updated.', wr);
});

// ── Refunds ───────────────────────────────────────────────────────────────────
router.get('/refunds', async (_req: Request, res: Response) => {
  const refunds = await refundService.getAllRefunds();
  sendSuccess(res, 'Refund requests fetched.', refunds);
});

router.patch('/refunds/:id', async (req: Request, res: Response) => {
  const { status, adminNote } = req.body;
  if (!['completed', 'rejected'].includes(status)) {
    sendError(res, 'Invalid status.', 400); return;
  }
  const refund = await refundService.updateStatus(req.params.id, status, adminNote);
  sendSuccess(res, 'Refund updated.', refund);
});

// ── Disputes ──────────────────────────────────────────────────────────────────
router.get('/disputes', async (_req: Request, res: Response) => {
  const disputes = await disputeService.getAll();
  sendSuccess(res, 'Disputes fetched.', disputes);
});

// Full context for one dispute (order + credentials + customer/worker
// history) — fetched only when the admin opens the Review modal.
router.get('/disputes/:id/detail', async (req: Request, res: Response) => {
  const detail = await disputeService.getById(req.params.id);
  sendSuccess(res, 'Dispute detail fetched.', detail);
});

router.patch('/disputes/:id', async (req: Request, res: Response) => {
  const { status, adminNote } = req.body;
  if (!['resolved', 'rejected'].includes(status)) {
    sendError(res, 'Status must be resolved or rejected.', 400); return;
  }
  const d = await disputeService.resolve(req.params.id, status, adminNote);
  sendSuccess(res, 'Dispute updated.', d);
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
// Admin sees the FULL ranked list (no top-10 cap like the worker/customer-
// facing leaderboards) — this is a review tool, not a "hall of fame" widget,
// so admin needs to see everyone who has actually done something on the
// platform, not just the top performers.
router.get('/leaderboard', async (_req: Request, res: Response) => {
  // Same fix as leaderboard.routes.ts — only workers who've actually
  // completed at least one order get a meaningful rank; otherwise a batch
  // of freshly-reset/registered workers all tied at 0 would show up
  // ordered by MongoDB's natural/insertion order, which looks like a real
  // but meaningless ranking. This also naturally excludes workers who
  // signed up and never did anything ("registered then went idle").
  const top = await WorkerLevelModel.find({ completedOrders: { $gt: 0 } })
    .populate('workerId', 'name email profileImage level')
    .sort({ completedOrders: -1, averageRating: -1, _id: 1 });
  sendSuccess(res, 'Leaderboard fetched.', top);
});

// Customer leaderboard, admin view — same "full list, real activity only"
// shape as the worker one above. No CustomerLevel collection exists (unlike
// WorkerLevel for workers), so this aggregates directly off completed
// Orders, same query as the customer-facing GET /api/leaderboard/customer
// (spend-ranked — see that route's comment for why), just without the
// top-10 limit.
router.get('/leaderboard/customer', async (_req: Request, res: Response) => {
  const top = await Order.aggregate([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id: '$customerId',
        completedOrders: { $sum: 1 },
        totalSpent: { $sum: '$amount' },
      },
    },
    { $sort: { totalSpent: -1, completedOrders: -1, _id: 1 } },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: '$customer' },
    {
      $project: {
        _id: 1,
        completedOrders: 1,
        totalSpent: 1,
        'customer.name': 1,
        'customer.email': 1,
        'customer.profileImage': 1,
      },
    },
  ]);
  sendSuccess(res, 'Leaderboard fetched.', top);
});

// Manually run the auto-complete/auto-cancel sweep right now instead of
// waiting for the next 5-minute interval — useful right after fixing a bug
// that was silently blocking it, or any time an admin wants to confirm
// stuck orders clear immediately rather than waiting.
router.post('/run-auto-complete', async (_req: Request, res: Response) => {
  await runAutoCompleteJob();
  sendSuccess(res, 'Auto-complete sweep finished. Check Orders to confirm stuck ones cleared.', {});
});

// ── Danger zone: reset all test/activity data ─────────────────────────────────
// Wipes every order, dispute, refund/withdraw request, transaction,
// notification, and rating, and zeroes out every wallet + worker level —
// leaving every USER ACCOUNT (name/email/password/role/approval status/
// profile picture), Settings, and push subscriptions completely untouched.
// This is for going from "tested with dummy activity" to "launch-ready with
// real accounts, zero history" without recreating any accounts.
//
// Gated by requireRole('admin') above (whole router) PLUS a typed
// confirmation phrase in the body, so it can never fire from a stray click —
// there is no undo once this runs.
router.post('/reset-test-data', async (req: Request, res: Response) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET') {
    sendError(res, 'Confirmation phrase did not match. Nothing was deleted.', 400);
    return;
  }

  const [orders, disputes, refunds, withdrawals, transactions, notifications, ratings] =
    await Promise.all([
      Order.deleteMany({}),
      Dispute.deleteMany({}),
      RefundRequest.deleteMany({}),
      WithdrawRequest.deleteMany({}),
      Transaction.deleteMany({}),
      Notification.deleteMany({}),
      Rating.deleteMany({}),
    ]);

  const walletReset = await Wallet.updateMany(
    {},
    { $set: { balance: 0, pendingBalance: 0, totalEarned: 0 } }
  );
  const levelReset = await WorkerLevelModel.updateMany(
    {},
    { $set: { level: 'bronze', completedOrders: 0, totalEarnings: 0, successRate: 100, averageRating: 0 } }
  );

  sendSuccess(res, 'All test data cleared. User accounts were left untouched.', {
    ordersDeleted:        orders.deletedCount,
    disputesDeleted:      disputes.deletedCount,
    refundsDeleted:       refunds.deletedCount,
    withdrawalsDeleted:   withdrawals.deletedCount,
    transactionsDeleted:  transactions.deletedCount,
    notificationsDeleted: notifications.deletedCount,
    ratingsDeleted:       ratings.deletedCount,
    walletsReset:         walletReset.modifiedCount,
    workerLevelsReset:    levelReset.modifiedCount,
  });
});


// ── SEO: manual IndexNow submission ────────────────────────────────────────
// One-click way to tell Bing/Yandex/other IndexNow participants "come
// re-crawl the public marketing pages" — see utils/indexNow.ts for why
// this exists and what it does and doesn't cover (notably: not Google,
// which has its own separate "Request Indexing" in Search Console).
// Deliberately a manual admin action rather than something that fires
// automatically on every deploy — this whole site is a small, mostly-
// static set of pages that only meaningfully change every so often, so an
// admin clicking this right after a real content update is more useful
// (and less spammy toward the IndexNow endpoint) than pinging on every
// redeploy regardless of whether anything on these pages actually changed.
router.post('/seo/indexnow-ping', async (_req: Request, res: Response) => {
  const ok = await submitToIndexNow(ALL_PUBLIC_URLS);
  if (!ok) {
    sendError(res, 'IndexNow submission failed — check server logs for details.', 502);
    return;
  }
  sendSuccess(res, `Submitted ${ALL_PUBLIC_URLS.length} URLs to IndexNow.`, { urls: ALL_PUBLIC_URLS });
});

export default router;
