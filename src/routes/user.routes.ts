import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { upload } from '../middleware/upload.middleware';
import { uploadProfileImage } from '../controllers/user.controller';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { Order } from '../models/Order.model';
import { Transaction } from '../models/Transaction.model';
import { sendSuccess, sendError } from '../utils/response';
import { userService } from '../services/user.service';
import { generateUniqueReferralCode } from '../services/auth.service';

const router = Router();
router.use(authenticate);

// NOTE: the old PATCH /status (manual online/offline toggle) has been
// removed on purpose. A worker is now automatically "online" for as long
// as they have the app open — see socket.ts join-room/disconnect handlers —
// with zero manual step and nothing to forget to flip back on.

// Update profile / payment details
router.put('/profile', async (req: Request, res: Response) => {
  const { name, upiId, bankDetails } = req.body;
  const updates: Record<string, unknown> = {};
  if (name?.trim()) updates.name = name.trim();
  if (upiId !== undefined) updates.upiId = upiId;
  if (bankDetails) updates.bankDetails = bankDetails;
  const user = await User.findByIdAndUpdate(req.user!._id, updates, { new: true });
  sendSuccess(res, 'Profile updated.', user);
});

// New: upload/replace profile picture. 'image' must match the FormData
// field name the frontend sends (see ProfileImageUploader.tsx).
router.post('/profile-image', upload.single('image'), uploadProfileImage);

// New: pinged by AppInstallDetector.tsx when the frontend detects it's
// running in standalone/installed mode. Cheap, no-op-safe to call
// repeatedly (every app open), used purely to track who's actually using
// the installed PWA vs. the plain browser.
router.post('/mark-installed', async (req: Request, res: Response) => {
  await User.findByIdAndUpdate(req.user!._id, {
    hasInstalledApp: true,
    lastSeenAsInstalledApp: new Date(),
  });
  sendSuccess(res, 'Noted.');
});

// ── Referral program (workers only) ─────────────────────────────────────
// See auth.service.ts register() for how a referral gets recorded, and
// wallet.service.ts settleOrderEarnings() for how the referral tax is
// actually paid out on each of the referred worker's completed orders.
router.get('/me/referral', requireRole('worker'), async (req: Request, res: Response) => {
  let me = await User.findById(req.user!._id).select('referralCode');

  // Backfill for workers who registered before this feature existed — they
  // never got a referralCode assigned at signup, so generate one the first
  // time they open this page instead of leaving it blank forever.
  if (!me?.referralCode) {
    const code = await generateUniqueReferralCode();
    me = await User.findByIdAndUpdate(req.user!._id, { referralCode: code }, { new: true }).select('referralCode');
  }

  const referred = await User.find({ referredBy: req.user!._id })
    .select('name createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const referredIds = referred.map(r => r._id);
  const completedCounts = referredIds.length > 0
    ? await Order.aggregate([
        { $match: { workerId: { $in: referredIds }, status: 'completed' } },
        { $group: { _id: '$workerId', count: { $sum: 1 } } },
      ])
    : [];
  const completedMap = new Map(completedCounts.map((c: any) => [c._id.toString(), c.count]));

  const totalEarnedAgg = await Transaction.aggregate([
    { $match: { userId: req.user!._id, type: 'credit', description: /^Referral bonus/, status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalEarned = totalEarnedAgg[0]?.total ?? 0;

  sendSuccess(res, 'Referral info fetched.', {
    referralCode: me?.referralCode,
    totalEarned,
    referred: referred.map(r => ({
      name: r.name,
      joinedAt: r.createdAt,
      completedOrders: completedMap.get(r._id.toString()) ?? 0,
    })),
  });
});

// Delete my own account — soft delete (see user.service.ts). Blocked if
// there's still an order actively in progress. Not available to admins.
router.delete('/me', requireRole('customer', 'worker'), async (req: Request, res: Response) => {
  await userService.deleteAccount(req.user!._id.toString(), res);
  sendSuccess(res, 'Your account has been deleted.', {});
});

export default router;
