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
import { withdrawalService } from '../services/withdrawal.service';
import { refundService }     from '../services/refund.service';
import { disputeService }    from '../services/dispute.service';
import { notificationService } from '../services/notification.service';
import { runAutoCompleteJob } from '../utils/autoComplete';
import { invalidateSettingsCache } from '../services/order.service';
import { emitToUser, EVENTS }  from '../socket/events';
import { computeLiveOnlineWorkerCount } from '../socket/socket';
import { userService } from '../services/user.service';
import { sendSuccess, sendError } from '../utils/response';
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
    Order.countDocuments(),
    WithdrawRequest.countDocuments({ status: 'pending' }),
    RefundRequest.countDocuments({ status: 'pending' }),
    Dispute.countDocuments({ status: 'open' }),
    Order.countDocuments({ createdAt: { $gte: today } }),
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
      },
    },
  ]);
  const revenue = revenueAgg[0] ?? { total: 0, today: 0, commissionTotal: 0, commissionToday: 0 };

  sendSuccess(res, 'Stats fetched.', {
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders,  completedOrders, totalOrders, todayOrders,
    pendingWithdrawals, pendingRefunds, openDisputes,
    totalRevenue:    revenue.total,           // Gross — total collected from customers
    todayRevenue:    revenue.today,
    totalCommission: revenue.commissionTotal, // NEW: platform's actual net earnings
    todayCommission: revenue.commissionToday, // NEW
  });
});

// ── Weekly Analytics ──────────────────────────────────────────────────────────
router.get('/analytics', async (_req: Request, res: Response) => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const [revenueAgg, ordersAgg] = await Promise.all([
    Order.aggregate([
      { $match: { status: 'completed', completedAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id:     { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
          revenue: { $sum: '$amount' },
          // NEW: commission earned per day, for a separate chart series
          commission: { $sum: '$platformCommission' },
        },
      },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id:    { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
        },
      },
    ]),
  ]);

  const revenueMap: Record<string, number> = {};
  const commissionMap: Record<string, number> = {};
  revenueAgg.forEach(r => { revenueMap[r._id] = r.revenue; commissionMap[r._id] = r.commission; });

  const ordersMap: Record<string, number> = {};
  ordersAgg.forEach(o => { ordersMap[o._id] = o.orders; });

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const dateStr = d.toISOString().split('T')[0];
    days.push({
      day:        DAY_NAMES[d.getDay()],
      revenue:    revenueMap[dateStr] ?? 0,
      commission: commissionMap[dateStr] ?? 0,
      orders:     ordersMap[dateStr] ?? 0,
    });
  }

  sendSuccess(res, 'Analytics fetched.', days);
});

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
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'worker' },
    { isApproved },
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
      message: 'Your worker account has been suspended by an admin. Contact support if you believe this is a mistake.',
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
// Platform-wide view of every worker who referred someone, how many
// they've referred, and total payouts — the per-worker "Refer & Earn" page
// (see user.routes.ts /me/referral) only shows one person's own numbers.
router.get('/referrals', async (_req: Request, res: Response) => {
  const referrers = await User.find({ role: 'worker' })
    .select('name email referralCode')
    .lean();

  const withReferrals = await Promise.all(
    referrers
      .filter(r => r.referralCode)
      .map(async r => {
        const referred = await User.find({ referredBy: r._id }).select('name createdAt').lean();
        if (referred.length === 0) return null;

        const totalPaidAgg = await Transaction.aggregate([
          { $match: { userId: r._id, type: 'credit', description: /^Referral bonus/, status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);

        return {
          referrer: { _id: r._id, name: r.name, email: r.email, referralCode: r.referralCode },
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
router.get('/leaderboard', async (_req: Request, res: Response) => {
  // Same fix as leaderboard.routes.ts — only workers who've actually
  // completed at least one order get a meaningful rank; otherwise a batch
  // of freshly-reset/registered workers all tied at 0 would show up
  // ordered by MongoDB's natural/insertion order, which looks like a real
  // but meaningless ranking.
  const top = await WorkerLevelModel.find({ completedOrders: { $gt: 0 } })
    .populate('workerId', 'name email profileImage level')
    .sort({ completedOrders: -1, averageRating: -1, _id: 1 })
    .limit(10);
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

// ── TEMPORARY DIAGNOSTIC — Abstract API integration debugging ──────────────
// Runs the exact same request Render's production network would make, but
// returns the FULL raw response (status, headers, body) instead of just
// logging a truncated line — lets us see things a normal app log can't,
// like whether a WAF/CDN is intercepting the request before it reaches
// Abstract's actual app.
// DELETE THIS ROUTE once the integration is confirmed working — it's
// admin-only, but it's still hitting a third party with our real API key
// on demand and has no business staying in the codebase long-term.
router.get('/debug/email-verify-test', requireRole('admin'), async (req, res) => {
  const email = (req.query.email as string) || 'test@gmail.com';
  const apiKey = process.env.ABSTRACT_API_KEY;

  if (!apiKey) {
    return res.json({ error: 'ABSTRACT_API_KEY is not set in this environment.' });
  }

  const url = `https://emailreputation.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    const bodyText = await upstream.text();
    const headersObj: Record<string, string> = {};
    upstream.headers.forEach((value, key) => { headersObj[key] = value; });

    res.json({
      requestUrl: url.replace(apiKey, apiKey.slice(0, 4) + '...' + apiKey.slice(-4)),
      responseStatus: upstream.status,
      responseHeaders: headersObj,
      responseBody: bodyText.slice(0, 2000), // cap in case it's a huge HTML page
    });
  } catch (err: any) {
    res.json({ requestUrl: url.replace(apiKey, apiKey.slice(0, 4) + '...' + apiKey.slice(-4)), error: err?.message || String(err) });
  }
});

export default router;
