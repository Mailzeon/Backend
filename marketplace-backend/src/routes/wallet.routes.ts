import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { walletService } from '../services/wallet.service';
import { sendSuccess } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate, requireRole('worker'));

router.get('/', async (req: Request, res: Response) => {
  const wallet = await walletService.getBalance(req.user!._id.toString());
  sendSuccess(res, 'Wallet fetched.', wallet);
});

router.get('/transactions', async (req: Request, res: Response) => {
  const txns = await walletService.getTransactions(req.user!._id.toString());
  sendSuccess(res, 'Transactions fetched.', txns);
});

export default router;
