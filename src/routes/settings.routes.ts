import { Router, Request, Response } from 'express';
import { getPublicSettings } from '../services/order.service';
import { Order } from '../models/Order.model';
import { User } from '../models/User.model';
import { sendSuccess } from '../utils/response';

const router = Router();

// Public — intentionally NOT behind `authenticate`. The register page (before
// login) and every dashboard need to show the real, current order price and
// worker earning instead of a hardcoded number that goes stale the moment
// admin changes it from the Settings page. Neither value is sensitive.
router.get('/public', async (_req: Request, res: Response) => {
  const settings = await getPublicSettings();
  sendSuccess(res, 'Public settings fetched.', settings);
});

// Public — powers the homepage's "trust" strip (see app/page.tsx). ONLY ever
// real, live numbers pulled straight from the database — never a fabricated
// or rounded-up figure. Deliberately limited to two harmless aggregate
// counts (no revenue, no per-user data, nothing sensitive) — completed
// orders and approved workers are the two numbers that actually mean
// something to a first-time visitor deciding whether to trust the
// platform, and neither one reveals anything about any individual account.
router.get('/public-stats', async (_req: Request, res: Response) => {
  const [completedOrders, approvedWorkers] = await Promise.all([
    Order.countDocuments({ status: 'completed' }),
    User.countDocuments({ role: 'worker', isApproved: true, isDeleted: { $ne: true } }),
  ]);
  sendSuccess(res, 'Public stats fetched.', { completedOrders, approvedWorkers });
});

export default router;
