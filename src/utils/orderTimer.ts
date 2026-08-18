/**
 * In-process timer map for the 10-minute credential submission window.
 * When a worker accepts an order, we start a timer. If it expires before
 * credentials are submitted, the order is returned to the marketplace.
 *
 * Note: On Render free tier, the server sleeps — timers are lost on restart.
 * A production upgrade would use a persistent job queue (Bull/Redis).
 * For now, autoComplete.ts also runs a DB-level cleanup as a safety net —
 * see cleanupExpiredAcceptedOrders() there, which calls the same
 * handleOrderTimerExpiry() exported below.
 */

import { Order } from '../models/Order.model';
import { Types } from 'mongoose';
import { notificationService } from '../services/notification.service';
import { userService } from '../services/user.service';
import { walletService } from '../services/wallet.service';
import { orderHistoryService } from '../services/orderHistory.service';
import { checkEmailExists } from './emailVerification';
import { emitToMarketplace, EVENTS } from '../socket/events';

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Shared by both the in-process setTimeout below AND autoComplete.ts's
 * DB-level safety net — the single place an "accepted but never delivered"
 * order gets resolved.
 *
 * Also where the suspected-theft check lives: if this was a CUSTOM-email
 * order and that exact address now exists, this is strong evidence the
 * worker created it for themselves and just sat on the order rather than
 * ever intending to deliver it — see utils/emailVerification.ts and
 * user.service.ts applyTheftPenalty().
 *
 * Normal (non-theft) expiry: order goes back to 'pending' in the
 * marketplace for another worker to pick up — the requested address is
 * still genuinely available, so someone else can still fulfil it.
 *
 * CONFIRMED THEFT: the requested address is no longer available to
 * ANYONE — the thief already created it. Re-listing the order would just
 * strand it forever (no future worker could ever complete it), so instead
 * the order is auto-cancelled and the customer is refunded to their
 * wallet immediately, same as a normal cancellation.
 */
export const handleOrderTimerExpiry = async (
  orderId: string,
  workerId: string,
  customerId: string
): Promise<void> => {
  // Only proceed if still in 'accepted' state (worker hasn't submitted yet)
  const order = await Order.findOne({ _id: orderId, status: 'accepted', workerId });
  if (!order) return; // Already progressed past accepted — do nothing

  let theftConfirmed = false;
  if (order.emailType === 'custom' && order.requestedEmail) {
    try {
      const result = await checkEmailExists(order.requestedEmail);
      if (result === 'valid') {
        theftConfirmed = true;
        await userService.applyTheftPenalty(workerId, order._id.toString(), order.requestedEmail, 'email_never_submitted');
      }
    } catch (err) {
      // Never let a verification-check failure block the order from being
      // resolved — the customer still needs an outcome either way.
      console.error('[OrderTimer] Theft check failed:', err);
    }
  }

  const orderRef = order._id.toString().slice(-6).toUpperCase();

  if (theftConfirmed) {
    // Terminal state — this order can never be fulfilled by anyone else,
    // so it does NOT go back to the marketplace.
    order.status         = 'cancelled';
    order.workerId       = undefined;
    order.acceptedAt      = undefined;
    order.timerExpiresAt = undefined;
    await order.save();

    await walletService.creditRefund(
      customerId, order.amount, order._id,
      `Refund: Order #${orderRef} (requested email was taken by the worker who accepted it — order cancelled)`
    );

    await notificationService.create({
      userId:  customerId,
      title:   'We\'re sorry — your order was cancelled and refunded',
      message: `The worker who accepted your order created ${order.requestedEmail} for themselves instead ` +
        `of delivering it to you. Their account and network have been permanently banned. Since that email ` +
        `is no longer available to anyone, we've cancelled the order and credited ₹${order.amount} to your ` +
        `Mailzeon wallet.`,
      type:    'order',
      orderId: order._id,
    });

    await orderHistoryService.log(orderId, 'theft_confirmed', {
      actorId: workerId, actorRole: 'worker',
      message: `Confirmed theft: requested address ${order.requestedEmail} existed after the 10-minute timer expired with no credentials submitted. Worker permanently banned (account + IP + device).`,
    });
    await orderHistoryService.log(orderId, 'cancelled', {
      actorRole: 'system',
      message: `Order cancelled — the requested email is now permanently unavailable to anyone else, so it cannot be reassigned.`,
    });
    await orderHistoryService.log(orderId, 'refunded', {
      actorRole: 'system',
      message: `₹${order.amount} refunded to customer's Mailzeon wallet.`,
    });

    return;
  }

  order.status         = 'pending';
  order.workerId       = undefined;
  order.acceptedAt      = undefined;
  order.timerExpiresAt = undefined;
  // See the field comment on Order.model.ts — kept even after workerId is
  // cleared, so a later accept-time recheck (see order.service.ts
  // acceptOrder()) can still correctly attribute blame if this turns out
  // to have actually been theft that this expiry-check's API call missed
  // (e.g. a transient Abstract API failure that fail-opened to 'unknown').
  order.lastAbandonedWorkerId = new Types.ObjectId(workerId);
  await order.save();

  // Re-broadcast to marketplace so other workers can see it
  emitToMarketplace(EVENTS.NEW_ORDER, {
    orderId:   order._id,
    serviceName: order.serviceName,
    amount:    order.amount,
    workerEarning: order.workerEarning,
    createdAt: order.createdAt,
  });

  await notificationService.create({
    userId:  workerId,
    title:   '⚠️ Order Timer Expired',
    message: 'You did not submit credentials within 10 minutes. The order has been returned to the marketplace.',
    type:    'order',
    orderId: order._id,
  });

  await notificationService.create({
    userId:  customerId,
    title:   'Worker Reassigned',
    message: 'The previous worker did not complete your order in time. It is now available for another worker.',
    type:    'order',
    orderId: order._id,
  });

  await orderHistoryService.log(orderId, 'expired_returned', {
    actorId: workerId, actorRole: 'worker',
    message: `10-minute timer expired with no credentials submitted. Requested address not found to exist at this time — order returned to the marketplace for another worker.`,
  });
};

export const startOrderTimer = (
  orderId: string,
  workerId: string,
  customerId: string,
  minutes: number
): void => {
  clearOrderTimer(orderId); // Safety: clear any existing timer for this order

  const timeout = setTimeout(async () => {
    timers.delete(orderId);
    try {
      await handleOrderTimerExpiry(orderId, workerId, customerId);
    } catch (err) {
      console.error('[OrderTimer] Error on expiry:', err);
    }
  }, minutes * 60 * 1000);

  timers.set(orderId, timeout);
};

export const clearOrderTimer = (orderId: string): void => {
  const existing = timers.get(orderId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(orderId);
  }
};
