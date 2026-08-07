import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { upload } from '../middleware/upload.middleware';
import { uploadProfileImage } from '../controllers/user.controller';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { sendSuccess, sendError } from '../utils/response';
import { pushLiveWorkerCount } from '../socket/socket';
import { userService } from '../services/user.service';

const router = Router();
router.use(authenticate);

// Toggle worker online/offline status
router.patch('/status', requireRole('worker'), async (req: Request, res: Response) => {
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') { sendError(res, 'isOnline must be boolean.', 400); return; }
  const user = await User.findByIdAndUpdate(req.user!._id, { isOnline }, { new: true });
  sendSuccess(res, `You are now ${isOnline ? 'online' : 'offline'}.`, user);

  // Push the fresh LIVE count (preference + actually connected right now)
  // to every admin currently viewing the dashboard.
  await pushLiveWorkerCount();
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

// Delete my own account — soft delete (see user.service.ts). Blocked if
// there's still an order actively in progress. Not available to admins.
router.delete('/me', requireRole('customer', 'worker'), async (req: Request, res: Response) => {
  await userService.deleteAccount(req.user!._id.toString(), res);
  sendSuccess(res, 'Your account has been deleted.', {});
});

export default router;
