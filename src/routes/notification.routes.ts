import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { notificationService } from '../services/notification.service';
import { PushSubscription } from '../models/PushSubscription.model';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const notifs = await notificationService.getForUser(req.user!._id.toString());
  sendSuccess(res, 'Notifications fetched.', notifs);
});

// IMPORTANT: /read-all MUST be defined before /:id/read
// Otherwise Express matches 'read-all' as the :id parameter
router.patch('/read-all', async (req: Request, res: Response) => {
  await notificationService.markAllRead(req.user!._id.toString());
  sendSuccess(res, 'All notifications marked as read.');
});

router.patch('/:id/read', async (req: Request, res: Response) => {
  await notificationService.markRead(req.params.id, req.user!._id.toString());
  sendSuccess(res, 'Marked as read.');
});

// New: save a browser's Push API subscription so this user can receive
// notifications even when the site isn't open. `upsert` means re-subscribing
// from the same browser (endpoint) just refreshes the keys instead of
// erroring on the unique index.
router.post('/push-subscribe', async (req: Request, res: Response) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    sendError(res, 'Invalid push subscription payload.', 400);
    return;
  }

  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { userId: req.user!._id, endpoint, keys },
    { upsert: true, new: true }
  );
  sendSuccess(res, 'Push notifications enabled.');
});

// New: remove a subscription (user disabled notifications, or is switching
// browsers/devices). Scoped to the current user + endpoint so one user can't
// delete another's subscription.
router.post('/push-unsubscribe', async (req: Request, res: Response) => {
  const { endpoint } = req.body;
  if (endpoint) {
    await PushSubscription.deleteOne({ endpoint, userId: req.user!._id });
  }
  sendSuccess(res, 'Push notifications disabled.');
});

export default router;
