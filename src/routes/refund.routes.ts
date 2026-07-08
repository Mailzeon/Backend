import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import { createRefundSchema } from '../validators/refund.validator';
import { refundService } from '../services/refund.service';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate, requireRole('customer'));

router.post('/', validate(createRefundSchema), async (req: Request, res: Response) => {
  const { orderId, upiId } = req.body;
  const refund = await refundService.create(orderId, req.user!._id.toString(), upiId);
  sendSuccess(res, 'Refund request submitted. Admin will process it shortly.', refund, 201);
});

router.get('/my', async (req: Request, res: Response) => {
  const refunds = await refundService.getMyRefunds(req.user!._id.toString());
  sendSuccess(res, 'Refund requests fetched.', refunds);
});

export default router;
