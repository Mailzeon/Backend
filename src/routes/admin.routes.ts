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
import { WorkerLevelModel }  from '../models/WorkerLevel.model';
import { withdrawalService } from '../services/withdrawal.service';
import { refundService }     from '../services/refund.service';
import { disputeService }    from '../services/dispute.service';
import { notificationService } from '../services/notification.service';
import { invalidateSettingsCache } from '../services/order.service';
import { emitToUser, EVENTS }  from '../socket/events';
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
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'worker' }),
    User.countDocuments({ role: 'worker', isOnline: true }),
    Order.countDocuments({ status: 'pending' }),
    Order.countDocuments({ status: 'completed' }),
    Order.countDocuments(),
    WithdrawRequest.countDocuments({ status: 'pending' }),
    RefundRequest.countDocuments({ status: 'pending' }), // NEW
    Dispute.countDocuments({ status: 'open' }),
    Order.countDocuments({ createdAt: { $gte: today } }),
  ]);

  const revenueAgg = await Order.aggregate([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id:   null,
        total: { $sum: '$amount' },
        today: {
          $sum: { $cond: [{ $gte: ['$completedAt', today] }, '$amount', 0] },
        },
      },
    },
  ]);
  const revenue = revenueAgg[0] ?? { total: 0, today: 0 };

  sendSuccess(res, 'Stats fetched.', {
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders,  completedOrders, totalOrders, todayOrders,
    pendingWithdrawals, pendingRefunds, openDisputes,
    totalRevenue: revenue.total,
    todayRevenue: revenue.today,
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
  revenueAgg.forEach(r => { revenueMap[r._id] = r.revenue; });

  const ordersMap: Record<string, number> = {};
  ordersAgg.forEach(o => { ordersMap[o._id] = o.orders; });

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const dateStr = d.toISOString().split('T')[0];
    days.push({
      day:     DAY_NAMES[d.getDay()],
      revenue: revenueMap[dateStr] ?? 0,
      orders:  ordersMap[dateStr]  ?? 0,
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

  if (isNaN(Number(value)) || Number(value) <= 0) {
    sendError(res, 'Value must be a positive number.', 400);
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
  }

  sendSuccess(res, `Worker ${isApproved ? 'approved' : 'suspended'}.`, user);
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

// ── Refunds (NEW) ──────────────────────────────────────────────────────────────
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
  const top = await WorkerLevelModel.find()
    .populate('workerId', 'name email profileImage level')
    .sort({ completedOrders: -1, averageRating: -1 })
    .limit(10);
  sendSuccess(res, 'Leaderboard fetched.', top);
});

export default router;
