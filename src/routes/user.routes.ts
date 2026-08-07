import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { upload } from '../middleware/upload.middleware';
import { uploadProfileImage } from '../controllers/user.controller';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { sendSuccess, sendError } from '../utils/response';
import { emitToAdmins, EVENTS } from '../socket/events';

const router = Router();
router.use(authenticate);

// Toggle worker online/offline status
router.patch('/status', requireRole('worker'), async (req: Request, res: Response) => {
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') { sendError(res, 'isOnline must be boolean.', 400); return; }
  const user = await User.findByIdAndUpdate(req.user!._id, { isOnline }, { new: true });
  sendSuccess(res, `You are now ${isOnline ? 'online' : 'offline'}.`, user);

  // Push the fresh count to every admin currently viewing the dashboard —
  // querying the true count (rather than emitting +1/-1) means the admin's
  // number is always exactly correct even if events arrive out of order or
  // an admin's dashboard was already open before this toggle happened.
  const onlineWorkers = await User.countDocuments({ role: 'worker', isOnline: true });
  emitToAdmins(EVENTS.WORKER_ONLINE_COUNT_CHANGED, { onlineWorkers });
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

export default router;
