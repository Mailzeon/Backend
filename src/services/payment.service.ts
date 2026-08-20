import crypto from 'crypto';
import { env, PRIMARY_FRONTEND_URL } from '../config/env';
import { CASHFREE_BASE_URL, cashfreeHeaders } from '../config/cashfree';
import { Order } from '../models/Order.model';
import { Transaction } from '../models/Transaction.model';
import { notificationService } from './notification.service';
import { walletService } from './wallet.service';
import { orderHistoryService } from './orderHistory.service';
import { emitToMarketplace, EVENTS } from '../socket/events';
import { sendPushToAllWorkers } from '../utils/webPush';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

interface CreateCashfreeOrderResult {
  paymentSessionId: string;
  cashfreeOrderId: string;
}

// FIX: Node's built-in `fetch` types `.json()` as `Promise<unknown>` (no DOM
// lib in this project's tsconfig), so TypeScript blocks property access on
// the result. These interfaces describe just the fields we actually read
// from Cashfree's responses, and every `.json()` call below is cast to one
// of them instead of leaving it as `unknown`.
interface CashfreeCreateOrderResponse {
  payment_session_id?: string;
  order_id?: string;
  message?: string;
}

interface CashfreeGetOrderResponse {
  order_status?: string;
  message?: string;
}

export const paymentService = {
  // ── Create the corresponding order on Cashfree ────────────────────────────
  // Called right after our own Order document is created (status:
  // 'payment_pending'). Returns the payment_session_id the frontend needs
  // to open Cashfree's hosted checkout (Cashfree's own UI handles showing
  // UPI/Cards/Netbanking/Wallets — nothing extra needed on our side for that).
  async createCashfreeOrder(
    orderId: string,
    amount: number,
    customerId: string,
    customerEmail: string,
    customerPhone: string
  ): Promise<CreateCashfreeOrderResult> {
    const returnUrl = `${PRIMARY_FRONTEND_URL}/customer/orders/${orderId}?payment=return`;
    const notifyUrl = `${env.BACKEND_URL}/api/payments/webhook`;

    const res = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: cashfreeHeaders(),
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: customerId,
          customer_email: customerEmail,
          customer_phone: customerPhone,
        },
        order_meta: {
          return_url: returnUrl,
          notify_url: notifyUrl,
        },
      }),
    });

    const data = (await res.json()) as CashfreeCreateOrderResponse;

    if (!res.ok) {
      console.error('[Cashfree] Create order failed:', JSON.stringify(data));
      throwErr(data?.message || 'Failed to initiate payment. Please try again.', 502);
    }

    if (!data.payment_session_id) {
      console.error('[Cashfree] No payment_session_id in response:', JSON.stringify(data));
      throwErr('Payment gateway did not return a valid session. Please try again.', 502);
    }

    return {
      paymentSessionId: data.payment_session_id,
      cashfreeOrderId: data.order_id ?? orderId,
    };
  },

  // ── Create a Cashfree order for a WALLET RECHARGE ──────────────────────
  // Same idea as createCashfreeOrder above, but for topping up the wallet
  // instead of paying for an order — kept as a separate function (rather
  // than branching the one above) so the existing, working order-payment
  // path is never touched. Uses `WALLET-<transactionId>` as the Cashfree
  // order_id so the webhook can tell recharges apart from regular orders.
  async createWalletRechargeOrder(
    transactionId: string,
    amount: number,
    userId: string,
    userEmail: string,
    userPhone: string
  ): Promise<CreateCashfreeOrderResult> {
    const cashfreeOrderId = `WALLET-${transactionId}`;
    const returnUrl = `${PRIMARY_FRONTEND_URL}/customer/wallet?payment=return&txn=${transactionId}`;
    const notifyUrl = `${env.BACKEND_URL}/api/payments/webhook`;

    const res = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: cashfreeHeaders(),
      body: JSON.stringify({
        order_id: cashfreeOrderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: userId,
          customer_email: userEmail,
          customer_phone: userPhone,
        },
        order_meta: {
          return_url: returnUrl,
          notify_url: notifyUrl,
        },
      }),
    });

    const data = (await res.json()) as CashfreeCreateOrderResponse;

    if (!res.ok) {
      console.error('[Cashfree] Create wallet recharge order failed:', JSON.stringify(data));
      throwErr(data?.message || 'Failed to initiate payment. Please try again.', 502);
    }

    if (!data.payment_session_id) {
      console.error('[Cashfree] No payment_session_id in wallet recharge response:', JSON.stringify(data));
      throwErr('Payment gateway did not return a valid session. Please try again.', 502);
    }

    return {
      paymentSessionId: data.payment_session_id,
      cashfreeOrderId: data.order_id ?? cashfreeOrderId,
    };
  },

  // ── Reconcile stale "pending" wallet recharges ─────────────────────────
  // Safety net for the case where the customer backs out of Cashfree
  // checkout without paying: Cashfree's "user dropped" webhook is not
  // guaranteed to arrive quickly (sometimes minutes later, occasionally not
  // at all), which previously left the transaction stuck showing "pending"
  // forever until that webhook eventually landed. Instead of depending on
  // it, we lazily re-check any of the user's own pending recharges that are
  // older than STALE_AFTER_MS every time they load their wallet.
  //
  // The 5-minute buffer matters: querying Cashfree's Orders API directly
  // (not our own webhook) reflects the TRUE current state, so if a payment
  // actually succeeded a few seconds after redirect (processing lag), it
  // will already show PAID well within 5 minutes — this buffer exists only
  // to avoid ever mistakenly failing a payment that's still genuinely in
  // flight, not to wait out the webhook.
  async reconcileStaleWalletRecharges(userId: string): Promise<void> {
    const STALE_AFTER_MS = 5 * 60 * 1000;
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);

    const stale = await Transaction.find({
      userId,
      type: 'recharge',
      status: 'pending',
      createdAt: { $lt: cutoff },
      cashfreeOrderId: { $exists: true, $ne: null },
    });

    for (const txn of stale) {
      try {
        const cfStatus = await paymentService.getCashfreeOrderStatus(txn.cashfreeOrderId!);
        if (cfStatus === 'PAID') {
          await walletService.confirmRechargeSuccess(txn.cashfreeOrderId!);
        } else {
          // Still ACTIVE-but-old, EXPIRED, or TERMINATED — all mean this
          // particular attempt is dead. The customer can simply retry.
          await walletService.markRechargeFailed(txn.cashfreeOrderId!);
        }
      } catch (err) {
        // Don't let one bad Cashfree lookup block reconciling the rest, or
        // block the request (wallet page load) that triggered this.
        console.error('[Wallet Reconcile] Failed to check recharge', txn._id.toString(), err);
      }
    }
  },

  // ── Verify webhook signature (HMAC-SHA256, base64) ────────────────────────
  // Cashfree signs: base64(HMAC-SHA256(secretKey, timestamp + rawBody))
  // sent as the `x-webhook-signature` header, alongside `x-webhook-timestamp`.
  // Uses a constant-time comparison to avoid timing-attack leakage.
  verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean {
    const expected = crypto
      .createHmac('sha256', env.CASHFREE_SECRET_KEY)
      .update(timestamp + rawBody)
      .digest('base64');

    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false; // Different lengths etc. — definitely not a match
    }
  },

  // ── Fallback: ask Cashfree directly for an order's current status ─────────
  // Used when the customer is redirected back before the webhook has
  // necessarily arrived — gives a fast, authoritative answer either way.
  async getCashfreeOrderStatus(cashfreeOrderId: string): Promise<string> {
    const res = await fetch(`${CASHFREE_BASE_URL}/orders/${cashfreeOrderId}`, {
      method: 'GET',
      headers: cashfreeHeaders(),
    });
    const data = (await res.json()) as CashfreeGetOrderResponse;

    if (!res.ok) {
      console.error('[Cashfree] Get order status failed:', JSON.stringify(data));
      throwErr('Could not verify payment status right now. Please try again shortly.', 502);
    }

    return data.order_status ?? 'ACTIVE'; // 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED'
  },

  // ── Idempotent success transition ─────────────────────────────────────────
  // Only acts if the order is still 'payment_pending' — safe to call
  // multiple times (webhook retries, webhook + verify-on-return both firing).
  async confirmPaymentSuccess(orderId: string): Promise<void> {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'payment_pending' },
      { status: 'pending', paymentStatus: 'success' },
      { new: true }
    );

    if (!order) return; // Already processed or not in the expected state — no-op

    const orderRef = order._id.toString().slice(-6).toUpperCase();
    await orderHistoryService.log(order._id.toString(), 'payment_confirmed', {
      actorRole: 'system',
      message: order.walletAmountApplied > 0
        ? `Payment confirmed — ₹${order.walletAmountApplied} wallet credit + ₹${Math.round((order.amount - order.walletAmountApplied) * 100) / 100} via Cashfree. Order #${orderRef} is now live in the marketplace.`
        : `Payment confirmed via Cashfree — ₹${order.amount}. Order #${orderRef} is now live in the marketplace.`,
    });

    // Order is now marketplace-visible — broadcast to online workers
    emitToMarketplace(EVENTS.NEW_ORDER, {
      _id:            order._id,
      serviceName:    order.serviceName,
      amount:         order.amount,
      workerEarning:  order.workerEarning,
      requestedEmail: order.requestedEmail,
      createdAt:      order.createdAt,
    });

    // NEW: also push-notify every subscribed worker directly — the socket
    // broadcast above only reaches workers who currently have the site open
    // in a tab. This is what actually reaches a worker's phone/browser when
    // they're not sitting on the site (the whole point of this feature).
    sendPushToAllWorkers({
      title:   '🆕 New order available!',
      message: `${order.serviceName} — ₹${order.workerEarning} to earn. Tap to view.`,
      orderId: order._id.toString(),
      url:     '/worker/marketplace',
    }).catch(err => console.error('[Payment] Worker push broadcast failed:', err));

    const cashfreeCharged = Math.round((order.amount - order.walletAmountApplied) * 100) / 100;
    let paymentMessage: string;
    if (order.walletAmountApplied > 0 && cashfreeCharged === 0) {
      paymentMessage = `Paid entirely with ₹${order.walletAmountApplied} wallet credit — no additional payment needed. Your order is now live in the marketplace.`;
    } else if (order.walletAmountApplied > 0) {
      paymentMessage = `₹${order.walletAmountApplied} wallet credit + ₹${cashfreeCharged} payment received. Your order is now live in the marketplace.`;
    } else {
      paymentMessage = `Your payment of ₹${order.amount} was successful. Your order is now live in the marketplace.`;
    }

    await notificationService.create({
      userId:  order.customerId,
      title:   '✅ Payment Successful!',
      message: paymentMessage,
      type:    'order',
      orderId: order._id,
    });
  },

  // ── Idempotent failure transition ─────────────────────────────────────────
  async markPaymentFailed(orderId: string): Promise<void> {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'payment_pending' },
      { status: 'payment_failed', paymentStatus: 'failed' },
      { new: true }
    );

    if (!order) return; // Already processed — no-op

    const orderRef = order._id.toString().slice(-6).toUpperCase();
    await orderHistoryService.log(order._id.toString(), 'payment_failed', {
      actorRole: 'system',
      message: `Payment failed or checkout abandoned for Order #${orderRef}.` +
        (order.walletAmountApplied > 0 ? ` ₹${order.walletAmountApplied} wallet portion refunded.` : ''),
    });

    // NEW: if part of this order's payment was covered by wallet credit
    // (see order.service.ts createOrder — partial wallet + Cashfree split),
    // and the Cashfree portion for the REMAINDER failed, refund that
    // wallet portion back — otherwise the customer would lose real credit
    // for an order that never actually went through.
    if (order.walletAmountApplied > 0) {
      const orderRef = order._id.toString().slice(-6).toUpperCase();
      await walletService.creditRefund(
        order.customerId.toString(), order.walletAmountApplied, order._id,
        `Refund: Order #${orderRef} payment failed — wallet portion returned`
      );
    }

    await notificationService.create({
      userId:  order.customerId,
      title:   'Payment Failed',
      message: `Your payment for "${order.serviceName}" did not go through. You can place a new order to try again.`,
      type:    'order',
      orderId: order._id,
    });
  },
};
