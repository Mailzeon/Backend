import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { notificationService } from '../services/notification.service';
import { sendSuccess } from '../utils/response';
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

export default router;
