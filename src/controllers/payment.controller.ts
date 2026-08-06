import { Request, Response } from 'express';
import { paymentService } from '../services/payment.service';
import { walletService } from '../services/wallet.service';
import { Order } from '../models/Order.model';
import { sendSuccess, sendError } from '../utils/response';

/**
 * Cashfree webhook handler.
 *
 * IMPORTANT: this route is mounted in app.ts with `express.raw()` BEFORE
 * the global `express.json()` parser — so `req.body` here is a raw Buffer,
 * not a parsed object. This is required because Cashfree signs the exact
 * raw bytes of the request; re-serializing a parsed-then-stringified body
 * can produce different bytes (whitespace, key order) and break verification.
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  const rawBody   = (req.body as Buffer).toString('utf8');
  const signature = req.headers['x-webhook-signature'] as string | undefined;
  const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;

  if (!signature || !timestamp) {
    res.status(400).json({ success: false, message: 'Missing webhook signature headers.' });
    return;
  }

  const isValid = paymentService.verifyWebhookSignature(rawBody, timestamp, signature);
  if (!isValid) {
    console.warn('[Webhook] Signature verification failed — request rejected.');
    res.status(401).json({ success: false, message: 'Invalid signature.' });
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
    return;
  }

  const orderId       = payload?.data?.order?.order_id;
  const paymentStatus = payload?.data?.payment?.payment_status;

  if (!orderId) {
    // Nothing we can act on — acknowledge so Cashfree doesn't retry forever
    res.status(200).json({ success: true, message: 'No order_id present — ignored.' });
    return;
  }

  try {
    // Wallet recharges use a `WALLET-<transactionId>` order_id — route them
    // to the wallet service instead of the regular order-payment flow.
    const isWalletRecharge = typeof orderId === 'string' && orderId.startsWith('WALLET-');

    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK' && paymentStatus === 'SUCCESS') {
      if (isWalletRecharge) {
        await walletService.confirmRechargeSuccess(orderId);
      } else {
        await paymentService.confirmPaymentSuccess(orderId);
      }
    } else if (
      paymentStatus === 'FAILED' ||
      payload.type === 'PAYMENT_FAILED_WEBHOOK' ||
      payload.type === 'PAYMENT_USER_DROPPED_WEBHOOK'
    ) {
      if (isWalletRecharge) {
        await walletService.markRechargeFailed(orderId);
      } else {
        await paymentService.markPaymentFailed(orderId);
      }
    }
    // Any other webhook type (e.g. refund webhooks we don't use) is silently ignored.
  } catch (err) {
    console.error('[Webhook] Processing error:', err);
    // Still acknowledge with 200 below — we've logged it for manual review.
    // Returning an error status here would make Cashfree retry indefinitely
    // even though we already understood the event.
  }

  res.status(200).json({ success: true });
};

/**
 * Called by the frontend immediately after the customer is redirected back
 * from Cashfree's checkout (return_url). Double-checks payment status
 * directly with Cashfree as a fast fallback in case the webhook is delayed.
 * Safe to call repeatedly — confirmPaymentSuccess/markPaymentFailed are
 * both idempotent.
 */
export const verifyPayment = async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;

  const order = await Order.findOne({ _id: orderId, customerId: req.user!._id });
  if (!order) { sendError(res, 'Order not found.', 404); return; }

  if (order.status !== 'payment_pending') {
    // Webhook (or an earlier verify call) already resolved this order
    sendSuccess(res, 'Order already processed.', { status: order.status });
    return;
  }

  if (!order.cashfreeOrderId) {
    sendError(res, 'Payment was never initiated for this order.', 400);
    return;
  }

  const cfStatus = await paymentService.getCashfreeOrderStatus(order.cashfreeOrderId);

  if (cfStatus === 'PAID') {
    await paymentService.confirmPaymentSuccess(orderId);
  } else if (cfStatus === 'EXPIRED' || cfStatus === 'TERMINATED') {
    await paymentService.markPaymentFailed(orderId);
  }
  // If still 'ACTIVE', the customer likely hasn't completed payment yet —
  // leave the order as payment_pending; frontend can show a "still waiting" state.

  const updated = await Order.findById(orderId);
  sendSuccess(res, 'Payment status checked.', { status: updated!.status });
};

/**
 * Same idea as verifyPayment above, but for wallet recharges — called by
 * the frontend right after the customer is redirected back from Cashfree
 * to /customer/wallet?payment=return&txn=<transactionId>.
 */
export const verifyWalletRecharge = async (req: Request, res: Response): Promise<void> => {
  const { transactionId } = req.params;

  const txn = await walletService.getRechargeTransaction(transactionId, req.user!._id.toString());
  if (!txn) { sendError(res, 'Recharge not found.', 404); return; }

  if (txn.status !== 'pending') {
    // Webhook (or an earlier verify call) already resolved this
    sendSuccess(res, 'Recharge already processed.', { status: txn.status });
    return;
  }

  if (!txn.cashfreeOrderId) {
    sendError(res, 'Payment was never initiated for this recharge.', 400);
    return;
  }

  const cfStatus = await paymentService.getCashfreeOrderStatus(txn.cashfreeOrderId);

  if (cfStatus === 'PAID') {
    await walletService.confirmRechargeSuccess(txn.cashfreeOrderId);
  } else if (cfStatus === 'EXPIRED' || cfStatus === 'TERMINATED') {
    await walletService.markRechargeFailed(txn.cashfreeOrderId);
  }
  // If still 'ACTIVE', leave as pending — frontend can show a "still waiting" state.

  const updatedTxn = await walletService.getRechargeTransaction(transactionId, req.user!._id.toString());
  sendSuccess(res, 'Recharge status checked.', { status: updatedTxn!.status });
};
