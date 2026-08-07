import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { walletService } from '../services/wallet.service';
import { paymentService } from '../services/payment.service';
import { User } from '../models/User.model';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';

const router = Router();
router.use(authenticate, requireRole('worker', 'customer'));

router.get('/', async (req: Request, res: Response) => {
  await paymentService.reconcileStaleWalletRecharges(req.user!._id.toString());
  const wallet = await walletService.getBalance(req.user!._id.toString());
  sendSuccess(res, 'Wallet fetched.', wallet);
});

router.get('/transactions', async (req: Request, res: Response) => {
  await paymentService.reconcileStaleWalletRecharges(req.user!._id.toString());
  const txns = await walletService.getTransactions(req.user!._id.toString());
  sendSuccess(res, 'Transactions fetched.', txns);
});

// ── Add Funds (customer only) ──────────────────────────────────────────
const MIN_RECHARGE_AMOUNT = 1;

router.post('/recharge', requireRole('customer'), async (req: Request, res: Response) => {
  const amount = Number(req.body?.amount);
  if (!amount || Number.isNaN(amount) || amount < MIN_RECHARGE_AMOUNT) {
    sendError(res, `Minimum recharge amount is ₹${MIN_RECHARGE_AMOUNT}.`, 400);
    return;
  }
  // Cap to 2 decimal places — same rounding used for order amounts.
  const roundedAmount = Math.round(amount * 100) / 100;

  // Clean up any of this customer's own abandoned recharge attempts before
  // starting a new one, so old dropped checkouts never keep piling up as
  // permanent "pending" clutter in their transaction history.
  await paymentService.reconcileStaleWalletRecharges(req.user!._id.toString());

  const user = await User.findById(req.user!._id);
  const phone = req.body?.phone?.trim() || user?.phone;
  if (!phone) {
    sendError(res, 'A phone number is required to recharge your wallet. Please add one.', 400);
    return;
  }

  const txn = await walletService.initiateRecharge(req.user!._id.toString(), roundedAmount);

  try {
    const { paymentSessionId, cashfreeOrderId } = await paymentService.createWalletRechargeOrder(
      txn._id.toString(),
      roundedAmount,
      req.user!._id.toString(),
      user!.email,
      phone
    );
    await walletService.attachCashfreeOrderId(txn._id.toString(), cashfreeOrderId);
    sendSuccess(res, 'Recharge initiated.', { paymentSessionId, transactionId: txn._id.toString() }, 201);
  } catch (err) {
    // Cashfree order creation failed — don't leave the transaction stuck
    // in limbo forever; mark it failed so the customer can simply retry.
    await walletService.markRechargeInitiationFailed(txn._id.toString());
    throw err;
  }
});

export default router;
