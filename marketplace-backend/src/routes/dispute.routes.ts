import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { disputeService } from '../services/dispute.service';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

router.post('/', requireRole('customer'), async (req: Request, res: Response) => {
  const { orderId, reason, description } = req.body;
  if (!orderId || !reason) { sendError(res, 'Order ID and reason are required.', 400); return; }
  const d = await disputeService.create(orderId, req.user!._id.toString(), reason, description);
  sendSuccess(res, 'Dispute created.', d, 201);
});

router.get('/my', requireRole('customer'), async (req: Request, res: Response) => {
  const disputes = await disputeService.getMyDisputes(req.user!._id.toString());
  sendSuccess(res, 'Disputes fetched.', disputes);
});

export default router;
