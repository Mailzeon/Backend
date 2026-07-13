import crypto from 'crypto';
import { env } from '../config/env';
import { CASHFREE_BASE_URL, cashfreeHeaders } from '../config/cashfree';
import { Order } from '../models/Order.model';
import { notificationService } from './notification.service';
import { emitToMarketplace, EVENTS } from '../socket/events';

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
    const returnUrl = `${env.FRONTEND_URL}/customer/orders/${orderId}?payment=return`;
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

    // Order is now marketplace-visible — broadcast to online workers
    emitToMarketplace(EVENTS.NEW_ORDER, {
      _id:            order._id,
      serviceName:    order.serviceName,
      amount:         order.amount,
      workerEarning:  order.workerEarning,
      requestedEmail: order.requestedEmail,
      createdAt:      order.createdAt,
    });

    await notificationService.create({
      userId:  order.customerId,
      title:   '✅ Payment Successful!',
      message: `Your payment of ₹${order.amount} was successful. Your order is now live in the marketplace.`,
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

    await notificationService.create({
      userId:  order.customerId,
      title:   'Payment Failed',
      message: `Your payment for "${order.serviceName}" did not go through. You can place a new order to try again.`,
      type:    'order',
      orderId: order._id,
    });
  },
};
