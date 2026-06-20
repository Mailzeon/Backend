import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { User } from '../models/User.model';
import { Order } from '../models/Order.model';
import { WithdrawRequest } from '../models/WithdrawRequest.model';
import { Dispute } from '../models/Dispute.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { withdrawalService } from '../services/withdrawal.service';
import { disputeService } from '../services/dispute.service';
import { notificationService } from '../services/notification.service';
import { emitToUser, EVENTS } from '../socket/events';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate, requireRole('admin'));

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  const today = new Date(); today.setHours(0,0,0,0);

  const [
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders, completedOrders, totalOrders,
    pendingWithdrawals, openDisputes,
    todayOrders,
  ] = await Promise.all([
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'worker' }),
    User.countDocuments({ role: 'worker', isOnline: true }),
    Order.countDocuments({ status: 'pending' }),
    Order.countDocuments({ status: 'completed' }),
    Order.countDocuments(),
    WithdrawRequest.countDocuments({ status: 'pending' }),
    Dispute.countDocuments({ status: 'open' }),
    Order.countDocuments({ createdAt: { $gte: today } }),
  ]);

  // Revenue = sum of all completed order amounts
  const revenueAgg = await Order.aggregate([
    { $match: { status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' }, today: {
      $sum: { $cond: [{ $gte: ['$completedAt', today] }, '$amount', 0] }
    }}}
  ]);
  const revenue = revenueAgg[0] ?? { total: 0, today: 0 };

  sendSuccess(res, 'Stats fetched.', {
    totalCustomers, totalWorkers, onlineWorkers,
    pendingOrders, completedOrders, totalOrders, todayOrders,
    pendingWithdrawals, openDisputes,
    totalRevenue: revenue.total, todayRevenue: revenue.today,
  });
});

// ── All orders ────────────────────────────────────────────────────────────────
router.get('/orders', async (req: Request, res: Response) => {
  const { status, page = '1', limit = '20' } = req.query;
  const filter = status ? { status } : {};
  const skip   = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).select('-credentials').populate('customerId workerId', 'name email').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    Order.countDocuments(filter),
  ]);
  sendSuccess(res, 'Orders fetched.', { orders, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
});

// ── All users ─────────────────────────────────────────────────────────────────
router.get('/users', async (req: Request, res: Response) => {
  const { role } = req.query;
  const filter = role ? { role } : { role: { $ne: 'admin' } };
  const users  = await User.find(filter).sort({ createdAt: -1 });
  sendSuccess(res, 'Users fetched.', users);
});

// ── Approve / reject worker ───────────────────────────────────────────────────
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
  if (!['approved','rejected','completed'].includes(status)) {
    sendError(res, 'Invalid status.', 400); return;
  }
  const wr = await withdrawalService.updateStatus(req.params.id, status, adminNote);
  sendSuccess(res, 'Withdrawal updated.', wr);
});

// ── Disputes ──────────────────────────────────────────────────────────────────
router.get('/disputes', async (_req: Request, res: Response) => {
  const disputes = await disputeService.getAll();
  sendSuccess(res, 'Disputes fetched.', disputes);
});

router.patch('/disputes/:id', async (req: Request, res: Response) => {
  const { status, adminNote } = req.body;
  if (!['resolved','rejected'].includes(status)) {
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


// ── Weekly Analytics (real data for dashboard charts) ────────────────────────
router.get('/analytics', async (_req: Request, res: Response) => {
  const days = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let i = 6; i >= 0; i--) {
    const start = new Date();
    start.setDate(start.getDate() - i);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const [revenueAgg, orderCount] = await Promise.all([
      Order.aggregate([
        { $match: { status: 'completed', completedAt: { $gte: start, $lt: end } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Order.countDocuments({ createdAt: { $gte: start, $lt: end } }),
    ]);

    days.push({
      day:     dayNames[start.getDay()],
      revenue: revenueAgg[0]?.total ?? 0,
      orders:  orderCount,
    });
  }

  sendSuccess(res, 'Analytics fetched.', days);
});

export default router;
