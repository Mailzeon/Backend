import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { Rating } from '../models/Rating.model';
import { Order } from '../models/Order.model';
import { workerLevelService } from '../services/workerLevel.service';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

router.post('/', requireRole('customer'), async (req: Request, res: Response) => {
  const { orderId, rating } = req.body;
  if (!orderId || !rating || ![1,2,3,4,5].includes(Number(rating))) {
    sendError(res, 'Valid orderId and rating (1-5) required.', 400); return;
  }
  const order = await Order.findOne({ _id: orderId, customerId: req.user!._id, status: 'completed' });
  if (!order || !order.workerId) { sendError(res, 'Order not found or not eligible for rating.', 404); return; }

  const existing = await Rating.findOne({ orderId });
  if (existing) { sendError(res, 'You have already rated this order.', 409); return; }

  const r = await Rating.create({ orderId, customerId: req.user!._id, workerId: order.workerId, rating: Number(rating) });
  await workerLevelService.recalculate(order.workerId.toString());
  sendSuccess(res, 'Rating submitted.', r, 201);
});

export default router;
