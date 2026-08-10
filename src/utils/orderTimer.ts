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
import { notificationService } from '../services/notification.service';
import { userService } from '../services/user.service';
import { checkEmailExists } from './emailVerification';
import { emitToMarketplace, EVENTS } from '../socket/events';

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Shared by both the in-process setTimeout below AND autoComplete.ts's
 * DB-level safety net — the single place an "accepted but never delivered"
 * order actually gets released back to the marketplace.
 *
 * Also where the suspected-theft check lives: if this was a CUSTOM-email
 * order and that exact address now exists, this is strong evidence the
 * worker created it for themselves and just sat on the order rather than
 * ever intending to deliver it — see utils/emailVerification.ts and
 * user.service.ts applyTheftPenalty().
 */
export const handleOrderTimerExpiry = async (
  orderId: string,
  workerId: string,
  customerId: string
): Promise<void> => {
  // Only proceed if still in 'accepted' state (worker hasn't submitted yet)
  const order = await Order.findOne({ _id: orderId, status: 'accepted', workerId });
  if (!order) return; // Already progressed past accepted — do nothing

  if (order.emailType === 'custom' && order.requestedEmail) {
    try {
      const result = await checkEmailExists(order.requestedEmail);
      if (result === 'valid') {
        await userService.applyTheftPenalty(workerId, order._id.toString(), order.requestedEmail);
      }
    } catch (err) {
      // Never let a verification-check failure block the order from being
      // released back to the marketplace — the customer still needs it
      // fulfilled either way.
      console.error('[OrderTimer] Theft check failed:', err);
    }
  }

  order.status         = 'pending';
  order.workerId       = undefined;
  order.acceptedAt      = undefined;
  order.timerExpiresAt = undefined;
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
