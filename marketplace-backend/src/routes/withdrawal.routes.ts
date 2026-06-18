import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { withdrawalService } from '../services/withdrawal.service';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate);

// Worker: create withdrawal request
router.post('/', requireRole('worker'), async (req: Request, res: Response) => {
  const { amount, paymentMethod, upiId, bankDetails } = req.body;
  if (!amount || !paymentMethod) { sendError(res, 'Amount and payment method required.', 400); return; }
  const wr = await withdrawalService.create(req.user!._id.toString(), { amount: Number(amount), paymentMethod, upiId, bankDetails });
  sendSuccess(res, 'Withdrawal request submitted. Will be processed within 24 hours.', wr, 201);
});

// Worker: my requests
router.get('/my', requireRole('worker'), async (req: Request, res: Response) => {
  const reqs = await withdrawalService.getMyRequests(req.user!._id.toString());
  sendSuccess(res, 'Withdrawal requests fetched.', reqs);
});

export default router;
