import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { sendSuccess } from '../utils/response';

const router = Router();

// Workers can see the leaderboard (admin already has its own copy of this
// query at /api/admin/leaderboard — that one requires admin role and is
// used for the admin panel; this one is worker-facing).
router.get('/', authenticate, requireRole('worker'), async (req: Request, res: Response) => {
  // FIX: previously included EVERY worker regardless of completedOrders,
  // so a batch of freshly-registered (or freshly-reset) workers all tied
  // at 0 completed orders would still show up as a "Top 10" ordered by
  // MongoDB's natural/insertion order — which looks exactly like
  // "whoever registered first wins", not a real ranking. Only workers who
  // have actually completed at least one order have a meaningful rank.
  const top = await WorkerLevelModel.find({ completedOrders: { $gt: 0 } })
    .populate('workerId', 'name profileImage level')
    .sort({ completedOrders: -1, averageRating: -1, _id: 1 })
    .limit(10);

  const myLevel = await WorkerLevelModel.findOne({ workerId: req.user!._id });

  // Compute the requesting worker's own rank even if they're outside the
  // top 10 — lets them see "You are #23" instead of nothing.
  // A worker with 0 completed orders hasn't earned a rank yet, so this
  // stays null for them rather than the old bug where everyone tied at 0
  // independently computed themselves as "#1".
  let myRank: number | null = null;
  if (myLevel && myLevel.completedOrders > 0) {
    const betterCount = await WorkerLevelModel.countDocuments({
      completedOrders: { $gt: 0 },
      $or: [
        { completedOrders: { $gt: myLevel.completedOrders } },
        { completedOrders: myLevel.completedOrders, averageRating: { $gt: myLevel.averageRating } },
      ],
    });
    myRank = betterCount + 1;
  }

  sendSuccess(res, 'Leaderboard fetched.', { top, myRank, myStats: myLevel });
});

export default router;
