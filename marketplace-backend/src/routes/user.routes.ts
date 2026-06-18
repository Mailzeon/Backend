import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();
router.use(authenticate);

// Toggle worker online/offline status
router.patch('/status', requireRole('worker'), async (req: Request, res: Response) => {
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') { sendError(res, 'isOnline must be boolean.', 400); return; }
  const user = await User.findByIdAndUpdate(req.user!._id, { isOnline }, { new: true });
  sendSuccess(res, `You are now ${isOnline ? 'online' : 'offline'}.`, user);
});

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

export default router;
