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
  const top = await WorkerLevelModel.find()
    .populate('workerId', 'name profileImage level')
    .sort({ completedOrders: -1, averageRating: -1 })
    .limit(10);

  const myLevel = await WorkerLevelModel.findOne({ workerId: req.user!._id });

  // Compute the requesting worker's own rank even if they're outside the
  // top 10 — lets them see "You are #23" instead of nothing.
  let myRank: number | null = null;
  if (myLevel) {
    const betterCount = await WorkerLevelModel.countDocuments({
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
